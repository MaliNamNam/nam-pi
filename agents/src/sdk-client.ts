import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import { leafPolicy, type LiveInputUpdate } from "./live-input.ts";
import { ChildInput, type InputDisposition } from "./child-input.ts";
import type { DetachedRun, RunHandle, RunOptions } from "./runner.ts";

/** Conservative first-stage support: a last catch-all must deny all delegation. */
export function sdkEligible(options: RunOptions): boolean {
	if (options.workspace || process.env.PI_AGENT_CONFIG_CWD || process.env.PI_AGENT_SDK_WORKER === "1" || process.versions.bun || !options.sessionDir || path.resolve(options.cwd) !== path.resolve(process.cwd())) return false;
	if (!leafPolicy(options.agent.permissions)) return false;
	const supported = new Set(["PI_AGENT_ID", "PI_AGENT_DEPTH", "PI_AGENT_DEPTH_LIMIT", "PI_AGENT_FORMS", "PI_AGENT_SCOPE", "PI_AGENT_STRICT_SHELL"]);
	return Object.keys(options.env ?? {}).every((key) => supported.has(key));
}

class SDKUnavailable extends Error {}
class SDKHandle extends EventEmitter implements RunHandle {
	readonly pid = process.pid; // metadata only; kill() below NEVER signals this PID
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killed = false;
	private readonly cancel: () => void;
	private readonly input: ChildInput;
	private readonly configure: (model: string, thinkingLevel?: string) => Promise<void>;
	readonly supportsLiveUpdates = true as const;
	private currentAgent: string;
	get agent(): string { return this.currentAgent; }
	constructor(cancel: () => void, accept: (text: string, update?: LiveInputUpdate, signal?: AbortSignal) => Promise<InputDisposition>, agent: string,
		configure: (model: string, thinkingLevel?: string) => Promise<void>) {
		super(); this.cancel = cancel; this.currentAgent = agent; this.configure = configure;
		this.input = new ChildInput(accept, () => !this.killed && this.exitCode === null && this.signalCode === null);
	}
	steer(text: string, signal?: AbortSignal, update?: LiveInputUpdate): Promise<InputDisposition> { return this.input.steer(text, signal, update); }
	configureModel(model: string, thinkingLevel?: string): Promise<void> {
		if (this.killed || this.exitCode !== null || this.signalCode !== null) return Promise.reject(new Error("SDK child is no longer running"));
		return this.configure(model, thinkingLevel);
	}
	switchAgent(agent: string): void { this.currentAgent = agent; this.emit("agent_switch", agent); }
	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		if (this.exitCode !== null || this.signalCode !== null) return false;
		this.killed = true;
		this.input.close();
		this.cancel(); // even SIGKILL is scoped/cooperative, never terminate sibling sessions
		return true;
	}
	finish(code: number): void {
		if (this.exitCode !== null || this.signalCode !== null) return;
		this.input.close();
		this.exitCode = code;
		if (this.killed) this.signalCode = "SIGTERM";
		this.emit("exit", code, this.signalCode);
		this.emit("close", code, this.signalCode);
	}
}
interface Pending {
	worker: Worker;
	handle: SDKHandle;
	outputPath: string;
	key: string;
	resolve(run: DetachedRun): void;
	reject(error: Error): void;
	started: boolean;
	cleanup(): void;
	timer: ReturnType<typeof setTimeout>;
}

