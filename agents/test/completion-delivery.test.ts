import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import agents from "../index.ts";
import { JobRegistry, jobsDir, type JobOutcome } from "../src/jobs.ts";

async function harness(t: TestContext, entries: any[] = []) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-completion-test-"));
	const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
	process.env.PI_CODING_AGENT_DIR = path.join(cwd, "config");
	process.env.XDG_CONFIG_HOME = path.join(cwd, "xdg");
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
	const handlers = new Map<string, ((event: any, ctx: ExtensionContext) => any)[]>();
	const notices: { message: any; options: any }[] = [];
	const tools = new Map<string, any>();
	const work: Promise<unknown>[] = [];
	let collectGate: ((outcomes: JobOutcome[]) => Promise<JobOutcome[]>) | undefined;
	const collect = JobRegistry.prototype.collect, release = JobRegistry.prototype.release;
	t.mock.method(JobRegistry.prototype, "collect", function (this: JobRegistry, owner?: string) {
		const pending = collect.call(this, owner).then((outcomes) => collectGate ? collectGate(outcomes) : outcomes);
		work.push(pending);
		return pending;
	});
	t.mock.method(JobRegistry.prototype, "release", function (this: JobRegistry, id: string) {
		const pending = release.call(this, id);
		work.push(pending);
		return pending;
	});
	const pi = {
		on: (name: string, handler: (event: any, ctx: ExtensionContext) => any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerFlag: () => {}, getFlag: () => undefined, appendEntry: () => {},
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: () => {}, registerMessageRenderer: () => {},
		getActiveTools: () => ["read", "subagent"], setActiveTools: () => {},
		sendMessage: (message: any, options: any) => notices.push({ message, options }),
	} as unknown as ExtensionAPI;
	const controller = new AbortController();
	let idle = true, parentID = "parent-a";
	const ctx = {
		cwd, mode: "json", hasUI: false, signal: controller.signal, isIdle: () => idle,
		sessionManager: {
			getSessionId: () => parentID, getSessionFile: () => path.join(cwd, `${parentID}.jsonl`),
			getSessionDir: () => path.join(cwd, "sessions"), getEntries: () => entries, getBranch: () => [],
		},
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: any = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	const flush = async () => { await Promise.all(work); await setImmediate(); };
	agents(pi);
	await emit("session_start");
	t.after(async () => {
		await emit("session_shutdown");
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		await fs.rm(cwd, { recursive: true, force: true });
	});
	return {
		cwd, ctx, tools, notices, controller, emit, flush,
		boundary: (outcome = "completed") => emit("turn_end", { outcome, context: { pendingMessages: [] } }),
		begin: async () => { idle = false; await emit("before_agent_start"); },
		idle: async () => { idle = true; t.mock.timers.tick(2000); await flush(); },
		switchSession: async (id: string) => { parentID = id; await emit("session_start"); },
		gate: (gate: typeof collectGate) => { collectGate = gate; },
		acknowledge: async (index = 0) => {
			const message = { role: "custom", ...notices[index].message };
			entries.push({ type: "custom_message", ...notices[index].message });
			await emit("message_start", { message });
			await emit("message_end", { message });
			await flush();
		},
	};
}

async function job(cwd: string, id: string, owner = "parent-a", settled = true) {
	const dir = jobsDir(cwd), outputPath = path.join(dir, `${id}.jsonl`);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify({
		id, agent: "explore", description: "Find auth code", parentSessionID: owner,
		startedAt: Date.now(), outputPath, pid: process.pid,
	}));
	await fs.writeFile(outputPath, [
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `Findings from ${id}` }], stopReason: "stop" } },
		...(settled ? [{ type: "agent_settled" }] : []),
	].map((event) => JSON.stringify(event) + "\n").join(""));
	return { record: () => fs.readFile(path.join(dir, `${id}.json`), "utf8").then(JSON.parse),
		finish: () => fs.appendFile(outputPath, JSON.stringify({ type: "agent_settled" }) + "\n") };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

test("delegation guidance distinguishes prerequisite exploration from independent background work", async (t) => {
	const h = await harness(t), tool = h.tools.get("subagent");
	assert.match(tool.description, /foreground.*depends/i);
	assert.match(tool.promptGuidelines.join("\n"), /Do not repeat delegated exploration/);
	assert.match(tool.promptGuidelines.join("\n"), /implementation or verification/);
	assert.equal(tool.parameters.properties.background.type, "boolean");
	assert.ok(!tool.parameters.required.includes("background"), "foreground remains the default");
});

