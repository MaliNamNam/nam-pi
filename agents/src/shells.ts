import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { ChildInterrupts, requestChildInterrupt } from "./interrupts.ts";
import type { OwnerContext } from "./ownership.ts";

export type ShellStatus = "running" | "exited" | "timed-out" | "killed";
export interface ShellRun {
	id: string;
	toolCallID: string;
	toolName: string;
	command: string;
	output: string[];
	status: ShellStatus;
	exitCode?: number;
	error?: string;
	started: number;
	updated: number;
}
interface SavedShell extends ShellRun { cwd: string; parentID: string; parentFile?: string; }
interface ShellResult { content: { type: string; text?: string }[]; }
const LEASE_MS = 5000;
const safeID = (id: string) => /^[a-f0-9-]{36}$/.test(id);
const directory = (owner: OwnerContext) => path.join(owner.sessionDir, ".pi-agents-shells");

export function shellStatusLabel(shell: Pick<ShellRun, "status" | "exitCode">): string {
	return shell.status === "running" ? "Running" : shell.status === "killed" ? "Killed" :
		shell.status === "timed-out" ? "Timed out" : `Exited${shell.exitCode === undefined ? "" : ` · code ${shell.exitCode}`}`;
}
export function shellOutput(shell: Pick<ShellRun, "command" | "output" | "error">): string[] {
	if (!shell.error) return shell.output;
	return (shell.output.length && !shell.error.startsWith(shell.output.join("\n"))
		? [...shell.output, "", ...shell.error.split(/\r?\n/)] : shell.error.split(/\r?\n/)).slice(-300);
}

/** Session-scoped output records; an expired live lease is never an interrupt capability. */
export async function readShellRuns(owner: OwnerContext): Promise<ShellRun[]> {
	const entries = await fs.readdir(directory(owner)).catch(() => []);
	const runs = await Promise.all(entries.map(async (entry): Promise<ShellRun | undefined> => {
		if (!entry.endsWith(".json") || !safeID(entry.slice(0, -5))) return undefined;
		try {
			const record = JSON.parse(await fs.readFile(path.join(directory(owner), entry), "utf8")) as SavedShell;
			if (record.id !== entry.slice(0, -5) || record.cwd !== path.resolve(owner.cwd) ||
				record.parentID !== owner.parentID || record.parentFile !== owner.parentFile ||
				!["running", "exited", "timed-out", "killed"].includes(record.status) ||
				typeof record.command !== "string" || !Array.isArray(record.output) || !record.output.every((line) => typeof line === "string") ||
				(record.error !== undefined && typeof record.error !== "string") ||
				!Number.isFinite(record.started) || !Number.isFinite(record.updated)) return undefined;
			if (record.status === "running" && Date.now() - record.updated > LEASE_MS) return { ...record, status: "killed", error: "Shell owner stopped before reporting its final output" };
			return record;
		} catch { return undefined; }
	}));
	return runs.filter((run): run is ShellRun => !!run).sort((a, b) => a.started - b.started || a.id.localeCompare(b.id));
}

export async function cancelShellRun(owner: OwnerContext, id: string): Promise<string> {
	if (!safeID(id)) return "Not a shell of this session";
	const run = (await readShellRuns(owner)).find((entry) => entry.id === id);
	if (!run) return "Not a shell of this session";
	if (run.status !== "running") return "Shell is not running";
	return requestChildInterrupt(owner, id);
}

/** Wrap Pi's native shell execute, preserving its result and using only a per-call abort signal. */
export class ShellRuns {
	private readonly runs = new Map<string, ShellRun>();
	private readonly active = new Map<string, { controller: AbortController; finished: Promise<void> }>();
	private readonly interrupts = new ChildInterrupts();
	private disposed = false;
	private readonly onChange?: () => void;
	constructor(onChange?: () => void) { this.onChange = onChange; }
	list(): ShellRun[] { return [...this.runs.values()]; }

	async execute<T extends ShellResult>(owner: OwnerContext, toolCallID: string, toolName: string, command: string,
		parentSignal: AbortSignal | undefined, execute: (signal: AbortSignal, update: (result: T) => void) => Promise<T>, onUpdate?: (result: T) => void): Promise<T> {
		if (this.disposed) throw new Error("Shell owner stopped");
		const controller = new AbortController();
		const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
		const record: SavedShell = { id: randomUUID(), toolCallID, toolName, command, output: [], status: "running",
			started: Date.now(), updated: Date.now(), cwd: path.resolve(owner.cwd), parentID: owner.parentID, parentFile: owner.parentFile };
		const file = path.join(directory(owner), `${record.id}.json`);
		let finish!: () => void;
		const finished = new Promise<void>((resolve) => { finish = resolve; });
		this.active.set(record.id, { controller, finished });
		this.runs.set(record.id, record);
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		const save = async () => {
			record.updated = Date.now();
			const value = JSON.stringify(record);
			await withFileMutationQueue(file, async () => {
				const temporary = `${file}.tmp`;
				try { await fs.writeFile(temporary, value, { mode: 0o600 }); await fs.rename(temporary, file); }
				finally { await fs.rm(temporary, { force: true }); }
			});
		};
		const output = (result: T) => {
			record.output = result.content.filter((part) => part.type === "text" && typeof part.text === "string")
				.flatMap((part) => part.text!.split(/\r?\n/)).slice(-300).map((line) => line.slice(-4096));
		};
		try {
			await fs.mkdir(directory(owner), { recursive: true, mode: 0o700 });
			await this.interrupts.register(owner, record.id, () => this.active.has(record.id), async () => {
				controller.abort();
				await finished;
				return `Killed shell ${record.id}`;
			});
			await save();
			this.onChange?.();
			heartbeat = setInterval(() => { void save().catch(() => {}); }, 1000);
			heartbeat.unref();
			const result = await execute(signal, (partial) => { output(partial); onUpdate?.(partial); });
			output(result);
			record.status = "exited";
			// Pi 0.87 throws on nonzero exit; Pi 1.0 returns an error result.
			const native = result as T & { isError?: boolean; structuredContent?: { exit_code?: number } };
			const text = result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
			const code = /Command exited with code (\d+)/i.exec(text);
			record.exitCode = native.structuredContent?.exit_code ?? (code ? Number(code[1]) : native.isError ? undefined : 0);
			if (native.isError) record.error = text.slice(-64 * 1024);
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			record.status = signal.aborted ? "killed" : /timed out/i.test(message) ? "timed-out" : "exited";
			record.error = message.slice(-64 * 1024);
			const code = /Command exited with code (\d+)/i.exec(message);
			if (code) record.exitCode = Number(code[1]);
			throw error;
		} finally {
			if (heartbeat) clearInterval(heartbeat);
			await save().catch(() => {});
			this.active.delete(record.id);
			this.runs.delete(record.id); // an open output view retains its own reference
			finish();
			this.onChange?.();
		}
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		const active = [...this.active.values()];
		for (const run of active) run.controller.abort();
		await Promise.all(active.map((run) => run.finished));
		await this.interrupts.dispose();
	}
}
