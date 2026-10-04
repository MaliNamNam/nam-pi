import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

export interface WorktreeWorkspace {
	kind: "worktree";
	sourceCwd: string;
	repoRoot: string;
	path: string;
	cwd: string;
	branch: string;
	baseCommit: string;
	parentDirty: boolean;
}

const execute = promisify(execFile);
async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
	const command = execute("git", ["-C", cwd, ...args], {
		encoding: "utf8", windowsHide: true, signal, maxBuffer: 1024 * 1024,
	});
	const closed = new Promise<void>((resolve) => command.child.once("close", () => resolve()));
	try { return (await command).stdout; }
	finally { await closed; } // Abort can reject before Git has stopped mutating metadata.
}

/** Shared by linked checkouts and processes; never reap a crashed owner's lock automatically. */
async function withAllocationLock(repoRoot: string, signal: AbortSignal | undefined, action: () => Promise<void>): Promise<void> {
	const common = (await git(repoRoot, ["rev-parse", "--git-common-dir"], signal)).trim();
	const file = path.join(await fs.realpath(path.resolve(repoRoot, common)), "pi-agents-worktree.lock");
	const until = Date.now() + 30000;
	let handle;
	while (true) {
		signal?.throwIfAborted();
		if (Date.now() >= until) throw new Error(`Timed out waiting for worktree allocation lock ${file}; inspect its owner before retrying`);
		try { handle = await fs.open(file, "wx", 0o600); break; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		let pid: unknown;
		try { pid = JSON.parse(await fs.readFile(file, "utf8"))?.pid; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			if (!(error instanceof SyntaxError)) throw error;
		}
		if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff) {
			try { process.kill(pid, 0); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") {
					throw new Error(`Stale worktree allocation lock ${file} has no live owner; verify Git has stopped before explicitly removing this lock and retrying`);
				}
				if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
			}
		}
		await delay(50, undefined, { signal });
	}
	try {
		await handle.writeFile(JSON.stringify({ pid: process.pid }) + "\n");
		signal?.throwIfAborted();
		await action();
	} finally {
		await handle.close();
		await fs.unlink(file);
	}
}

function inside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep);
}

export function validWorktree(value: unknown): value is WorktreeWorkspace {
	if (!value || typeof value !== "object") return false;
	const workspace = value as WorktreeWorkspace;
	return workspace.kind === "worktree" && [workspace.sourceCwd, workspace.repoRoot, workspace.path, workspace.cwd]
		.every((entry) => typeof entry === "string" && path.isAbsolute(entry)) &&
		typeof workspace.branch === "string" && /^pi-agent\/[\w.-]+$/.test(workspace.branch) &&
		typeof workspace.baseCommit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(workspace.baseCommit) &&
		typeof workspace.parentDirty === "boolean" && inside(workspace.repoRoot, workspace.sourceCwd) &&
		path.resolve(workspace.cwd) === path.resolve(workspace.path, path.relative(workspace.repoRoot, workspace.sourceCwd));
}

/** Resolve the snapshot before reserving an ID; never stash, copy or clean parent files. */
export async function prepareWorktree(context: { cwd: string; sessionDir: string }, id: string, signal?: AbortSignal): Promise<WorktreeWorkspace> {
	if (!/^[a-zA-Z0-9][\w.-]*$/.test(id)) throw new Error("Invalid worktree session ID");
	const sourceCwd = path.resolve(context.cwd);
	const repoRoot = path.resolve((await git(sourceCwd, ["rev-parse", "--show-toplevel"], signal)).trim());
	const baseCommit = (await git(sourceCwd, ["rev-parse", "--verify", "HEAD"], signal)).trim();
	const parentDirty = (await git(repoRoot, ["status", "--porcelain=v1", "-z"], signal)).length > 0;
	const worktreePath = path.resolve(context.sessionDir, ".pi-worktrees", id);
	const workspace: WorktreeWorkspace = {
		kind: "worktree", sourceCwd, repoRoot, path: worktreePath,
		cwd: path.resolve(worktreePath, path.relative(repoRoot, sourceCwd)),
		branch: `pi-agent/${id}`, baseCommit, parentDirty,
	};
	if (!validWorktree(workspace)) throw new Error("Cannot safely resolve the worktree snapshot");
	return workspace;
}

/** Git's non-forcing add refuses existing branches/paths. Failed or cancelled setup is retained. */
export async function createWorktree(workspace: WorktreeWorkspace, signal?: AbortSignal): Promise<void> {
	if (!validWorktree(workspace)) throw new Error("Invalid worktree metadata");
	signal?.throwIfAborted();
	await withAllocationLock(workspace.repoRoot, signal, async () => {
		await fs.mkdir(path.dirname(workspace.path), { recursive: true, mode: 0o700 });
		await git(workspace.repoRoot, ["worktree", "add", "-b", workspace.branch, workspace.path, workspace.baseCommit], signal);
	});
}

/** A removed, detached or repurposed checkout must not silently become a continuation. */
export async function verifyWorktree(workspace: WorktreeWorkspace, signal?: AbortSignal): Promise<void> {
	if (!validWorktree(workspace)) throw new Error("Invalid worktree metadata");
	await withAllocationLock(workspace.repoRoot, signal, async () => {
		const records = (await git(workspace.repoRoot, ["worktree", "list", "--porcelain", "-z"], signal)).split("\0\0");
		const registered = records.some((record) => {
			const fields = record.split("\0");
			return fields.some((field) => field.startsWith("worktree ") && path.resolve(field.slice(9)) === path.resolve(workspace.path)) &&
				fields.includes(`branch refs/heads/${workspace.branch}`);
		});
		if (!registered || path.resolve((await git(workspace.cwd, ["rev-parse", "--show-toplevel"], signal)).trim()) !== path.resolve(workspace.path)) {
			throw new Error(`Worktree ${workspace.path} is missing or no longer on branch ${workspace.branch}; restore it before continuing`);
		}
	});
}

export function worktreeReport(workspace: WorktreeWorkspace | undefined): string {
	if (!workspace) return "";
	return [
		"Isolated workspace (not automatically merged into the parent):",
		`Branch: ${workspace.branch}`,
		`Worktree: ${workspace.path}`,
		`Working directory: ${workspace.cwd}`,
		`Starting commit: ${workspace.baseCommit}`,
		...(workspace.parentDirty ? ["Warning: parent uncommitted changes were not included."] : []),
		"Worktree and branch are retained, including unfinished edits. Review before integration; merge or deletion requires explicit user approval.",
	].join("\n");
}

export function withWorktreeReport(output: string, workspace: WorktreeWorkspace | undefined): string {
	return workspace ? `${worktreeReport(workspace)}\n\n${output}` : output;
}
