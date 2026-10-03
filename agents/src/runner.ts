/**
 * Subagent execution.
 *
 * The default transport is an isolated `pi` subprocess. An opt-in Pi 1.0+
 * SDK transport hosts foreground leaf sessions in one worker thread, off the
 * root UI loop. Both retain independent history, models and per-call policies;
 * unsupported SDK initialization falls back before a task prompt is started.
 *
 * OpenCode concept -> Pi implementation:
 *   child session            -> `pi --session-id <id>` subprocess
 *   continue a conversation  -> `pi --session <verified child file>` on a later call
 *   background job           -> file-backed subprocess + completion notification
 *   foreground job           -> awaited subprocess, streamed progress
 *   agent.system             -> `--append-system-prompt <file>`
 *   agent permission ruleset -> `--tools <allowlist>`
 *   agent.model              -> `--model <provider/model>`
 *   agent.steps              -> enforced by the child extension (see index.ts)
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";
import { createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { awaitForeground } from "./foreground.ts";
import { JsonlReader } from "./jsonl.ts";
import { declinedEvent } from "./interactions.ts";
import { ProcessHandle } from "./process-client.ts";
import type { InputDisposition } from "./child-input.ts";
import { LIVE_APPLIED, LIVE_FAILED, type LiveInputUpdate } from "./live-input.ts";
import { stopSDKWorker, trySDKRun } from "./sdk-client.ts";
import { bootstrapToolAllowlist } from "./permissions.ts";
import { encodeProviderOptions, providerOptions } from "./provider-options.ts";
import type { AgentDefinition } from "./types.ts";

/** OpenCode's `SubagentCompletion.NO_TEXT`. */
export const NO_TEXT = "Subagent completed without a text response.";

const liveChildren = new Set<ChildProcess>();

/** Stop this Pi process's children, never a PID recovered from disk. */
export function stopChildProcesses(): void {
	stopSDKWorker();
	for (const child of liveChildren) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
	}
}

function trackChildProcess(child: ChildProcess): void {
	if (!liveChildren.size) process.on("exit", stopChildProcesses);
	liveChildren.add(child);
	child.once("close", () => {
		liveChildren.delete(child);
		if (!liveChildren.size) process.removeListener("exit", stopChildProcesses);
	});
}

export interface RunOptions {
	/** Opt-in experimental foreground leaf-session transport. */
	backend?: "process" | "sdk";
	/** Parent's explicit project-trust decision, never inferred by the worker. */
	projectTrusted?: boolean;
	onBackendFallback?: (reason: string) => void;
	agent: AgentDefinition;
	/** The task text. For a continuation this is the follow-up message. */
	task: string;
	cwd: string;
	/** Model to use. Falls back to the dispatching session's model. */
	model?: string;
	/** Remove shell tools from a child when the parent requires strict isolation. */
	strictShell?: boolean;
	/** The parent's session store; children must use the same project-scoped store. */
	sessionDir?: string;
	/** Validated exact child file to continue. An ID alone must never be resumed. */
	continuationFile?: string;
	/** Thinking level chosen for this child request. */
	thinkingLevel?: string;
	/**
	 * Session id to use. A new session is created with this id; when `continuing`
	 * is set, an existing session with this id is resumed, matching OpenCode's
	 * `sessionID` parameter.
	 */
	sessionID?: string;
	/** True when `sessionID` refers to an existing session to continue. */
	continuing?: boolean;
	/** Signal that cancels the subprocess. */
	signal?: AbortSignal;
	/** Ctrl+B releases the foreground wait without cancelling the child. */
	backgroundSignal?: AbortSignal;
	/** Live input/join capability, never persisted or recovered from a PID. */
	onStarted?: (run: DetachedRun) => void;
	/** Called with each parsed JSON event. */
	onEvent?: (event: PiEvent) => void;
	/** Prefix prepended to the task for a brand-new session. */
	firstMessagePrefix?: string;
	/** Extra environment variables for the child process. */
	env?: Record<string, string>;
}

