/**
 * Background subagent jobs.
 *
 * Ported from OpenCode's `Job` service + `SubagentJob`
 * (`packages/core/src/job.ts`, `packages/core/src/session/subagent-job.ts`).
 *
 * OpenCode keeps jobs server-side, so background work outlives the request that
 * started it and delivers a `<subagent>` notification into the parent session
 * when it settles.
 *
 * This is that design with Pi's primitives:
 *   jobs.start / jobs.background  -> startBackground(), which spawns a file-backed
 *                                    child owned by the current Pi process
 *   SubagentCompletion.deliver    -> collect(), which finds settled runs for
 *                                    delivery to their parent sessions
 *   durable notification marker   -> the `.json` record plus the `.jsonl` output
 *
 * Foreground dispatch is awaited in-process until transferred into this registry.
 * All children stop when the owning Pi session shuts down.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
	backgroundNotice,
	forgetDetachedResult,
	readDetachedResult,
	runAgentDetached,
	type DetachedRun,
	type RunHandle,
	type Usage,
} from "./runner.ts";
import type { AgentDefinition } from "./types.ts";

export interface JobRecord {
	id: string;
	agent: string;
	description: string;
	parentSessionID?: string;
	startedAt: number;
	/** File holding the child's JSONL stream. */
	outputPath: string;
	/** Process id for status; never signal it without this registry's live handle. */
	pid?: number;
	/** SDK jobs require their live per-session capability, not the root PID. */
	backend?: "process" | "sdk";
	/** Set once the completion has been delivered. */
	notified?: boolean;
}

export interface JobOutcome {
	record: JobRecord;
	status: "completed" | "error" | "cancelled";
	output: string;
	error?: string;
	usage: Usage;
	model?: string;
}

/** Background jobs live next to the workspace so they are easy to find. */
export function jobsDir(cwd: string): string {
	return path.join(cwd, ".pi", "agents", "jobs");
}

function recordPath(cwd: string, id: string): string {
	return path.join(jobsDir(cwd), `${id}.json`);
}

export class JobRegistry {
	/** Workspace whose `.pi/agents/jobs` directory holds the records. */
	private readonly cwd: string;
	private readonly spawnDetached: typeof runAgentDetached;
	private readonly live = new Map<string, RunHandle>();
	private readonly joined = new Map<string, RunHandle>();

	constructor(cwd: string, spawnDetached: typeof runAgentDetached = runAgentDetached) {
		this.cwd = cwd;
		this.spawnDetached = spawnDetached;
	}