test("completed children steer the next turn without waiting for settlement and are acknowledged once", async (t) => {
	const h = await harness(t), child = await job(h.cwd, "child-ready");
	await h.idle();
	assert.equal(h.notices.length, 0, "startup must not preempt the first user prompt");
	await h.begin();
	await h.boundary();
	assert.equal(h.notices.length, 1);
	assert.deepEqual(h.notices[0].options, { triggerTurn: true, deliverAs: "steer" });
	assert.match(h.notices[0].message.content, /Findings from child-ready/);
	assert.equal((await child.record()).notified, undefined, "queueing is not persistence acknowledgement");
	await Promise.all([h.boundary(), h.emit("agent_settled")]);
	await h.idle();
	assert.equal(h.notices.length, 1, "boundary/settlement/timer must not duplicate a pending notice");
	await h.acknowledge();
	assert.equal((await child.record()).notified, true);
	await h.boundary();
	await h.idle();
	assert.equal(h.notices.length, 1);
});

test("unfinished children do not trigger requests and late results retain idle delivery", async (t) => {
	const h = await harness(t), child = await job(h.cwd, "child-late", "parent-a", false);
	await h.begin();
	await h.boundary();
	await h.emit("agent_settled");
	await h.flush();
	assert.equal(h.notices.length, 0);
	await child.finish();
	await h.idle();
	assert.equal(h.notices.length, 1);
	assert.deepEqual(h.notices[0].options, { triggerTurn: true, deliverAs: "followUp" });
});

for (const outcome of ["aborted", "error"]) {
	test(`${outcome} runs are not resumed by boundary, settlement or idle collection`, async (t) => {
		const h = await harness(t);
		await job(h.cwd, "child-paused");
		await h.begin();
		await h.boundary(outcome);
		await h.emit("agent_settled");
		await h.idle();
		assert.equal(h.notices.length, 0);
		await h.begin();
		await h.boundary();
		assert.equal(h.notices.length, 1, "a later successful user turn can collect the retained result");
	});
}

test("cancellation during collection cannot queue a result or restart the idle parent", { timeout: 5000 }, async (t) => {
	const h = await harness(t), entered = deferred<void>(), gate = deferred<JobOutcome[]>();
	await job(h.cwd, "child-cancel-race");
	h.gate(async (outcomes) => { entered.resolve(); await gate.promise; return outcomes; });
	await h.begin();
	const boundary = h.boundary();
	await entered.promise;
	h.controller.abort();
	gate.resolve([]);
	await boundary;
	await h.emit("agent_settled");
	await h.idle();
	assert.equal(h.notices.length, 0);
});

test("an abort before any turn boundary does not inherit the previous run's idle eligibility", async (t) => {
	const h = await harness(t);
	await h.begin();
	await h.boundary();
	await h.begin();
	await job(h.cwd, "child-after-abort");
	h.controller.abort();
	await h.emit("agent_settled");
	await h.idle();
	assert.equal(h.notices.length, 0);
});

test("a session switch during collection cannot misroute or acknowledge the former parent's result", { timeout: 5000 }, async (t) => {
	const h = await harness(t), entered = deferred<void>(), gate = deferred<JobOutcome[]>();
	const oldChild = await job(h.cwd, "child-old"), newChild = await job(h.cwd, "child-new", "parent-b");
	h.gate(async (outcomes) => { entered.resolve(); await gate.promise; return outcomes; });
	await h.begin();
	const boundary = h.boundary();
	await entered.promise;
	await h.switchSession("parent-b");
	gate.resolve([]);
	await boundary;
	assert.equal(h.notices.length, 0);
	assert.equal((await oldChild.record()).notified, undefined);
	h.gate(undefined);
	await h.begin();
	await h.boundary();
	assert.equal(h.notices.length, 1);
	assert.equal(h.notices[0].message.details.childID, "child-new");
	await h.acknowledge();
	assert.equal((await newChild.record()).notified, true);
	assert.equal((await oldChild.record()).notified, undefined);
});

test("a turn boundary waits for an older collector rather than missing the next request", { timeout: 5000 }, async (t) => {
	const h = await harness(t), entered = deferred<void>(), gate = deferred<JobOutcome[]>();
	await h.begin();
	await h.boundary();
	await job(h.cwd, "child-collector-race");
	h.gate(async (outcomes) => { entered.resolve(); await gate.promise; return outcomes; });
	await h.emit("agent_settled");
	await entered.promise;
	h.gate(undefined);
	Object.assign(h.ctx, { signal: new AbortController().signal });
	await h.begin();
	const boundary = h.boundary();
	await setImmediate();
	gate.resolve([]);
	await boundary;
	await h.flush();
	assert.equal(h.notices.length, 1);
	assert.equal(h.notices[0].options.deliverAs, "steer");
});

test("persisted completion entries suppress a duplicate after reopening", async (t) => {
	const h = await harness(t, [{ type: "custom_message", customType: "subagent-completion", details: { childID: "child-restored" } }]);
	const child = await job(h.cwd, "child-restored");
	await h.begin();
	await h.boundary();
	assert.equal(h.notices.length, 0);
	assert.equal((await child.record()).notified, true);
});
