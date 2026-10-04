import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { prepareWorktree, createWorktree, verifyWorktree, worktreeReport, type WorktreeWorkspace } from "../src/worktrees.ts";
import { childSessionDir, claimChild, findOwnedChild, listOwnedChildren, setChildStatus, type OwnerContext } from "../src/ownership.ts";
import { listSessionFamily } from "../src/family.ts";
import { sdkEligible } from "../src/sdk-client.ts";
import { BUILTIN_AGENTS } from "../src/builtin.ts";

const execute = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await execute("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true })).stdout.trim();
}
async function fixture(t: TestContext): Promise<{ root: string; repo: string; owner: OwnerContext }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worktree-test-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const repo = path.join(root, "project with spaces");
	await fs.mkdir(path.join(repo, "src"), { recursive: true });
	await fs.writeFile(path.join(repo, "src", "code.txt"), "committed\n");
	await fs.writeFile(path.join(repo, ".gitignore"), ".pi/\ncache/\n");
	await git(repo, "init", "-b", "main");
	await git(repo, "config", "core.autocrlf", "false");
	await git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", ".");
	await git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
	return { root, repo, owner: { cwd: repo, sessionDir: path.join(root, "sessions"), parentID: "parent", parentFile: path.join(root, "parent.jsonl") } };
}
async function transcript(owner: OwnerContext, id: string, cwd: string): Promise<string> {
	const file = path.join(owner.sessionDir, `${id}.jsonl`);
	await fs.mkdir(owner.sessionDir, { recursive: true });
	await fs.writeFile(file, JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd }) + "\n");
	return file;
}

async function lockPath(repo: string): Promise<string> {
	const common = await git(repo, "rev-parse", "--git-common-dir");
	return path.join(await fs.realpath(path.resolve(repo, common)), "pi-agents-worktree.lock");
}
async function allocationWorker(t: TestContext) {
	const child = fork(fileURLToPath(new URL("./helpers/worktree-worker.mjs", import.meta.url)), [], {
		execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
	});
	let stderr = "", finished = false, resolveReady!: () => void, resolveStarted!: () => void;
	const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
	const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
	const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
	const result = new Promise<void>((resolve, reject) => {
		child.stderr!.on("data", (data) => { stderr += data; });
		child.on("message", (message: any) => {
			if (message.type === "ready") resolveReady();
			if (message.type === "started") resolveStarted();
			if (message.type === "done") {
				finished = true;
				if (message.ok) resolve(); else reject(new Error(message.error));
			}
		});
		child.once("error", reject);
		child.once("exit", () => { if (!finished) reject(new Error(`Allocation worker exited before reporting: ${stderr}`)); });
	});
	t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; });
	await ready;
	return { child, started, result, create(workspace: WorktreeWorkspace) { child.send({ type: "create", workspace }); return result; } };
}

test("worktrees start from committed HEAD, warn about dirty parents, and never copy drafts or ignored setup", async (t) => {
	const { repo, owner } = await fixture(t);
	const head = await git(repo, "rev-parse", "HEAD");
	await fs.writeFile(path.join(repo, "src", "code.txt"), "unfinished parent\n");
	await fs.writeFile(path.join(repo, "draft.txt"), "untracked\n");
	await fs.mkdir(path.join(repo, "cache"));
	await fs.writeFile(path.join(repo, "cache", "setup.txt"), "local setup\n");
	const before = await git(repo, "status", "--porcelain");
	const workspace = await prepareWorktree({ ...owner, cwd: path.join(repo, "src") }, "sub-general-one");
	assert.equal(workspace.baseCommit, head);
	assert.equal(workspace.parentDirty, true);
	assert.equal(workspace.cwd, path.join(workspace.path, "src"));
	await createWorktree(workspace);
	await verifyWorktree(workspace);
	assert.equal(await fs.readFile(path.join(workspace.cwd, "code.txt"), "utf8"), "committed\n");
	await assert.rejects(fs.access(path.join(workspace.path, "draft.txt")));
	await assert.rejects(fs.access(path.join(workspace.path, "cache")));
	await fs.writeFile(path.join(workspace.cwd, "code.txt"), "child edit\n");
	assert.equal(await fs.readFile(path.join(repo, "src", "code.txt"), "utf8"), "unfinished parent\n");
	assert.equal(await git(repo, "status", "--porcelain"), before);
	assert.equal(await git(repo, "branch", "--show-current"), "main");
	assert.match(worktreeReport(workspace), /uncommitted changes.*not included/i);
	assert.match(worktreeReport(workspace), /not automatically merged/i);
	assert.match(worktreeReport(workspace), /approval/i);
});