/** One lazy worker per owning Pi runtime; no model/session state is shared with the root. */
export class SDKWorkerClient {
	private worker?: Worker;
	private ready?: Promise<void>;
	private readonly pending = new Map<string, Pending>();
	private readonly sessions = new Set<string>();
	private readonly inputs = new Map<string, { runID: string; worker: Worker; resolve(value: InputDisposition): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; cleanup(): void }>();
	private readonly configurations = new Map<string, { runID: string; worker: Worker; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
	private diagnostics = "";
	private readonly agentDir: string;
	constructor(agentDir = getAgentDir()) { this.agentDir = agentDir; }
	get threadID(): number | undefined { return this.worker?.threadId; }
	get activeCount(): number { return this.pending.size; }

	private boot(): Promise<void> {
		if (this.ready) return this.ready;
		let sdkEntry: string;
		try {
			sdkEntry = path.join(getPackageDir(), "dist", "index.js");
		} catch { throw new SDKUnavailable("The host Pi SDK cannot be resolved"); }
		const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: this.agentDir };
		for (const key of Object.keys(env)) if (key.startsWith("PI_AGENT_")) delete env[key];
		env.PI_AGENT_SDK_WORKER = "1";
		const worker = new Worker(new URL("./sdk-worker.mjs", import.meta.url), {
			workerData: { sdkEntry }, env, stdout: true, stderr: true,
		});
		this.worker = worker;
		for (const stream of [worker.stdout, worker.stderr]) stream.on("data", (chunk) => {
			this.diagnostics = (this.diagnostics + String(chunk)).slice(-8192);
		});
		this.ready = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => { reject(new SDKUnavailable("SDK worker startup timed out")); void this.shutdown(); }, 30_000);
			worker.on("message", (message) => {
				if (message.type === "ready") { clearTimeout(timer); resolve(); return; }
				if (message.type === "boot_error") { clearTimeout(timer); reject(new SDKUnavailable(message.error)); return; }
				void this.receive(message);
			});
			worker.once("error", (error) => { clearTimeout(timer); reject(new SDKUnavailable(error instanceof Error ? error.message : String(error))); });
			worker.once("exit", (code) => {
				clearTimeout(timer);
				const error = new Error(`SDK worker exited (${code})${this.diagnostics ? ": " + this.diagnostics.trim() : ""}`);
				reject(new SDKUnavailable(error.message));
				void this.failed(error, worker);
				if (this.worker === worker) { this.worker = undefined; this.ready = undefined; }
			});
		});
		worker.unref();
		return this.ready;
	}

	async start(options: RunOptions): Promise<DetachedRun> {
		const key = path.resolve(options.sessionDir!, options.sessionID!);
		if (this.sessions.has(key)) throw new Error("This SDK child is still running or cancelling");
		this.sessions.add(key);
		try { await this.boot(); } catch (error) { this.sessions.delete(key); throw error; }
		const runID = randomUUID();
		const outputPath = path.join(options.cwd, ".pi", "agents", "jobs", `${options.sessionID}.jsonl`);
		const worker = this.worker!;
		worker.ref();
		return new Promise<DetachedRun>((resolve, reject) => {
			const cancelState = new SharedArrayBuffer(4), cancelled = new Int32Array(cancelState);
			const handle = new SDKHandle(() => { Atomics.store(cancelled, 0, 1); worker.postMessage({ type: "abort", runID }); }, (text, update, signal) => this.admit(worker, runID, text, update, signal), options.agent.id,
				(model, thinkingLevel) => this.configure(worker, runID, model, thinkingLevel));
			const cancel = () => {
				handle.kill();
				if (!this.pending.get(runID)?.started) reject(new Error("SDK initialization cancelled"));
			};
			const cleanup = () => { options.signal?.removeEventListener("abort", cancel); };
			const timer = setTimeout(() => {
				handle.kill();
				// An enqueued initialization may have started a prompt: never retry
				// it as a subprocess, and retain its session lock until cleanup.
				reject(new Error("SDK initialization timed out; the run is cancelling (no subprocess retry)"));
			}, 30_000);
			this.pending.set(runID, { worker, handle, outputPath, key, resolve, reject, started: false, cleanup, timer });
			const { signal: _signal, backgroundSignal: _background, onEvent: _event, onBackendFallback: _fallback, onStarted: _started, ...serializable } = options;
			try {
				worker.postMessage({ type: "start", runID, cancelState, options: { ...serializable, agentDir: this.agentDir, outputPath } });
				options.signal?.addEventListener("abort", cancel, { once: true });
				if (options.signal?.aborted) cancel();
			} catch (error) {
				this.pending.delete(runID); this.sessions.delete(key); cleanup(); clearTimeout(timer);
				if (!this.pending.size) worker.unref();
				reject(new SDKUnavailable(String(error)));
			}
		});
	}

	private admit(worker: Worker, runID: string, text: string, update?: LiveInputUpdate, signal?: AbortSignal): Promise<InputDisposition> {
		const run = this.pending.get(runID);
		if (run?.worker !== worker || !run.started || run.handle.killed) return Promise.reject(new Error("This SDK child no longer accepts input"));
		const inputID = randomUUID();
		return new Promise((resolve, reject) => {
			const inputCancelState = new SharedArrayBuffer(4), cancelled = new Int32Array(inputCancelState);
			const cancel = () => { Atomics.store(cancelled, 0, 1); };
			const cleanup = () => signal?.removeEventListener("abort", cancel);
			signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
			const timer = setTimeout(() => {
				this.inputs.delete(inputID); cleanup(); run.handle.kill();
				reject(new Error("SDK input acknowledgement timed out; admission is uncertain (no automatic replay)"));
			}, 30_000);
			this.inputs.set(inputID, { runID, worker, resolve, reject, timer, cleanup });
			try { worker.postMessage({ type: "input", runID, inputID, text, update, inputCancelState }); }
			catch (error) { this.inputs.delete(inputID); clearTimeout(timer); cleanup(); reject(new Error(String(error))); }
		});
	}
	private configure(worker: Worker, runID: string, model: string, thinkingLevel?: string): Promise<void> {
		const run = this.pending.get(runID);
		if (run?.worker !== worker || !run.started || run.handle.killed) return Promise.reject(new Error("SDK child is no longer running"));
		const configurationID = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.configurations.delete(configurationID);
				reject(new Error("SDK model update acknowledgement timed out (no automatic replay)"));
			}, 30_000);
			this.configurations.set(configurationID, { runID, worker, resolve, reject, timer });
			try { worker.postMessage({ type: "configure_model", runID, configurationID, model, thinkingLevel }); }
			catch (error) { this.configurations.delete(configurationID); clearTimeout(timer); reject(new Error(String(error))); }
		});
	}
	private rejectInputs(runID: string): void {
		for (const [id, request] of this.configurations) if (request.runID === runID) {
			this.configurations.delete(id); clearTimeout(request.timer);
			request.reject(new Error("SDK child ended before acknowledging its model update"));
		}
		for (const [id, input] of this.inputs) if (input.runID === runID) {
			this.inputs.delete(id); clearTimeout(input.timer); input.cleanup();
			input.reject(new Error("SDK child ended before acknowledging input; do not replay automatically"));
		}
	}
	private async receive(message: { type: string; runID: string; inputID?: string; configurationID?: string; disposition?: InputDisposition; agent?: string; code?: number; error?: string }): Promise<void> {
		if (message.type === "model_reply" && message.configurationID) {
			const request = this.configurations.get(message.configurationID);
			if (!request || request.runID !== message.runID) return;
			this.configurations.delete(message.configurationID); clearTimeout(request.timer);
			if (message.error) request.reject(new Error(message.error)); else request.resolve();
			return;
		}
		if (message.type === "input_reply" && message.inputID) {
			const input = this.inputs.get(message.inputID);
			if (!input || input.runID !== message.runID) return;
			this.inputs.delete(message.inputID); clearTimeout(input.timer); input.cleanup();
			if (message.error || !message.disposition) input.reject(new Error(message.error ?? "Uncertain SDK input acknowledgement"));
			else input.resolve(message.disposition);
			return;
		}
		const run = this.pending.get(message.runID);
		if (!run) return;
		if (message.type === "agent_switch" && run.started && typeof message.agent === "string") { run.handle.switchAgent(message.agent); return; }
		if (message.type === "started") {
			run.started = true;
			clearTimeout(run.timer);
			run.cleanup(); // awaitForeground now owns the signal; Ctrl+B can detach it
			run.resolve({ pid: run.handle.pid, child: run.handle, outputPath: run.outputPath, backend: "sdk" });
			return;
		}
		if (message.type !== "done" && message.type !== "not_started") return;
		this.rejectInputs(message.runID);
		this.pending.delete(message.runID); this.sessions.delete(run.key); run.cleanup(); clearTimeout(run.timer);
		if (!this.pending.size) this.worker?.unref();
		if (!run.started) run.reject(new SDKUnavailable(message.error ?? "SDK session initialization failed"));
		run.handle.finish(message.code ?? 1);
	}

	private async failed(error: Error, worker: Worker): Promise<void> {
		const pending = [...this.pending.entries()].filter(([, run]) => run.worker === worker);
		for (const [id, run] of pending) {
			this.rejectInputs(id);
			this.pending.delete(id);
			this.sessions.delete(run.key); run.cleanup(); clearTimeout(run.timer);
			if (!run.started) run.reject(new SDKUnavailable(error.message));
			else if (!run.handle.killed) {
				// An SDK job cannot use the root PID as a liveness fallback. Leave
				// an error/settlement marker for an adopted background completion.
				await fs.appendFile(run.outputPath, JSON.stringify({ type: "message_end", message: {
					role: "assistant", content: [], stopReason: "error", errorMessage: error.message,
				} }) + "\n" + JSON.stringify({ type: "agent_settled" }) + "\n").catch(() => {});
			}
			run.handle.finish(1);
		}
	}

	async shutdown(force = false): Promise<void> {
		const worker = this.worker;
		this.worker = undefined; this.ready = undefined;
		if (!worker) return;
		if (force) { await worker.terminate(); return; }
		// Abort/clean up tools and MCP subprocesses inside the worker BEFORE
		// terminating its thread; termination alone would orphan those tools.
		for (const run of this.pending.values()) if (run.worker === worker) run.handle.kill();
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => { void worker.terminate().then(() => resolve()); }, 7000);
			worker.once("exit", () => { clearTimeout(timer); resolve(); });
			try { worker.postMessage({ type: "shutdown" }); } catch { clearTimeout(timer); void worker.terminate().then(() => resolve()); }
		});
	}
}

let client: SDKWorkerClient | undefined;
export function stopSDKWorker(): void {
	const previous = client; client = undefined;
	void previous?.shutdown().catch(() => {});
}
export async function trySDKRun(options: RunOptions): Promise<DetachedRun | undefined> {
	if (!sdkEligible(options)) return undefined;
	client ??= new SDKWorkerClient();
	try { return await client.start(options); }
	catch (error) {
		// No fallback once a prompt has started: that would duplicate side effects.
		if (!(error instanceof SDKUnavailable)) throw error;
		options.onBackendFallback?.(error.message);
		return undefined;
	}
}