export interface RunResult {
	sessionID: string;
	status: "completed" | "error" | "cancelled" | "running";
	/** Present only when a foreground child has been moved to the background. */
	detached?: DetachedRun;
	output: string;
	error?: string;
	exitCode: number;
	usage: Usage;
	model?: string;
	stderr: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** A JSON-mode record from the child process. */
export interface PiEvent {
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
		usage?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			totalTokens?: number;
			cost?: { total?: number };
		};
		model?: string;
		stopReason?: string;
		errorMessage?: string;
	};
	[key: string]: unknown;
}

export function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** Pi thinking levels, used to translate an OpenCode model variant. */
const PI_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** How to invoke the running pi binary. Ported from the subagent example. */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

async function writePromptFile(agentId: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-prompt-"));
	const safeName = agentId.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

/** Extract the final assistant text, matching OpenCode's `SubagentCompletion.text`. */
export function finalOutput(messages: PiEvent[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index].message;
		if (!message || message.role !== "assistant") continue;
		if (message.stopReason === "error" || message.stopReason === "aborted") continue;
		const text = textFromContent(message.content);
		if (text) return text;
	}
	return NO_TEXT;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } => {
			return (
				typeof part === "object" &&
				part !== null &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string"
			);
		})
		.map((part) => part.text)
		.join("");
}

/** Build the argument list for one child invocation. */
export function buildArgs(options: RunOptions, promptFile: string | undefined): string[] {
	const { agent } = options;
	const args: string[] = ["--mode", "json", "-p"];

	// Session handling.
	//   new session  -> `--session-id <id>` creates the session with a known id,
	//                   so a later call can continue it (OpenCode's sessionID).
	//   continuation -> `--session <verified absolute file>` resumes exactly that child.
	if (options.sessionDir) args.push("--session-dir", options.sessionDir);
	if (options.continuing) {
		if (!options.continuationFile) throw new Error("Cannot continue a subagent without a verified session file");
		args.push("--session", options.continuationFile);
	} else if (options.sessionID) {
		args.push("--session-id", options.sessionID);
	} else {
		args.push("--no-session");
	}

	// The child reads this to apply its own agent identity and permissions.
	args.push("--agent", agent.id);

	// OpenCode evaluates an agent's permission ruleset per call, not just per
	// tool: `bash: { "*": "deny", "echo *": "allow" }` blocks `rm -rf` while
	// allowing `echo`. Pi's `--tools` can only gate whole tools, so the ruleset
	// travels to the child and is enforced there by the child's own tool_call
	// handler. Encoded as base64 JSON to survive the argument list.
	if (agent.permissions.length > 0) {
		args.push("--agent-permissions", Buffer.from(JSON.stringify(agent.permissions), "utf8").toString("base64"));
	}

	// OpenCode passes an agent's sampling options through to the provider, which
	// is per-request state the child must know. Same base64 channel.
	const agentOptions = encodeProviderOptions(providerOptions(agent));
	if (agentOptions) args.push("--agent-options", agentOptions);

	// The caller resolves explicit > agent > current parent model. On a
	// continuation without an override Pi restores the child's saved model.
	// `variant` is only a fallback for the agent's own configured model.
	const model = options.model ?? (options.continuing ? undefined : agent.model);
	if (model) args.push("--model", model);
	const variant = !options.continuing && !options.model && agent.model ? agent.variant : undefined;
	if (options.thinkingLevel && PI_THINKING_LEVELS.has(options.thinkingLevel)) {
		args.push("--thinking", options.thinkingLevel);
	} else if (variant && PI_THINKING_LEVELS.has(variant)) {
		args.push("--thinking", variant);
	}

	const tools = bootstrapToolAllowlist(agent);
	if (tools && tools.length > 0) args.push("--tools", tools.join(","));
	else if (tools?.length === 0) args.push("--no-tools");
	if (options.strictShell) args.push("--exclude-tools", "bash,powershell");

	// OpenCode replaces the whole system prompt when `agent.system` is set
	// (`agent.system ? agent.system : default`), so use --system-prompt, not
	// --append-system-prompt. Tools still reach the model through --tools.
	if (promptFile) args.push("--system-prompt", promptFile);

	args.push(options.task);
	return args;
}