test("parallel worktrees have distinct branches and do not overwrite each other's edits", async (t) => {
	const { owner } = await fixture(t);
	const [a, b] = await Promise.all([prepareWorktree(owner, "sub-general-a"), prepareWorktree(owner, "sub-general-b")]);
	assert.equal(a.parentDirty, false);
	await Promise.all([createWorktree(a), createWorktree(b)]);
	assert.notEqual(a.path, b.path);
	assert.notEqual(a.branch, b.branch);
	await fs.writeFile(path.join(a.path, "src", "code.txt"), "a\n");
	assert.equal(await fs.readFile(path.join(b.path, "src", "code.txt"), "utf8"), "committed\n");
	await assert.rejects(createWorktree(a));
	await assert.rejects(fs.access(await lockPath(owner.cwd)), "a failed Git command must release its own allocation lock");
	await verifyWorktree(a);
	assert.equal(await fs.readFile(path.join(a.path, "src", "code.txt"), "utf8"), "a\n");
});

test("worktree preparation rejects non-repositories, unborn HEAD and cancelled requests", async (t) => {
	const { root, owner } = await fixture(t);
	const empty = path.join(root, "empty");
	await fs.mkdir(empty);
	await assert.rejects(prepareWorktree({ ...owner, cwd: empty }, "sub-general-empty"));
	await git(empty, "init");
	await assert.rejects(prepareWorktree({ ...owner, cwd: empty }, "sub-general-empty"));
	await assert.rejects(prepareWorktree(owner, "../foreign"));
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(prepareWorktree(owner, "sub-general-cancelled", controller.signal));
});

test("ownership, family discovery and continuation retain an isolated cwd, including cancelled work", async (t) => {
	const { owner } = await fixture(t);
	const id = "sub-general-owned";
	const workspace = await prepareWorktree(owner, id);
	await claimChild(owner, id, "general", "Isolated edits", workspace);
	await createWorktree(workspace);
	const file = await transcript(owner, id, workspace.cwd);
	const owned = await findOwnedChild(owner, id);
	assert.equal(owned?.file, file);
	assert.equal(owned?.cwd, workspace.cwd);
	assert.deepEqual(owned?.workspace, workspace);
	assert.equal(await findOwnedChild({ ...owner, parentID: "foreign" }, id), undefined);
	await fs.writeFile(path.join(workspace.path, "src", "code.txt"), "preserved after cancellation\n");
	await setChildStatus(owner, id, "cancelled");
	assert.deepEqual((await listOwnedChildren(owner))[0].workspace, workspace);
	const descendants = (await listSessionFamily(owner, path.join(owner.sessionDir, "legacy")));
	assert.equal(descendants[0].cwd, workspace.cwd);
	assert.equal(descendants[0].status, "cancelled");
	assert.equal(await fs.readFile(path.join(workspace.path, "src", "code.txt"), "utf8"), "preserved after cancellation\n");
	assert.equal(sdkEligible({ backend: "sdk", agent: BUILTIN_AGENTS.find((agent) => agent.id === "general")!, task: "fixture", cwd: process.cwd(), sessionDir: owner.sessionDir, workspace }), false);
	await git(workspace.path, "checkout", "--detach");
	await assert.rejects(verifyWorktree(workspace), /branch|worktree/i);
});

test("shared ownership is unchanged and mismatched worktree session headers fail closed", async (t) => {
	const { owner } = await fixture(t);
	await claimChild(owner, "sub-shared", "general", "Shared work");
	await transcript(owner, "sub-shared", owner.cwd);
	const shared = await findOwnedChild(owner, "sub-shared");
	assert.equal(shared?.cwd, owner.cwd);
	assert.equal(shared?.workspace, undefined);
	const workspace = await prepareWorktree(owner, "sub-isolated");
	await claimChild(owner, "sub-isolated", "general", "Isolated work", workspace);
	await transcript(owner, "sub-isolated", owner.cwd);
	assert.equal(await findOwnedChild(owner, "sub-isolated"), undefined);
	assert.equal((await listOwnedChildren(owner)).find((child) => child.id === "sub-isolated")?.file, undefined);
});

test("nested family discovery follows isolated cwd and shared grandchildren inherit that workspace branch", async (t) => {
	const { owner } = await fixture(t), id = "sub-parent";
	const workspace = await prepareWorktree(owner, id);
	await claimChild(owner, id, "general", "Isolated parent", workspace);
	await createWorktree(workspace);
	const file = await transcript(owner, id, workspace.cwd);
	const nested: OwnerContext = { cwd: workspace.cwd, parentID: id, parentFile: file, sessionDir: childSessionDir(owner.sessionDir, id) };
	await claimChild(nested, "sub-shared-grandchild", "explore", "Shared grandchild");
	await transcript(nested, "sub-shared-grandchild", workspace.cwd);
	const grandWorkspace = await prepareWorktree(nested, "sub-isolated-grandchild");
	await claimChild(nested, "sub-isolated-grandchild", "general", "Isolated grandchild", grandWorkspace);
	await createWorktree(grandWorkspace);
	await transcript(nested, "sub-isolated-grandchild", grandWorkspace.cwd);
	const family = await listSessionFamily(owner, path.join(owner.sessionDir, "legacy"));
	assert.equal(family.length, 3);
	const shared = family.find((child) => child.id === "sub-shared-grandchild")!;
	assert.equal(shared.depth, 2);
	assert.equal(shared.cwd, workspace.cwd);
	assert.equal(shared.branch, workspace.branch);
	assert.equal(shared.owner.cwd, workspace.cwd);
	const isolated = family.find((child) => child.id === "sub-isolated-grandchild")!;
	assert.equal(isolated.cwd, grandWorkspace.cwd);
	assert.equal(isolated.branch, grandWorkspace.branch);
	await verifyWorktree(grandWorkspace);
});

