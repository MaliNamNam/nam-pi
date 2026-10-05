import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { ChildInput, type InputDisposition } from "./child-input.ts";
import { liveInputCommand, LIVE_PREPARE, LIVE_CANCEL, LIVE_APPLIED, LIVE_PREPARED, LIVE_FAILED, type LiveInputUpdate } from "./live-input.ts";
import { declinedEvent } from "./interactions.ts";
import { parseModelRef } from "./models.ts";
import type { PiEvent, RunHandle } from "./runner.ts";

interface Reply { type?: string; id?: string; success?: boolean; error?: string; data?: { disposition?: string; sessionId?: string; steeringMode?: string; commands?: { name?: string }[] }; }

/** Private stdin/stdout capability, never reconstructed from a PID or a job file. */
export class ProcessHandle extends EventEmitter implements RunHandle {
	readonly pid?: number;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killed = false;
	private readonly child: ChildProcess;
	private readonly log: Writable;
	private readonly input: ChildInput;
	readonly supportsLiveUpdates = true as const;
	private currentAgent?: string;
	get agent(): string | undefined { return this.currentAgent; }
	private sessionID?: string;
	private modelUpdates: Promise<void> = Promise.resolve();
	private readonly preparations = new Map<string, { received?: boolean; ok?: boolean; error?: string }>();
	private streaming = false;
	private closing = false;
	private settled = false;
	private ending = false;
	private drainTimer?: ReturnType<typeof setTimeout>;
	private buffer = "";
	private readonly decoder = new StringDecoder("utf8");
	private readonly pending = new Map<string, { resolve(reply: Reply): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
	private diagnostics = "";

	constructor(child: ChildProcess, log: Writable, agent?: string) {
		super(); this.child = child; this.log = log; this.pid = child.pid; this.currentAgent = agent;
		this.input = new ChildInput(async (text, update, signal) => {
			let prepared: ReturnType<typeof liveInputCommand> | undefined;
			if (update) {
				const state = await this.command({ type: "get_state" });
				if (state.data?.sessionId !== this.sessionID || state.data?.steeringMode !== "one-at-a-time") throw new Error("Live switching requires the original child and one-at-a-time steering");
				const commands = await this.command({ type: "get_commands" });
				if (!commands.data?.commands?.some((item) => item.name === LIVE_PREPARE)) throw new Error("This child extension does not support live switching");
				prepared = liveInputCommand(this.sessionID!, update, text);
				const receipt: { received?: boolean; ok?: boolean; error?: string } = {};
				this.preparations.set(prepared.id, receipt);
				try {
					await this.command({ type: "prompt", message: prepared.command });
					if (receipt.ok !== true) throw new Error(receipt.error ?? "Child did not acknowledge configuration preparation; task was not sent");
				} finally { this.preparations.delete(prepared.id); }
				if (signal?.aborted || !this.streaming || this.closing) {
					await this.command({ type: "prompt", message: `/${LIVE_CANCEL} ${prepared.id}` }).catch(() => {});
					throw new Error("Child input cancelled or settled before admission");
				}
			}
			let reply: Reply;
			try { reply = await this.command({ type: "steer", message: prepared?.text ?? text }); }
			catch (error) { if (prepared && !this.closing) await this.command({ type: "prompt", message: `/${LIVE_CANCEL} ${prepared.id}` }).catch(() => {}); throw error; }
			if (prepared && reply.data?.disposition === "handled") await this.command({ type: "prompt", message: `/${LIVE_CANCEL} ${prepared.id}` });
			if (!this.streaming || this.closing) throw new Error("Child settled during input admission; input was not delivered (do not replay until its result is collected)");
			const disposition = reply.data?.disposition;
			if (disposition !== "queued" && disposition !== "handled") throw new Error("Uncertain child input acknowledgement; do not replay");
			return disposition;
		}, () => this.streaming && !this.closing && !this.killed);
		child.stdout!.on("data", (data: Buffer) => {
			this.buffer += this.decoder.write(data);
			for (let end; (end = this.buffer.indexOf("\n")) !== -1;) {
				this.line(this.buffer.slice(0, end)); this.buffer = this.buffer.slice(end + 1);
			}
		});
		child.stderr!.on("data", (data: Buffer) => {
			this.diagnostics = (this.diagnostics + String(data)).slice(-8192);
		});
		child.stdin!.on("error", () => { /* child close rejects every outstanding command */ });
		log.on("drain", () => child.stdout?.resume());
		log.on("error", () => this.kill());
		child.once("error", (error) => { this.diagnostics += error.message; this.end(1, null); });
		child.once("close", (code, signal) => { this.buffer += this.decoder.end(); if (this.buffer.trim()) this.line(this.buffer); this.end(code ?? 1, signal); });
	}
	private write(record: unknown): void {
		if (this.log.destroyed || this.log.writableEnded) return;
		if (!this.log.write(typeof record === "string" ? record + "\n" : JSON.stringify(record) + "\n")) this.child.stdout?.pause();
	}
	private line(line: string): void {
		// Control envelopes are small. Large model/tool records go directly to
		// the observer log, not through another full root-side JSON parse.
		const type = /"type"\s*:\s*"([^"\\]+)"/.exec(line.slice(0, 256))?.[1];
		if (type && !["response", "extension_ui_request", "agent_start", "agent_settled", "entry_appended"].includes(type)) { this.write(line); return; }
		let event: PiEvent & Reply;
		try { event = JSON.parse(line); } catch { this.diagnostics = (this.diagnostics + "\n" + line).slice(-8192); return; }
		if (event.type === "response") {
			const pending = event.id && this.pending.get(event.id);
			if (pending && event.id) {
				this.pending.delete(event.id); clearTimeout(pending.timer);
				if (event.success) pending.resolve(event); else pending.reject(new Error(event.error ?? "Child rejected the command"));
			}
			this.closeIfSettled(); return;
		}
		if (event.type === "extension_ui_request") {
			// Headless child dialogs must never strand a run. Agents+safeguards
			// use the verified root form route; unrelated dialogs fail closed.
			if (["select", "confirm", "input", "editor"].includes(String(event.method))) this.send({ type: "extension_ui_response", id: event.id, cancelled: true });
			return;
		}
		if (event.type === "entry_appended") {
			const entry = event.entry as { customType?: string; data?: { sessionID?: string; id?: string; ok?: boolean; error?: string; agent?: string } } | undefined;
			if (entry?.customType === LIVE_PREPARED && entry.data?.sessionID === this.sessionID && entry.data?.id) {
				const receipt = this.preparations.get(entry.data.id);
				if (receipt) {
					if (receipt.received) { receipt.ok = false; receipt.error = "Ambiguous configuration preparation receipt; task was not sent"; }
					else { receipt.received = true; receipt.ok = entry.data.ok === true; receipt.error = entry.data.error; }
				}
			}
			if (entry?.customType === LIVE_FAILED && entry.data?.sessionID === this.sessionID) {
				this.input.close(); this.send({ type: "clear_queue" }); this.send({ type: "abort" });
			}
			if (entry?.customType === LIVE_APPLIED && entry.data && entry.data.sessionID === this.sessionID && typeof entry.data.agent === "string") {
				this.currentAgent = entry.data.agent; this.emit("agent_switch", this.currentAgent);
			}
		}
		if (event.type === "agent_start") this.streaming = true;
		if (declinedEvent(event)) { this.input.close(); this.killed = true; this.send({ type: "clear_queue" }); }
		if (event.type === "agent_settled") { this.streaming = false; this.settled = true; this.input.close(); this.closeIfSettled(); return; }
		this.write(line);
	}
	private closeIfSettled(): void {
		if (!this.settled || this.closing || this.pending.size) return;
		this.closing = true; this.input.close();
		// Pi 1.0/Node 24 on Windows reproducibly assert in win/async.c when
		// exiting immediately after a steered run, even with no extensions and
		// an idle acknowledgement. A bounded 100 ms quiescence grace avoids
		// that native handle race; it never admits another task or masks errors.
		const id = randomUUID();
		const timer = setTimeout(() => { this.pending.delete(id); this.child.kill("SIGKILL"); }, 7000);
		this.pending.set(id, { timer, resolve: () => {
			if (process.platform === "win32") this.drainTimer = setTimeout(() => this.child.stdin?.end(), 100);
			else this.child.stdin?.end();
		}, reject: () => this.child.kill("SIGTERM") });
		this.send({ type: "clear_queue" }); this.send({ id, type: "abort" });
	}
	private end(code: number, signal: NodeJS.Signals | null): void {
		if (this.ending) return;
		this.ending = true;
		if (this.drainTimer) clearTimeout(this.drainTimer);
		this.closing = true; this.input.close();
		for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Child exited before acknowledging input; do not replay automatically")); }
		this.pending.clear();
		if ((!this.settled || code !== 0) && !this.killed) this.write({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: this.diagnostics.trim() || `Child exited with code ${code}` } });
		if (this.settled) this.write({ type: "agent_settled" });
		const finish = () => {
			this.exitCode = code; this.signalCode = signal;
			this.emit("exit", code, signal); this.emit("close", code, signal);
		};
		if (this.log.destroyed || this.log.writableFinished) finish();
		else this.log.end(finish);
	}
	private send(command: object): void { if (!this.child.stdin?.destroyed) this.child.stdin?.write(JSON.stringify(command) + "\n"); }
	private command(command: object, stopOnTimeout = true): Promise<Reply> {
		if (this.closing || this.killed) return Promise.reject(new Error("Child is stopping"));
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(stopOnTimeout ? "Child input acknowledgement timed out; admission is uncertain (no automatic replay)" : "Child model update acknowledgement timed out (no automatic replay)"));
				if (stopOnTimeout) { this.input.close(); this.kill(); }
				else this.closeIfSettled();
			}, 30_000);
			this.pending.set(id, { resolve, reject, timer }); this.send({ ...command, id });
		});
	}
	async start(task: string, sessionID: string, cwd: string): Promise<void> {
		const state = await this.command({ type: "get_state" });
		if (state.data?.sessionId !== sessionID) { this.kill(); throw new Error("Child RPC session identity mismatch"); }
		this.sessionID = sessionID;
		// RPC has no header. This is observer metadata, not a second transcript.
		this.write({ type: "session", version: 3, id: sessionID, cwd, timestamp: new Date().toISOString() });
		const reply = await this.command({ type: "prompt", message: task });
		if (reply.data?.disposition === "handled") { this.settled = true; this.closeIfSettled(); }
	}
	steer(text: string, signal?: AbortSignal, update?: LiveInputUpdate): Promise<InputDisposition> { return this.input.steer(text, signal, update); }
	configureModel(model: string, thinkingLevel?: string): Promise<void> {
		const ref = parseModelRef(model);
		this.modelUpdates = this.modelUpdates.catch(() => {}).then(async () => {
			if (!this.streaming || this.closing || this.killed) throw new Error("Child is no longer running");
			const state = await this.command({ type: "get_state" }, false);
			if (state.data?.sessionId !== this.sessionID) throw new Error("Child RPC session identity changed");
			await this.command({ type: "set_model", provider: ref.providerID, modelId: ref.id }, false);
			if (thinkingLevel !== undefined) await this.command({ type: "set_thinking_level", level: thinkingLevel }, false);
		});
		return this.modelUpdates;
	}
	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		if (this.exitCode !== null || this.signalCode !== null) return false;
		this.killed = true; this.input.close();
		return this.child.kill(signal);
	}
}