/**
 * The system prompt a child runs with.
 *
 * OpenCode's provider system array is `[agent.system, initial]`, so an agent
 * that replaces the prompt still keeps the session's cwd context. Pi's
 * `--system-prompt` replaces everything, so the cwd is re-added here; without
 * it the model has no anchor for the relative paths its tools return.
 *
 * Only the cwd is re-added. An earlier version also carried a `<tool-paths>`
 * instruction block; an A/B run showed identical path accuracy with and without
 * it, so it was removed rather than left in as unverified prompt weight.
 */
export function childSystemPrompt(agent: AgentDefinition, cwd: string): string {
	const parts: string[] = [];
	if (agent.systemPrompt.trim()) parts.push(agent.systemPrompt.trim());
	parts.push(`<cwd>\n${cwd.replaceAll("\\", "/")}\n</cwd>`);
	return parts.join("\n\n");
}

/**
 * Run one subagent to completion.
 *
 * A brand-new session gets OpenCode's subagent preamble; a continuation sends
 * the bare message, matching `tool/plugin/subagent.ts`.
 */
export async function runAgent(options: RunOptions): Promise<RunResult> {
	if (options.backend === "sdk") {
		const sessionID = options.sessionID ?? createSessionId(options.agent.id);
		try {
			const run = await trySDKRun({ ...options, sessionID });
			if (run) { options.onStarted?.(run); return awaitForeground(run, { ...options, sessionID }, readDetachedResult); }
		} catch (error) {
			if (options.signal?.aborted) return { sessionID, status: "cancelled", output: "", exitCode: 1, usage: emptyUsage(), stderr: "" };
			throw error;
		}
	}
	if (options.backgroundSignal) {
		const sessionID = options.sessionID ?? createSessionId(options.agent.id);
		const run = await runAgentDetached({ ...options, sessionID });
		options.onStarted?.(run);
		return awaitForeground(run, { ...options, sessionID }, readDetachedResult);
	}
	const { agent } = options;
	const sessionID = options.sessionID ?? createSessionId(agent.id);
	const continuation = options.continuing === true;

	const task =
		continuation || !options.firstMessagePrefix
			? options.task
			: [options.firstMessagePrefix, options.task].join("\n");

	let promptDir: string | undefined;
	let promptFile: string | undefined;
	// Always write a prompt file: even an agent without its own prompt needs the
	// cwd restored, because --system-prompt replaces Pi's default prompt.
	{
		const written = await writePromptFile(agent.id, childSystemPrompt(agent, options.cwd));
		promptDir = written.dir;
		promptFile = written.filePath;
	}

	const messages: PiEvent[] = [];
	const usage = emptyUsage();
	let stderr = "";
	let model: string | undefined;
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let wasAborted = false;
	let declined = false;

	try {
		const args = buildArgs({ ...options, task, sessionID }, promptFile);
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				shell: false,
				windowsHide: true, // never flash a second console over Pi's TUI
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, ...options.env },
			});
			trackChildProcess(proc);

			let buffer = "";
			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: PiEvent;
				try {
					event = JSON.parse(line) as PiEvent;
				} catch {
					return;
				}
				options.onEvent?.(event);
				if (event.type === "agent_start") declined = false;
				if (declinedEvent(event)) declined = true;
				if (event.type === "message_end" && event.message) {
					messages.push(event);
					const message = event.message;
					if (message.role === "assistant") {
						usage.turns++;
						const reported = message.usage;
						if (reported) {
							usage.input += reported.input ?? 0;
							usage.output += reported.output ?? 0;
							usage.cacheRead += reported.cacheRead ?? 0;
							usage.cacheWrite += reported.cacheWrite ?? 0;
							usage.cost += reported.cost?.total ?? 0;
							usage.contextTokens = reported.totalTokens ?? 0;
						}
						if (!model && message.model) model = message.model;
						if (message.stopReason) stopReason = message.stopReason;
						if (message.errorMessage) errorMessage = message.errorMessage;
					}
				}
			};

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data: Buffer) => {
				stderr += data.toString();
			});
			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});
			proc.on("error", (error) => {
				stderr += `\n${error.message}`;
				resolve(1);
			});

			const kill = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			if (options.signal) {
				if (options.signal.aborted) kill();
				else options.signal.addEventListener("abort", kill, { once: true });
			}
		});

		if (wasAborted || declined) {
			return { sessionID, status: "cancelled", output: "", exitCode, usage, model, stderr };
		}

		if (exitCode !== 0 || stopReason === "error") {
			const detail =
				errorMessage ??
				(stderr.trim() ? stderr.trim().split("\n").slice(-5).join("\n") : `Subagent exited with code ${exitCode}`);
			return {
				sessionID,
				status: "error",
				output: finalOutput(messages),
				error: detail,
				exitCode,
				usage,
				model,
				stderr,
			};
		}

		return {
			sessionID,
			status: "completed",
			output: finalOutput(messages),
			exitCode,
			usage,
			model,
			stderr,
		};
	} finally {
		if (promptFile) {
			try {
				await fs.unlink(promptFile);
			} catch {
				// Best effort cleanup.
			}
		}
		if (promptDir) {
			try {
				await fs.rmdir(promptDir);
			} catch {
				// Best effort cleanup.
			}
		}
	}
}