	private async records(): Promise<JobRecord[]> {
		const dir = jobsDir(this.cwd);
		if (!existsSync(dir)) return [];
		let entries: string[];
		try {
			entries = await fs.readdir(dir);
		} catch {
			return [];
		}

		const records: JobRecord[] = [];
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;
			try {
				const parsed = JSON.parse(await fs.readFile(path.join(dir, entry), "utf8")) as Partial<JobRecord>;
				// The workspace may contain unrelated JSON. Do not read arbitrary
				// output paths or signal a PID from an incomplete job record.
				if (
					typeof parsed?.id !== "string" || !/^[\w-]+$/.test(parsed.id) ||
					entry !== `${parsed.id}.json` ||
					typeof parsed.agent !== "string" || typeof parsed.description !== "string" ||
					typeof parsed.startedAt !== "number" || !Number.isFinite(parsed.startedAt) ||
					typeof parsed.outputPath !== "string" ||
					path.resolve(parsed.outputPath) !== path.resolve(dir, `${parsed.id}.jsonl`) ||
					(parsed.pid !== undefined && (!Number.isSafeInteger(parsed.pid) || parsed.pid <= 0)) ||
					(parsed.backend !== undefined && parsed.backend !== "process" && parsed.backend !== "sdk") ||
					(parsed.parentSessionID !== undefined && typeof parsed.parentSessionID !== "string")
				) continue;
				const current = this.live.get(parsed.id)?.agent;
				records.push({ ...parsed, ...(current ? { agent: current } : {}) } as JobRecord);
			} catch {
				// A partially written or corrupt record is skipped.
			}
		}
		return records.toSorted((left, right) => left.startedAt - right.startedAt);
	}

	/** Launch an owned background run. Returns immediately. */
	async startBackground(input: {
		sessionID: string;
		agent: AgentDefinition;
		task: string;
		cwd: string;
		model?: string;
		thinkingLevel?: string;
		sessionDir?: string;
		continuationFile?: string;
		agentScope?: string;
		strictShell?: boolean;
		depthLimit?: number;
		parentSessionID?: string;
		formRoute?: string;
		description: string;
	}): Promise<JobRecord> {
		const run = await this.spawnDetached({
			agent: input.agent,
			task: input.task,
			cwd: input.cwd,
			model: input.model,
			thinkingLevel: input.thinkingLevel,
			strictShell: input.strictShell,
			sessionID: input.sessionID,
			sessionDir: input.sessionDir,
			continuing: input.continuationFile !== undefined,
			continuationFile: input.continuationFile,
			env: {
				PI_AGENT_FORMS: input.formRoute ?? "",
				PI_AGENT_ID: input.agent.id,
				PI_AGENT_DEPTH: String(Number(process.env.PI_AGENT_DEPTH ?? "0") + 1),
				PI_AGENT_SCOPE: input.agentScope ?? "user",
				PI_AGENT_STRICT_SHELL: input.strictShell ? "1" : "0",
				PI_AGENT_DEPTH_LIMIT: String(input.depthLimit ?? 1),
			},
			firstMessagePrefix: "You are a subagent spawned by another session.",
		});

		return this.adopt({ run, sessionID: input.sessionID, agent: input.agent.id,
			description: input.description, parentSessionID: input.parentSessionID });
	}

	/** Transfer the same live foreground child into the durable background registry. */
	async adopt(input: { run: DetachedRun; sessionID: string; agent: string; description: string; parentSessionID?: string }): Promise<JobRecord> {
		const run = input.run;
		if (!/^[\w-]+$/.test(input.sessionID) || run.child.pid !== run.pid ||
			path.resolve(run.outputPath) !== path.resolve(jobsDir(this.cwd), `${input.sessionID}.jsonl`)) {
			run.child.kill("SIGTERM");
			throw new Error("Cannot adopt an unverified child process");
		}
		const record: JobRecord = {
			id: input.sessionID,
			agent: input.agent,
			description: input.description,
			parentSessionID: input.parentSessionID,
			startedAt: Date.now(),
			outputPath: run.outputPath,
			pid: run.pid,
			...(run.backend ? { backend: run.backend } : {}),
		};
		try {
			await this.write(record);
		} catch (error) {
			// A background child without a record can never notify its parent.
			run.child.kill("SIGTERM");
			throw error;
		}
		if (run.child.exitCode === null && run.child.signalCode === null) {
			this.live.set(record.id, run.child);
			run.child.once("exit", () => {
				if (this.live.get(record.id) === run.child) this.live.delete(record.id);
			});
		}
		return record;
	}

	private async write(record: JobRecord): Promise<void> {
		const file = recordPath(this.cwd, record.id);
		const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
		await fs.mkdir(path.dirname(file), { recursive: true });
		try {
			await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
			await fs.rename(temporary, file);
		} finally {
			await fs.rm(temporary, { force: true });
		}
	}

	/** One validated snapshot can serve every row of a family refresh. */
	async list(): Promise<JobRecord[]> { return this.records(); }

	/** Validated record for a viewer; caller must still check parent ownership. */
	async get(id: string): Promise<JobRecord | undefined> {
		return (await this.records()).find((record) => record.id === id);
	}

	getLive(id: string): RunHandle | undefined {
		const child = this.live.get(id);
		return child && child.exitCode === null && child.signalCode === null ? child : undefined;
	}

	/** Reserve the original background generation for a foreground join. */
	async join(id: string, expected: RunHandle): Promise<DetachedRun> {
		if (this.joined.has(id)) throw new Error("This background child already has a foreground waiter");
		this.joined.set(id, expected);
		try {
			const record = await this.get(id);
			if (!record || record.notified || this.getLive(id) !== expected || (await readDetachedResult(record.outputPath)).settled) throw new Error("This child generation already finished");
			return { child: expected, pid: record.pid!, outputPath: record.outputPath, backend: record.backend };
		} catch (error) { this.unjoin(id, expected); throw error; }
	}
	unjoin(id: string, expected: RunHandle): void { if (this.joined.get(id) === expected) this.joined.delete(id); }

	/** A previous background generation must be delivered before the ID is reused. */
	async pending(id: string): Promise<boolean> {
		return (await this.records()).some((record) => record.id === id && !record.notified);
	}

	/**
	 * Jobs that are genuinely still running.
	 *
	 * A record whose output has not settled is not necessarily alive: the child
	 * may have died without writing a final event. `isRunning` distinguishes the
	 * two by watching the output file and the record's age, so a dead job is not
	 * reported as running forever.
	 */
	async running(snapshot?: JobRecord[]): Promise<JobRecord[]> {
		const records = snapshot ?? await this.records();
		const result: JobRecord[] = [];
		for (const record of records) {
			if (record.notified) continue;
			const outcome = await readDetachedResult(record.outputPath);
			if (outcome.settled) continue;
			if (await this.isRunning(record)) result.push(record);
		}
		return result;
	}

	/**
	 * Settled jobs that have not been reported yet.
	 *
	 * A run that never wrote `agent_settled` is reported as cancelled only
	 * after its process exits, matching OpenCode's treatment of an interrupted
	 * job. Records owned by another parent session remain pending.
	 */
	async collect(parentSessionID?: string): Promise<JobOutcome[]> {
		const records = await this.records();
		const outcomes: JobOutcome[] = [];

		for (const record of records) {
			if (record.notified || this.joined.has(record.id)) continue;
			// Background completions belong to the session that dispatched them.
			// Older records without an owner remain deliverable for compatibility.
			if (record.parentSessionID && record.parentSessionID !== parentSessionID) continue;
			const result = await readDetachedResult(record.outputPath);
			if (result.agent) record.agent = result.agent;
			if (this.joined.has(record.id)) continue;

			if (!result.settled) {
				// Not settled yet. Distinguish "still running" from "died"
				// using the persisted PID (or the legacy output/age heuristic).
				const running = await this.isRunning(record);
				if (running) continue;
				outcomes.push({
					record,
					status: "cancelled",
					output: "",
					error: "Interrupted before the subagent finished.",
					usage: result.usage,
				});
				continue;
			}

			outcomes.push({
				record,
				status: result.cancelled ? "cancelled" : result.error ? "error" : "completed",
				output: result.output,
				error: result.error,
				usage: result.usage,
				...(result.model ? { model: result.model } : {}),
			});
		}
		return outcomes;
	}

	/** Check the child PID when available; output may be quiet for many minutes. */
	private async isRunning(record: JobRecord): Promise<boolean> {
		if (record.backend === "sdk") return !!this.getLive(record.id);
		if (record.pid !== undefined) {
			try {
				process.kill(record.pid, 0);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
				return false;
			}
		}
		// Legacy records have no PID; use the original output/age heuristic.
		const first = await this.size(record.outputPath);
		await new Promise((resolve) => setTimeout(resolve, 150));
		const second = await this.size(record.outputPath);
		if (second !== first) return true;
		return Date.now() - record.startedAt < 10_000;
	}

	private async size(file: string): Promise<number> {
		try {
			return (await fs.stat(file)).size;
		} catch {
			return 0;
		}
	}

	/**
	 * Stop a running background job.
	 *
	 * OpenCode cancels a job in-process. A persisted PID is not an identity:
	 * after Pi restarts the OS may reuse it. Only the process handle from a
	 * child spawned by this registry is safe to signal. The record is marked
	 * notified so the next `collect` does not report a phantom completion.
	 */
	async cancel(id: string, expectedChild?: RunHandle): Promise<{ cancelled: boolean; reason?: string }> {
		const record = (await this.records()).find((item) => item.id === id);
		if (!record) return { cancelled: false, reason: `No such subagent: ${id}` };
		if (record.notified) return { cancelled: false, reason: `Subagent ${id} already finished` };
		if (record.pid === undefined) return { cancelled: false, reason: `Subagent ${id} has no recorded process id` };
		if ((await readDetachedResult(record.outputPath)).settled) {
			return { cancelled: false, reason: `Subagent ${id} already finished` };
		}
		const child = this.live.get(id);
		if (expectedChild && child !== expectedChild) return { cancelled: false, reason: `Subagent ${id} is no longer the requested run` };
		if (!child || child.pid !== record.pid || child.exitCode !== null || child.signalCode !== null) {
			return { cancelled: false, reason: `Cannot safely cancel ${id}: its live process handle is unavailable. Verify the PID before stopping it manually.` };
		}
		if (!child.kill("SIGTERM")) {
			return { cancelled: false, reason: `Could not stop ${id}: the child is no longer running` };
		}
		this.live.delete(id);
		forgetDetachedResult(record.outputPath);
		await this.write({ ...record, notified: true });
		try {
			await fs.rm(record.outputPath, { force: true });
		} catch {
			// Best effort.
		}
		return { cancelled: true };
	}

	/** Mark a job as reported and remove its files. */
	async release(id: string): Promise<void> {
		const record = (await this.records()).find((item) => item.id === id);
		if (!record) return;
		forgetDetachedResult(record.outputPath);
		await this.write({ ...record, notified: true });
		try {
			await fs.rm(record.outputPath, { force: true });
		} catch {
			// Best effort.
		}
	}

	/** The OpenCode background result text, shown right after dispatch. */
	notice(id: string): string {
		return backgroundNotice(id);
	}
}
