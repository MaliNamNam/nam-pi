import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { threadId, type MessagePort } from "node:worker_threads";
import { createAgentSession, createCodemodeExtension, createMcpExtension, createToolSearchExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { bootstrapToolAllowlist } from "./permissions.ts";
import { declinedEvent } from "./interactions.ts";
import { liveInputCommand, LIVE_PREPARE, LIVE_CANCEL, LIVE_APPLIED, LIVE_PREPARED, LIVE_FAILED, type LiveInputUpdate } from "./live-input.ts";
import { encodeProviderOptions, providerOptions } from "./provider-options.ts";
import { childSystemPrompt, type PiEvent, type RunOptions } from "./runner.ts";

type HostedOptions = Omit<RunOptions, "signal" | "onEvent" | "backgroundSignal" | "onBackendFallback" | "onStarted"> & { agentDir: string; outputPath: string };
interface HostedRun { cancelled: boolean; session?: AgentSession; accepting?: boolean; inputs?: Promise<unknown>; receipt?: { id: string; received?: boolean; ok?: boolean; error?: string }; }
type SDKThinking = NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"];

/** The only shared state is the loaded code/worker, never a conversation or policy. */
export async function serveSDKWorker(port: MessagePort): Promise<void> {
	if (!ModelRuntime?.create || !createAgentSession || !SessionManager.create) throw new Error("Pi 1.0+ SDK is required");
	const runs = new Map<string, HostedRun>();
	let shuttingDown = false;
	const closeWhenIdle = () => { if (shuttingDown && !runs.size) port.close(); };
	port.on("message", (message: { type: string; runID: string; inputID?: string; text?: string; update?: LiveInputUpdate; inputCancelState?: SharedArrayBuffer; options?: HostedOptions; cancelState?: SharedArrayBuffer }) => {
		if (message.type === "shutdown") {
			shuttingDown = true;
			for (const run of runs.values()) { run.cancelled = true; run.session?.clearQueue(); void run.session?.abort().catch(() => {}); }
			closeWhenIdle();
		} else if (message.type === "abort") {
			const run = runs.get(message.runID);
			if (run) { run.cancelled = true; run.session?.clearQueue(); void run.session?.abort().catch(() => {}); }
		} else if (message.type === "input" && message.inputID) {
			const run = runs.get(message.runID), { inputID, runID, text } = message;
			if (!run?.accepting || !run.session || run.cancelled || typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > 1024 * 1024) {
				port.postMessage({ type: "input_reply", runID, inputID, error: "This SDK child no longer accepts input" }); return;
			}
			run.inputs = (run.inputs ?? Promise.resolve()).catch(() => {}).then(async () => {
				try {
					if (!run.accepting || run.cancelled || !run.session!.isStreaming) throw new Error("SDK child settled before input admission");
					const cancelled = () => !!message.inputCancelState && Atomics.load(new Int32Array(message.inputCancelState), 0) === 1;
					if (cancelled()) throw new Error("Child input cancelled before admission");
					let prepared: ReturnType<typeof liveInputCommand> | undefined;
					if (message.update) {
						if (run.session!.steeringMode !== "one-at-a-time" || !run.session!.extensionRunner.getCommand(LIVE_PREPARE)) throw new Error("Live switching requires a supported child and one-at-a-time steering");
						prepared = liveInputCommand(run.session!.sessionManager.getSessionId(), message.update, text);
						const receipt: NonNullable<HostedRun["receipt"]> = { id: prepared.id };
						run.receipt = receipt;
						try {
							await run.session!.prompt(prepared.command, { expandPromptTemplates: true, source: "rpc" });
							if (receipt.ok !== true) throw new Error(receipt.error ?? "Child did not acknowledge configuration preparation; task was not sent");
						} finally { run.receipt = undefined; }
						if (cancelled() || !run.accepting || run.cancelled || !run.session!.isStreaming) {
							await run.session!.prompt(`/${LIVE_CANCEL} ${prepared.id}`, { expandPromptTemplates: true, source: "rpc" });
							throw new Error("Child input cancelled or settled before admission");
						}
					}
					const disposition = await run.session!.steer(prepared?.text ?? text, undefined, { source: "rpc" });
					if (prepared && disposition === "handled") await run.session!.prompt(`/${LIVE_CANCEL} ${prepared.id}`, { expandPromptTemplates: true, source: "rpc" });
					if (!run.accepting || run.cancelled || !run.session!.isStreaming) {
						run.session!.clearQueue(); throw new Error("SDK child settled during input admission; input was not delivered");
					}
					port.postMessage({ type: "input_reply", runID, inputID, disposition });
				} catch (error) { port.postMessage({ type: "input_reply", runID, inputID, error: String(error) }); }
			});
		} else if (message.type === "start" && !runs.has(message.runID) && message.options && message.cancelState) {
			if (shuttingDown) { port.postMessage({ type: "not_started", runID: message.runID, error: "SDK worker is shutting down" }); return; }
			const cancelled = new Int32Array(message.cancelState);
			const run: HostedRun = { get cancelled() { return Atomics.load(cancelled, 0) === 1; }, set cancelled(value) { if (value) Atomics.store(cancelled, 0, 1); } };
			runs.set(message.runID, run);
			void execute(message.runID, message.options, run).finally(() => { runs.delete(message.runID); closeWhenIdle(); });
		}
	});
	port.postMessage({ type: "ready" });

	async function execute(runID: string, options: HostedOptions, run: HostedRun): Promise<void> {
		let accepted = false, bound = false, file: FileHandle | undefined;
		let writes = Promise.resolve(), writeError: unknown, unsubscribe: (() => void) | undefined;
		let code = 0, failure: string | undefined;
		const write = (record: unknown) => {
			const line = JSON.stringify(record) + "\n";
			writes = writes.then(async () => { await file!.write(line); }).catch((error) => { writeError = error; run.cancelled = true; void run.session?.abort(); });
		};
		try {
			if (!options.sessionID || !/^[\w-]+$/.test(options.sessionID) || !options.sessionDir) throw new Error("SDK child needs validated session storage");
			let manager: SessionManager;
			if (options.continuing) {
				if (!options.continuationFile || path.resolve(path.dirname(options.continuationFile)) !== path.resolve(options.sessionDir) || !(await fs.stat(options.continuationFile)).isFile()) {
					throw new Error("SDK continuation requires the exact verified child file");
				}
				manager = SessionManager.open(options.continuationFile, options.sessionDir);
				if (manager.getSessionId() !== options.sessionID || path.resolve(manager.getCwd()) !== path.resolve(options.cwd)) throw new Error("SDK continuation metadata mismatch");
			} else manager = SessionManager.create(options.cwd, options.sessionDir, { id: options.sessionID });
			const savedModel = manager.buildSessionContext().model;
			const settings = SettingsManager.create(options.cwd, options.agentDir);
			settings.setProjectTrusted(options.projectTrusted === true);
			const loader = new DefaultResourceLoader({ cwd: options.cwd, agentDir: options.agentDir, settingsManager: settings,
				extensionFactories: [
					{ name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
					{ name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
					{ name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true },
				], systemPrompt: childSystemPrompt(options.agent, options.cwd) });
			await loader.reload();
			const extensions = loader.getExtensions();
			if (extensions.errors.length) throw new Error(extensions.errors.map((error) => `${error.path}: ${error.error}`).join("\n"));
			const flags = new Set(extensions.extensions.flatMap((extension) => [...extension.flags.keys()]));
			for (const flag of ["agent", "agent-permissions", "agent-forms-route", "agent-run-depth"]) {
				if (!flags.has(flag)) throw new Error(`The loaded agents extension lacks SDK support (${flag})`);
			}
			const env = options.env ?? {};
			const values = extensions.runtime.flagValues;
			values.set("agent", options.agent.id);
			values.set("agent-permissions", Buffer.from(JSON.stringify(options.agent.permissions)).toString("base64"));
			values.set("agent-options", encodeProviderOptions(providerOptions(options.agent)) ?? "");
			values.set("agent-scope", env.PI_AGENT_SCOPE ?? "user");
			values.set("agent-run-depth", env.PI_AGENT_DEPTH ?? "1");
			values.set("agent-depth", env.PI_AGENT_DEPTH_LIMIT ?? "1");
			values.set("agent-strict-shell", options.strictShell === true);
			values.set("agent-forms-route", env.PI_AGENT_FORMS ?? "");
			values.set("agent-runner", "process");
			values.set("agent-live-backend", "sdk");
			// Providers can be session-specific extension registrations: keep their
			// runtime private instead of one child unregistering another's model.
			const modelRuntime = await ModelRuntime.create({ authPath: path.join(options.agentDir, "auth.json"), modelsPath: path.join(options.agentDir, "models.json") });
			const tools = bootstrapToolAllowlist(options.agent);
			const created = await createAgentSession({ cwd: options.cwd, agentDir: options.agentDir, resourceLoader: loader,
				modelRuntime, settingsManager: settings, sessionManager: manager, tools,
				excludeTools: options.strictShell ? ["bash", "powershell"] : undefined,
				thinkingLevel: options.thinkingLevel as SDKThinking });
			run.session = created.session;
			await run.session.bindExtensions({ mode: "json", shutdownHandler: () => { run.cancelled = true; void run.session?.abort(); } });
			bound = true;
			const requested = options.model ?? (options.continuing && savedModel ? `${savedModel.provider}/${savedModel.modelId}` : options.agent.model);
			if (requested) {
				const slash = requested.indexOf("/");
				const model = modelRuntime.getModel(requested.slice(0, slash), requested.slice(slash + 1));
				if (slash < 1 || !model) throw new Error(`SDK model unavailable: ${requested}`);
				await run.session.setModel(model, { persist: false });
			}
			if (!run.session.model) throw new Error("No model is available for the SDK child");
			if (options.thinkingLevel) run.session.setThinkingLevel(options.thinkingLevel as NonNullable<SDKThinking>);
			await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
			file = await fs.open(options.outputPath, "w");
			write(manager.getHeader());
			manager.appendCustomEntry("subagent-runner", { backend: "sdk", threadID: threadId });
			unsubscribe = run.session.subscribe((event) => {
				if (event.type === "agent_start") run.accepting = !run.cancelled;
				if (event.type === "agent_settled") { run.accepting = false; return; } // only final job settlement reaches the observer
				if (declinedEvent(event)) { run.cancelled = true; run.accepting = false; run.session!.clearQueue(); }
				if (event.type === "entry_appended" && event.entry.type === "custom") {
					const data = event.entry.data as { sessionID?: string; agent?: string; id?: string; ok?: boolean; error?: string } | undefined;
					if (data?.sessionID === manager.getSessionId()) {
						if (event.entry.customType === LIVE_APPLIED && typeof data.agent === "string") port.postMessage({ type: "agent_switch", runID, agent: data.agent });
						if (event.entry.customType === LIVE_PREPARED && run.receipt && data.id === run.receipt.id) {
							if (run.receipt.received) { run.receipt.ok = false; run.receipt.error = "Ambiguous configuration preparation receipt; task was not sent"; }
							else { run.receipt.received = true; run.receipt.ok = data.ok === true; run.receipt.error = data.error; }
						}
						if (event.entry.customType === LIVE_FAILED) {
							code = 1; failure = data.error ?? "Live configuration application failed"; run.accepting = false;
							run.session!.clearQueue(); void run.session!.abort().catch(() => {});
						}
					}
				}
				if (event.type === "message_update") {
					// Match Pi JSON mode: never serialize growing partial snapshots.
					const { partial: _partial, ...delta } = event.assistantMessageEvent as unknown as Record<string, unknown>;
					write({ type: event.type, assistantMessageEvent: delta });
				} else write(event);
			});
			accepted = true;
			port.postMessage({ type: "started", runID });
			if (!run.cancelled) {
				const task = options.continuing || !options.firstMessagePrefix ? options.task : `${options.firstMessagePrefix}\n${options.task}`;
				await run.session.prompt(task, { expandPromptTemplates: false });
			}
			if (writeError) throw writeError;
		} catch (error) {
			code = 1; failure = error instanceof Error ? error.message : String(error);
			if (accepted && file) write({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: failure } } satisfies PiEvent);
		} finally {
			run.accepting = false;
			await run.inputs?.catch(() => {});
			if (run.session) {
				run.session.clearQueue();
				try { if (bound) await run.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); } catch { /* dispose regardless */ }
				unsubscribe?.(); run.session.dispose();
			}
			if (accepted && file) { write({ type: "agent_settled" }); await writes; }
			await file?.close().catch(() => {});
			port.postMessage({ type: accepted ? "done" : "not_started", runID, code: run.cancelled ? 1 : code, error: failure });
		}
	}
}