/**
 * Run a file-backed child that can leave the foreground wait, not its owning Pi.
 * Both foreground and background children stop when their parent exits.
 *
 * The completion marker is Pi's final `agent_settled` event, which is emitted
 * after all retries, compaction, and follow-up work finish.
 */
export interface RunHandle extends EventEmitter {
	readonly pid?: number;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	killed: boolean;
	kill(signal?: NodeJS.Signals): boolean;
	/** Capability/version check, not a PID or persisted session claim. */
	readonly supportsLiveUpdates?: true;
	readonly agent?: string;
	/** Per-run input admission; optional for old fixtures/non-controllable runs. */
	steer?(text: string, signal?: AbortSignal, update?: LiveInputUpdate): Promise<InputDisposition>;
}
export interface DetachedRun {
	pid: number;
	backend?: "process" | "sdk";
	/** Live per-run capability; a persisted PID alone is not safe to signal. */
	child: RunHandle;
	/** File the child writes its JSONL stream to. */
	outputPath: string;
}

export async function runAgentDetached(options: RunOptions): Promise<DetachedRun> {
	const { agent } = options;
	const sessionID = options.sessionID ?? createSessionId(agent.id);

	const task =
		options.continuing || !options.firstMessagePrefix
			? options.task
			: [options.firstMessagePrefix, options.task].join("\n");

	const promptFile = await writePromptFile(agent.id, childSystemPrompt(agent, options.cwd));
	const outputDir = path.join(options.cwd, ".pi", "agents", "jobs");
	await fs.mkdir(outputDir, { recursive: true });
	const outputPath = path.join(outputDir, `${sessionID}.jsonl`);
	// RPC keeps the original child available for live steering. Only that
	// child's stdin capability can admit input; no process opens its transcript.
	const args = buildArgs({ ...options, task, sessionID }, promptFile.filePath);
	args.splice(0, 3, "--mode", "rpc"); args.pop();
	const invocation = getPiInvocation(args);
	const log = createWriteStream(outputPath, { flags: "w", mode: 0o600 });
	const child = spawn(invocation.command, invocation.args, {
		cwd: options.cwd, shell: false, detached: false, windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...options.env },
	});
	trackChildProcess(child);
	const control = new ProcessHandle(child, log, agent.id);
	const cleanupPrompt = () => { void fs.rm(promptFile.dir, { recursive: true, force: true }).catch(() => {}); };
	control.once("close", cleanupPrompt);
	const abort = () => control.kill();
	options.signal?.addEventListener("abort", abort, { once: true });
	try {
		if (options.signal?.aborted) abort();
		await control.start(task, sessionID, options.cwd);
		child.unref();
		return { pid: child.pid!, child: control, outputPath, backend: "process" };
	} catch (error) { control.kill(); throw error; }
	finally { options.signal?.removeEventListener("abort", abort); }
}

interface DetachedOutput {
	reader: JsonlReader;
	settled: boolean;
	cancelled?: boolean;
	text: string;
	error?: string;
	usage: Usage;
	model?: string;
	agent?: string;
	failure?: string;
	sessionID?: string;
}
const detachedOutputs = new Map<string, DetachedOutput>();