test("allocation in separate processes respects one common-directory lock across linked checkouts", { timeout: 15000 }, async (t) => {
	const { repo, owner } = await fixture(t);
	const linked = await prepareWorktree(owner, "sub-linked-source");
	await createWorktree(linked);
	const a = await prepareWorktree(owner, "sub-process-a");
	const b = await prepareWorktree({ ...owner, cwd: linked.cwd }, "sub-process-b");
	assert.equal(await lockPath(repo), await lockPath(linked.cwd));
	const lock = await lockPath(repo);
	await fs.writeFile(lock, JSON.stringify({ pid: process.pid }), { flag: "wx" });
	const [first, second] = await Promise.all([allocationWorker(t), allocationWorker(t)]);
	let finished = 0;
	const pending = Promise.all([first.create(a), second.create(b)]);
	pending.then(() => { finished++; }, () => { finished++; });
	await Promise.all([first.started, second.started]);
	await delay(200);
	assert.equal(finished, 0, "neither process may allocate while the common directory is locked");
	assert.equal(await git(repo, "branch", "--list", a.branch, b.branch), "");
	await fs.unlink(lock);
	await pending;
	await verifyWorktree(a); await verifyWorktree(b);
	await assert.rejects(fs.access(lock));
	assert.equal(await fs.readFile(path.join(a.cwd, "src", "code.txt"), "utf8"), "committed\n");
	assert.equal(await fs.readFile(path.join(b.cwd, "src", "code.txt"), "utf8"), "committed\n");
});

test("cancelling a lock waiter does not allocate or release another process's lock", { timeout: 15000 }, async (t) => {
	const { repo, owner } = await fixture(t), lock = await lockPath(repo);
	const contents = JSON.stringify({ pid: process.pid });
	await fs.writeFile(lock, contents, { flag: "wx" });
	const workspace = await prepareWorktree(owner, "sub-waiter-cancelled");
	const worker = await allocationWorker(t);
	const pending = assert.rejects(worker.create(workspace), /abort/i);
	await worker.started;
	worker.child.send({ type: "abort" });
	await pending;
	assert.equal(await fs.readFile(lock, "utf8"), contents);
	assert.equal(await git(repo, "branch", "--list", workspace.branch), "");
	await assert.rejects(fs.access(workspace.path));
	await fs.unlink(lock);
	await createWorktree(workspace);
	await verifyWorktree(workspace);
});

test("an incompletely published lock remains exclusive and its waiter can be cancelled", { timeout: 15000 }, async (t) => {
	const { repo, owner } = await fixture(t), lock = await lockPath(repo);
	await fs.writeFile(lock, "", { flag: "wx" });
	const workspace = await prepareWorktree(owner, "sub-partial-lock");
	const worker = await allocationWorker(t);
	let finished = false;
	const pending = worker.create(workspace);
	pending.then(() => { finished = true; }, () => { finished = true; });
	await worker.started;
	await delay(150);
	assert.equal(finished, false);
	await fs.writeFile(lock, "{");
	const cancelled = assert.rejects(pending, /abort/i);
	worker.child.send({ type: "abort" });
	await cancelled;
	assert.equal(await fs.readFile(lock, "utf8"), "{");
	assert.equal(await git(repo, "branch", "--list", workspace.branch), "");
	await assert.rejects(fs.access(workspace.path));
});

test("a dead-owner lock fails closed and remains available for explicit recovery", { timeout: 15000 }, async (t) => {
	const { repo, owner } = await fixture(t), lock = await lockPath(repo);
	const { stdout } = await execute(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8", windowsHide: true });
	const pid = Number(stdout);
	assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	const contents = JSON.stringify({ pid });
	await fs.writeFile(lock, contents, { flag: "wx" });
	const workspace = await prepareWorktree(owner, "sub-stale-lock");
	await assert.rejects(createWorktree(workspace), /stale.*lock|lock.*owner/i);
	assert.equal(await fs.readFile(lock, "utf8"), contents);
	assert.equal(await git(repo, "branch", "--list", workspace.branch), "");
	await assert.rejects(fs.access(workspace.path));
	await fs.unlink(lock);
	await createWorktree(workspace);
	await verifyWorktree(workspace);
});