/** Release cached state when a run is delivered or cancelled. */
export function forgetDetachedResult(outputPath?: string): void {
	if (outputPath === undefined) detachedOutputs.clear();
	else detachedOutputs.delete(outputPath);
}

/** Consume new records once; idle checks never reparse an entire growing log. */
export async function readDetachedResult(outputPath: string): Promise<{
	settled: boolean;
	cancelled?: boolean;
	output: string;
	error?: string;
	usage: Usage;
	model?: string;
	agent?: string;
}> {
	let state = detachedOutputs.get(outputPath);
	if (!state) {
		state = { reader: new JsonlReader(outputPath), settled: false, text: "", usage: emptyUsage() };
		detachedOutputs.set(outputPath, state);
	}
	const current = state;
	await current.reader.read((record) => {
		const event = record as PiEvent;
		if (event.type === "session" && typeof event.id === "string") current.sessionID = event.id;
		if (event.type === "agent_start") { current.settled = false; current.cancelled = undefined; current.failure = undefined; }
		if (declinedEvent(event)) current.cancelled = true;
		if (event.type === "agent_settled") current.settled = true;
		if (event.type === "entry_appended") {
			const entry = event.entry as { customType?: string; data?: { sessionID?: string; agent?: string; error?: string } } | undefined;
			if (entry?.data?.sessionID === current.sessionID) {
				if (entry?.customType === LIVE_APPLIED && typeof entry.data?.agent === "string") current.agent = entry.data.agent;
				if (entry?.customType === LIVE_FAILED) current.failure = entry.data?.error ?? "Live child configuration failed";
			}
		}
		if (event.type !== "message_end" || event.message?.role !== "assistant") return;
		const message = event.message, usage = current.usage;
		usage.turns++;
		const reported = message.usage;
		if (reported) {
			usage.input += reported.input ?? 0;
			usage.output += reported.output ?? 0;
			usage.cacheRead += reported.cacheRead ?? 0;
			usage.cacheWrite += reported.cacheWrite ?? 0;
			usage.cost += reported.cost?.total ?? 0;
			usage.contextTokens = reported.totalTokens ?? 0;
		}
		if (message.model) current.model = message.model;
		if (message.stopReason === "error" && message.errorMessage) current.error = message.errorMessage;
		else if (message.stopReason && message.stopReason !== "pending") current.error = undefined;
		if (message.stopReason !== "error" && message.stopReason !== "aborted") {
			const text = textFromContent(message.content);
			if (text) current.text = text;
		}
	}, () => {
		current.settled = false; current.cancelled = undefined; current.text = ""; current.error = undefined;
		current.model = undefined; current.agent = undefined; current.failure = undefined; current.sessionID = undefined; current.usage = emptyUsage();
	});
	return { settled: current.settled, ...(current.cancelled ? { cancelled: true } : {}), output: current.settled ? current.text || NO_TEXT : "",
		error: current.failure ?? current.error, usage: { ...current.usage }, model: current.model, ...(current.agent ? { agent: current.agent } : {}) };
}

/** Deterministic, readable child session ids so continuation works. */
export function createSessionId(agentId: string): string {
	const stamp = Date.now().toString(36);
	const random = Math.random().toString(36).slice(2, 8);
	return `sub-${agentId}-${stamp}${random}`;
}

/**
 * OpenCode's `<subagent>` envelope, used when a foreground result or a
 * background completion is handed back to the model.
 */
export function subagentEnvelope(input: {
	sessionID: string;
	state: string;
	output: string;
	description?: string;
}): string {
	const description = input.description ? ` description="${input.description}"` : "";
	return `<subagent sessionID="${input.sessionID}" state="${input.state}"${description}>\n${input.output}\n</subagent>`;
}

/** OpenCode's `backgroundResult`, verbatim in intent. */
export function backgroundNotice(sessionID: string): string {
	return [
		`The subagent is working in the background (sessionID: ${sessionID}). You will be notified automatically when it finishes.`,
		"DO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; avoid working with the same files or topics it is using.",
		"Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
	].join("\n");
}
