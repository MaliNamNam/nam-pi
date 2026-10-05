import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { getPackageDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import agents from "../index.ts";
import { childSessionDir, findOwnedChild, type OwnerContext } from "../src/ownership.ts";
import { JobRegistry } from "../src/jobs.ts";
import { readDetachedResult } from "../src/runner.ts";
import { listSessionFamily } from "../src/family.ts";
import { FormHost, requestForm } from "../src/forms.ts";
import { discoverAgents } from "../src/config.ts";
import { LIVE_PREPARE, liveInputCommand } from "../src/live-input.ts";

const execute = promisify(execFile);
const fakePi = fileURLToPath(new URL("./helpers/fake-pi.mjs", import.meta.url));
async function git(cwd: string, ...args: string[]) {
	return (await execute("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true })).stdout.trim();
}
async function harness(t: TestContext, flags: Record<string, unknown> = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worktree-dispatch-"));
	const cwd = path.join(root, "repo"), sessionDir = path.join(root, "sessions");
	await fs.mkdir(cwd);
	await fs.writeFile(path.join(cwd, "fixture-edits.txt"), "committed");
	await fs.writeFile(path.join(cwd, ".gitignore"), ".pi/\nfixture-received.json\n");
	await git(cwd, "init", "-b", "main");
	await git(cwd, "config", "core.autocrlf", "false");
	await git(cwd, "add", ".");
	await git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
	const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		PI_AGENT_ID: process.env.PI_AGENT_ID, PI_AGENT_CONFIG_CWD: process.env.PI_AGENT_CONFIG_CWD };
	process.env.PI_CODING_AGENT_DIR = path.join(root, "config");
	process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
	delete process.env.PI_AGENT_ID; delete process.env.PI_AGENT_CONFIG_CWD;
	const handlers = new Map<string, ((event: any, ctx: ExtensionContext) => any)[]>();
	const tools = new Map<string, any>(), commands = new Map<string, any>();
	const notices: { message: any; options: any }[] = [], notifications: string[] = [], entries: any[] = [];
	const pi = {
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerFlag() {}, getFlag: (name: string) => flags[name], appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }), events: new EventEmitter(),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command), registerMessageRenderer() {},
		getActiveTools: () => ["read", "write", "bash", "subagent"], setActiveTools() {},
		sendMessage: (message: any, options: any) => notices.push({ message, options }),
	} as unknown as ExtensionAPI;
	const model = { provider: "fixture", id: "small", name: "Small", api: "openai-completions", reasoning: false, input: ["text"],
		contextWindow: 32000, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const models = [model, { ...model, id: "alternate", name: "Alternate", reasoning: true }];
	const ctx = {
		cwd, mode: "json", hasUI: false, isIdle: () => true, model, modelRegistry: { getAvailable: () => models, find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id) },
		ui: { notify: (message: string) => notifications.push(message) },
		sessionManager: { getSessionId: () => "parent", getSessionFile: () => path.join(root, "parent.jsonl"),
			getSessionDir: () => sessionDir, getEntries: () => entries, getBranch: () => [] },
	} as unknown as ExtensionContext;
	const owner: OwnerContext = { cwd, parentID: "parent", parentFile: path.join(root, "parent.jsonl"), sessionDir: childSessionDir(sessionDir, "parent") };
	const emit = async (name: string, event: any = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
	agents(pi); await emit("session_start");
	t.after(async () => {
		await emit("session_shutdown");
		for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});
	let calls = 0;
	const invoke = async (input: Record<string, unknown>, signal = new AbortController().signal, onUpdate?: (result: any) => void) => {
		const script = process.argv[1];
		process.argv[1] = fakePi;
		try { return await tools.get("subagent").execute(`fixture-call-${++calls}`, { agent: "general", description: "Fixture file edits", ...input }, signal, onUpdate, ctx); }
		finally { process.argv[1] = script; }
	};
	const openModels = () => {
		const previousMode = ctx.mode;
		(ctx as any).mode = "tui";
		let picker: any, done: () => void;
		(ctx.ui as any).custom = (factory: any) => new Promise<void>((resolve) => {
			done = resolve;
			picker = factory({ terminal: { rows: 30, columns: 100 }, requestRender() {} }, { fg: (_tone: string, text: string) => text }, {}, resolve);
		});
		const completion = commands.get("agents").handler("models", ctx);
		assert.ok(picker, "the keyboard command must open the assignment popup");
		return { save: (id: string, reference: string | null) => picker.options.save(id, reference),
			entries: () => picker.options.entries(), close: async () => { picker.dispose(); done(); await completion; (ctx as any).mode = previousMode; } };
	};
	return { root, cwd, sessionDir, owner, pi, ctx, emit, invoke, commands, notices, notifications, tools, entries, openModels };
}
const prompt = (text: string, delay = 0) => JSON.stringify({ text, delay });
async function settled(registry: JobRegistry, id: string) {
	const record = await registry.get(id);
	assert.ok(record);
	const until = Date.now() + 5000;
	while (Date.now() < until) {
		if ((await readDetachedResult(record.outputPath)).settled) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail("RPC fixture did not settle");
}

test("foreground dispatch isolates real file edits, preserves parent drafts and resumes the exact retained checkout", { timeout: 15000 }, async (t) => {
	const h = await harness(t, { "agent-runner": "sdk" });
	await fs.writeFile(path.join(h.cwd, "fixture-edits.txt"), "parent draft");
	const first = await h.invoke({ prompt: prompt("first child edit"), isolation: "worktree" });
	assert.equal(first.details?.status, "completed", first.content[0].text);
	const { sessionID, workspace } = first.details;
	assert.ok(workspace);
	assert.match(first.content[0].text, /parent uncommitted changes were not included/);
	assert.match(first.content[0].text, /not automatically merged/);
	assert.equal(await fs.readFile(path.join(h.cwd, "fixture-edits.txt"), "utf8"), "parent draft");
	assert.equal(await fs.readFile(path.join(workspace.cwd, "fixture-edits.txt"), "utf8"), "first child edit");
	const receipt = JSON.parse(await fs.readFile(path.join(workspace.cwd, "fixture-received.json"), "utf8"));
	assert.equal(receipt.cwd, workspace.cwd);
	assert.equal(receipt.configCwd, h.cwd);
	assert.equal(receipt.model, "fixture/small");
	assert.match(receipt.prompt, /Work only in this checkout/);
	assert.ok(JSON.parse(Buffer.from(receipt.permissions, "base64").toString()).some((rule: any) => rule.action === "subagent" && rule.effect === "deny"));
	const owned = await findOwnedChild(h.owner, sessionID);
	assert.equal(owned?.cwd, workspace.cwd);
	const mismatch = await h.invoke({ prompt: prompt("wrong workspace"), sessionID, isolation: "shared" });
	assert.match(mismatch.content[0].text, /Cannot change isolation/);
	const second = await h.invoke({ prompt: prompt("second child edit"), sessionID });
	assert.equal(second.details?.sessionID, sessionID, second.content[0].text);
	assert.deepEqual(second.details.workspace, workspace);
	assert.equal((await findOwnedChild(h.owner, sessionID))?.file, owned?.file);
	assert.equal(JSON.parse(await fs.readFile(path.join(workspace.cwd, "fixture-received.json"), "utf8")).continuation, true);
	assert.equal(await fs.readFile(path.join(workspace.cwd, "fixture-edits.txt"), "utf8"), "second child edit");
	assert.equal(await git(h.cwd, "branch", "--show-current"), "main");
	assert.equal(await git(workspace.cwd, "branch", "--show-current"), workspace.branch);
	await h.commands.get("agents").handler("sessions", h.ctx);
	assert.ok(h.notifications.some((message) => message.includes(workspace.branch) && message.includes(workspace.path)));
	await git(workspace.cwd, "checkout", "--detach");
	const repurposed = await h.invoke({ prompt: prompt("must not run"), sessionID });
	assert.match(repurposed.content[0].text, /Cannot continue isolated child/);
	assert.equal(await fs.readFile(path.join(workspace.cwd, "fixture-edits.txt"), "utf8"), "second child edit");
});

test("shared dispatch remains the default, and rejected worktree requests never allocate branches", { timeout: 15000 }, async (t) => {
	const h = await harness(t);
	const shared = await h.invoke({ prompt: prompt("shared edit") });
	assert.equal(shared.details?.status, "completed", shared.content[0].text);
	assert.equal(shared.details.workspace, undefined);
	assert.equal(await fs.readFile(path.join(h.cwd, "fixture-edits.txt"), "utf8"), "shared edit");
	const invalid = await h.invoke({ prompt: prompt("invalid"), isolation: "invalid" });
	assert.match(invalid.content[0].text, /Invalid isolation/);
	const foreign = await h.invoke({ prompt: prompt("foreign"), isolation: "worktree", sessionID: "foreign" });
	assert.match(foreign.content[0].text, /not found or not a child/);
	const unavailable = await h.invoke({ prompt: prompt("unavailable"), isolation: "worktree", model: "fixture/missing" });
	assert.match(unavailable.content[0].text, /not available/);
	assert.equal(await git(h.cwd, "branch", "--list", "pi-agent/*"), "");
	await fs.rm(path.join(h.cwd, ".git"), { recursive: true, force: true });
	const nonGit = await h.invoke({ prompt: prompt("must not edit without Git"), isolation: "worktree" });
	assert.match(nonGit.content[0].text, /Subagent dispatch failed/);
	assert.equal(await fs.readFile(path.join(h.cwd, "fixture-edits.txt"), "utf8"), "shared edit");
	assert.equal((await listSessionFamily(h.owner, h.sessionDir)).length, 1, "failed preparation must not reserve a child");
	const plain = await h.invoke({ prompt: prompt("shared without Git") });
	assert.equal(plain.details?.status, "completed", plain.content[0].text);
	assert.equal(await fs.readFile(path.join(h.cwd, "fixture-edits.txt"), "utf8"), "shared without Git");
});

test("background completion returns workspace metadata to its parent without merging or removing it", { timeout: 15000 }, async (t) => {
	const h = await harness(t);
	const result = await h.invoke({ prompt: prompt("background edit", 100), isolation: "worktree", background: true });
	assert.equal(result.details?.background, true, result.content[0].text);
	const { sessionID, workspace } = result.details;
	const registry = new JobRegistry(h.cwd);
	assert.deepEqual((await registry.get(sessionID))?.workspace, workspace);
	assert.equal(path.dirname((await registry.get(sessionID))!.outputPath), path.join(h.cwd, ".pi", "agents", "jobs"));
	await settled(registry, sessionID);
	await h.emit("before_agent_start");
	await h.emit("turn_end", { outcome: "completed", context: { pendingMessages: [] } });
	assert.equal(h.notices.length, 1);
	assert.deepEqual(h.notices[0].message.details.workspace, workspace);
	assert.match(h.notices[0].message.content, /background edit/);
	assert.match(h.notices[0].message.content, new RegExp(workspace.branch));
	const release = JobRegistry.prototype.release, acknowledgements: Promise<void>[] = [];
	t.mock.method(JobRegistry.prototype, "release", function (this: JobRegistry, id: string) {
		const pending = release.call(this, id);
		acknowledgements.push(pending);
		return pending;
	});
	await h.emit("message_end", { message: { role: "custom", ...h.notices[0].message } });
	assert.equal(acknowledgements.length, 1);
	await Promise.all(acknowledgements);
	assert.equal((await registry.get(sessionID))?.notified, true);
	assert.equal(await fs.readFile(path.join(workspace.cwd, "fixture-edits.txt"), "utf8"), "background edit");
	assert.equal(await fs.readFile(path.join(h.cwd, "fixture-edits.txt"), "utf8"), "committed");
});

test("foreground transfer and cancellation retain the same worktree and unfinished edits", { timeout: 15000 }, async (t) => {
	const h = await harness(t);
	const transfer = await h.invoke({ prompt: prompt("transfer edit", 60000), isolation: "worktree" }, undefined, (result) => {
		if (result.details?.status === "running") void h.commands.get("agents").handler("background", h.ctx);
	});
	assert.equal(transfer.details?.background, true, transfer.content[0].text);
	const { sessionID, workspace } = transfer.details;
	assert.deepEqual((await new JobRegistry(h.cwd).get(sessionID))?.workspace, workspace);
	await h.commands.get("agents").handler(`cancel ${sessionID}`, h.ctx);
	assert.ok(h.notifications.some((message) => message.startsWith(`Stopped ${sessionID}`)));
	assert.equal(await fs.readFile(path.join(workspace.cwd, "fixture-edits.txt"), "utf8"), "transfer edit");
	assert.equal(await git(workspace.cwd, "branch", "--show-current"), workspace.branch);
});

test("root form ownership includes isolated children and original project agents/safeguards remain effective", { timeout: 15000 }, async (t) => {
	const h = await harness(t, { "agent-scope": "both" });
	await fs.mkdir(path.join(h.cwd, ".pi", "agents"), { recursive: true });
	await fs.writeFile(path.join(h.cwd, ".pi", "agents", "project-writer.md"), "---\nmode: subagent\npermission:\n  subagent: deny\n---\nOriginal project agent marker.");
	await h.emit("session_start");
	const result = await h.invoke({ agent: "project-writer", prompt: prompt("policy fixture"), isolation: "worktree" });
	assert.equal(result.details?.status, "completed", result.content[0].text);
	const { sessionID, workspace } = result.details;
	const host = await FormHost.create(h.owner.sessionDir, async () => ({ reply: "once" }),
		async () => new Set((await listSessionFamily(h.owner, h.sessionDir)).map((child) => child.id)));
	try {
		assert.equal((await requestForm(host.route, sessionID, { kind: "permission", tool: "write", reason: "fixture", checks: [{ action: "edit", resource: "public.txt" }] })).reply, "once");
		assert.equal((await requestForm(host.route, "foreign", { kind: "permission", tool: "write", reason: "fixture", checks: [{ action: "edit", resource: "public.txt" }] })).reply, "reject");
	} finally { await host.dispose(); }
	await fs.mkdir(path.join(h.cwd, ".pi"), { recursive: true });
	await fs.writeFile(path.join(h.cwd, ".pi", "safeguards.json"), JSON.stringify({ permission: { edit: { "protected.txt": "deny" } } }));
	const loader = pathToFileURL(path.join(getPackageDir(), "dist/core/extensions/jiti-loader.js")).href;
	const modules = pathToFileURL(path.join(getPackageDir(), "dist/core/extensions/virtual-modules.js")).href;
	const { createJiti } = await import(loader), { VIRTUAL_MODULES } = await import(modules);
	const jiti = createJiti(import.meta.url, { virtualModules: VIRTUAL_MODULES, tryNative: false, moduleCache: false });
	const { SafeguardEngine } = await jiti.import(new URL("../../safeguards/src/engine.ts", import.meta.url).href);
	const engine = new SafeguardEngine({ cwd: workspace.cwd, configCwd: h.cwd, agentDir: process.env.PI_CODING_AGENT_DIR, projectId: h.cwd });
	assert.equal(engine.resolvePath("protected.txt").absolute, path.join(workspace.cwd, "protected.txt"));
	assert.equal(engine.explain("edit", "protected.txt").effect, "deny");
	engine.reload();
	assert.equal(engine.explain("edit", "protected.txt").effect, "deny");
	const childHandlers = new Map<string, any[]>();
	const childFlags: Record<string, unknown> = { agent: "project-writer", "agent-scope": "both", "agent-worktree": Buffer.from(JSON.stringify(workspace)).toString("base64") };
	const receipts: { type: string; data: any }[] = [];
	const childApi = { ...h.pi, events: new EventEmitter(), getFlag: (name: string) => childFlags[name], registerShortcut() {},
		appendEntry: (type: string, data: any) => receipts.push({ type, data }),
		on: (name: string, handler: any) => childHandlers.set(name, [...(childHandlers.get(name) ?? []), handler]) };
	const childFile = (await findOwnedChild(h.owner, sessionID))!.file;
	const childContext = { ...h.ctx, cwd: workspace.cwd, mode: "rpc", isIdle: () => false, abort: () => assert.fail("Child rejected live configuration"), sessionManager: { ...h.ctx.sessionManager,
		getSessionId: () => sessionID, getSessionFile: () => childFile, getSessionDir: () => h.owner.sessionDir } };
	const inheritedScope = process.env.PI_AGENT_SCOPE;
	process.env.PI_AGENT_ID = "project-writer"; process.env.PI_AGENT_CONFIG_CWD = h.cwd; process.env.PI_AGENT_SCOPE = "both";
	try {
		const { default: safeguards } = await jiti.import(new URL("../../safeguards/index.ts", import.meta.url).href);
		safeguards(childApi);
		for (const handler of childHandlers.get("session_start") ?? []) await handler({}, childContext);
		const decisions = await Promise.all((childHandlers.get("tool_call") ?? []).map((handler) => handler({ toolName: "write", toolCallId: "guarded", input: { path: "protected.txt", content: "must be blocked" } }, childContext)));
		assert.ok(decisions.some((decision) => decision?.block), "real safeguards extension must inherit the original project deny rule");
		agents(childApi as unknown as ExtensionAPI);
		for (const handler of childHandlers.get("session_start") ?? []) await handler({}, childContext);
		const definition = discoverAgents({ cwd: h.cwd, agentScope: "both" }).agents.find((agent) => agent.id === "project-writer")!;
		const live = liveInputCommand(sessionID, { agent: definition }, "fixture steering");
		await h.commands.get(LIVE_PREPARE).handler(live.command.split(" ").slice(1).join(" "), childContext);
		assert.equal(receipts.at(-1)?.data.ok, true, JSON.stringify(receipts.at(-1)));
		for (const handler of childHandlers.get("turn_end") ?? []) await handler({ outcome: "completed", context: { pendingMessages: [{ role: "user", content: live.text }] } }, childContext);
		assert.equal(receipts.at(-1)?.data.agent, "project-writer", JSON.stringify(receipts.at(-1)));
		const prompts = (childHandlers.get("context_with_system") ?? []).map((handler) => handler({ messages: [{ role: "system", content: "original" }] }, childContext));
		assert.match(prompts[0].messages[0].content, /Original project agent marker/);
		assert.match(prompts[0].messages[0].content, /Work only in this checkout/);
	} finally {
		for (const handler of childHandlers.get("session_shutdown") ?? []) await handler({}, childContext);
		delete process.env.PI_AGENT_ID; delete process.env.PI_AGENT_CONFIG_CWD;
		if (inheritedScope === undefined) delete process.env.PI_AGENT_SCOPE; else process.env.PI_AGENT_SCOPE = inheritedScope;
	}
	await assert.rejects(fs.access(path.join(workspace.cwd, ".pi", "safeguards.json")), "policy files must not be copied");
});

test("live background steering joins the original isolated checkout without duplicate result delivery", { timeout: 15000 }, async (t) => {
	const h = await harness(t);
	const first = await h.invoke({ prompt: prompt("initial live edit", 60000), isolation: "worktree", background: true });
	assert.equal(first.details?.background, true, first.content[0].text);
	const { sessionID, workspace } = first.details;
	const joined = await h.invoke({ sessionID, prompt: prompt("steered live edit", 100) });
	assert.equal(joined.details?.status, "completed", joined.content[0].text);
	assert.equal(joined.details.sessionID, sessionID);
	assert.deepEqual(joined.details.workspace, workspace);
	assert.equal(await fs.readFile(path.join(workspace.cwd, "fixture-edits.txt"), "utf8"), "steered live edit");
	assert.equal(await fs.readFile(path.join(h.cwd, "fixture-edits.txt"), "utf8"), "committed");
	assert.equal((await new JobRegistry(h.cwd).get(sessionID))?.notified, true);
	await h.emit("before_agent_start");
	await h.emit("turn_end", { outcome: "completed", context: { pendingMessages: [] } });
	assert.equal(h.notices.length, 0);
});

test("foreground abort and parent shutdown stop transport fixtures without deleting isolated edits", { timeout: 15000 }, async (t) => {
	const h = await harness(t), controller = new AbortController();
	const aborted = await h.invoke({ prompt: prompt("unfinished foreground edit", 60000), isolation: "worktree" }, controller.signal, (result) => {
		if (result.details?.status === "running" && result.details.progress?.length) controller.abort();
	});
	assert.match(aborted.content[0].text, /Subagent cancelled/);
	const children = await listSessionFamily(h.owner, h.sessionDir);
	assert.equal(children.length, 1);
	assert.equal(children[0].status, "cancelled");
	assert.equal(await fs.readFile(path.join(children[0].cwd, "fixture-edits.txt"), "utf8"), "unfinished foreground edit");
	const background = await h.invoke({ prompt: prompt("unfinished background edit", 60000), isolation: "worktree", background: true });
	assert.equal(background.details?.background, true, background.content[0].text);
	await h.emit("session_shutdown");
	assert.equal(await fs.readFile(path.join(background.details.workspace.cwd, "fixture-edits.txt"), "utf8"), "unfinished background edit");
	assert.equal(await fs.readFile(path.join(h.cwd, "fixture-edits.txt"), "utf8"), "committed");
});

const modelState = async (cwd: string, id: string) => JSON.parse(await fs.readFile(path.join(cwd, `fixture-model-${id}.json`), "utf8"));

test("session model assignments govern new and settled dispatch, explicit calls win, and reset/resume retain defaults", { timeout: 15000 }, async (t) => {
	const h = await harness(t);
	let popup = h.openModels();
	try { await popup.save("general", "fixture/alternate#high"); }
	finally { await popup.close(); }
	const first = await h.invoke({ prompt: prompt("assigned child") });
	assert.equal(first.details?.status, "completed", first.content[0].text);
	const id = first.details.sessionID;
	assert.equal((await modelState(h.cwd, id)).model, "fixture/alternate");
	assert.equal((await modelState(h.cwd, id)).thinkingLevel, "high");
	const explicit = await h.invoke({ prompt: prompt("explicit child"), model: "fixture/small#off" });
	assert.equal((await modelState(h.cwd, explicit.details.sessionID)).model, "fixture/small");
	await h.emit("session_start");
	const continued = await h.invoke({ sessionID: id, prompt: prompt("restored assignment") });
	assert.equal(continued.details?.sessionID, id);
	assert.equal((await modelState(h.cwd, id)).model, "fixture/alternate");
	popup = h.openModels();
	try { await popup.save("general", null); }
	finally { await popup.close(); }
	await h.emit("session_start");
	const reset = await h.invoke({ sessionID: id, prompt: prompt("follow config again") });
	assert.equal(reset.details?.sessionID, id);
	assert.equal((await modelState(h.cwd, id)).model, "fixture/small", "settled continuations must obey an explicit reset too");
	assert.equal(h.ctx.model?.id, "small", "assigning children never changes the main session model");
	(h.ctx.sessionManager as any).getEntries = () => [];
	(h.ctx.sessionManager as any).getSessionId = () => "separate-parent";
	await h.emit("session_start");
	const separate = await h.invoke({ prompt: prompt("new session defaults") });
	assert.equal((await modelState(h.cwd, separate.details.sessionID)).model, "fixture/small");
});

test("one assignment updates matching background/transferred children without another task or touching other roles", { timeout: 15000 }, async (t) => {
	const h = await harness(t);
	const transferred = await h.invoke({ prompt: prompt("transferred", 60000) }, undefined, (result) => {
		if (result.details?.progress?.length) void h.commands.get("agents").handler("background", h.ctx);
	});
	const background = await h.invoke({ prompt: prompt("background", 60000), background: true });
	const other = await h.invoke({ agent: "explore", prompt: prompt("other role", 60000), background: true });
	const ids = [transferred.details.sessionID, background.details.sessionID];
	const before = await Promise.all(ids.map((id) => modelState(h.cwd, id)));
	const popup = h.openModels();
	try {
		assert.deepEqual(popup.entries().map((entry: any) => entry.id), ["explore", "general"], "the popup lists available definitions rather than inventing Scout");
		assert.match(await popup.save("general", "fixture/alternate#high"), /2 running child/);
	} finally { await popup.close(); }
	for (const [index, id] of ids.entries()) {
		const after = await modelState(h.cwd, id);
		assert.equal(after.pid, before[index].pid); assert.equal(after.id, id);
		assert.equal(after.tasks, 1, "configuration must never enqueue a steering prompt");
		assert.equal(after.model, "fixture/alternate"); assert.equal(after.thinkingLevel, "high");
		assert.deepEqual(after.configurations.map((entry: any) => entry.type), ["set_model", "set_thinking_level"]);
		const owned = await findOwnedChild(h.owner, id);
		const transcript = (await fs.readFile(owned!.file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(transcript.filter((entry) => entry.message?.role === "user").length, 1);
	}
	assert.deepEqual((await modelState(h.cwd, other.details.sessionID)).configurations, []);
	assert.equal(h.ctx.model?.id, "small");
});

test("a running foreground child switches models in place and remains cancellable", { timeout: 15000 }, async (t) => {
	const h = await harness(t);
	let announce: (id: string) => void;
	const started = new Promise<string>((resolve) => { announce = resolve; });
	const running = h.invoke({ prompt: prompt("foreground", 60000) }, undefined, (result) => {
		if (result.details?.progress?.length) announce(result.details.sessionID);
	});
	const id = await started, before = await modelState(h.cwd, id), popup = h.openModels();
	try { assert.match(await popup.save("general", "fixture/alternate#low"), /1 running child/); }
	finally { await popup.close(); }
	const after = await modelState(h.cwd, id);
	assert.equal(after.pid, before.pid); assert.equal(after.tasks, 1); assert.equal(after.model, "fixture/alternate");
	await h.commands.get("agents").handler(`cancel ${id}`, h.ctx);
	assert.match((await running).content[0].text, /Subagent cancelled/);
});

test("rejected live configuration is reported while saving future assignments and leaving the original task running", { timeout: 15000 }, async (t) => {
	const h = await harness(t);
	const result = await h.invoke({ prompt: prompt("unchanged task", 60000), background: true });
	const id = result.details.sessionID;
	await fs.writeFile(path.join(h.cwd, `fixture-reject-model-${id}`), "fixture");
	const popup = h.openModels();
	try {
		assert.match(await popup.save("general", "fixture/alternate#high"), /1 running child update\(s\) failed/);
		assert.ok(h.notifications.some((message) => message.includes("Fixture rejected model update")));
		assert.equal(h.entries.at(-1).data.model, "fixture/alternate#high");
		assert.equal((await modelState(h.cwd, id)).model, "fixture/small");
		assert.equal((await modelState(h.cwd, id)).tasks, 1);
		await fs.rm(path.join(h.cwd, `fixture-reject-model-${id}`));
		await fs.writeFile(path.join(h.cwd, `fixture-session-identity-${id}.txt`), "foreign-session");
		assert.match(await popup.save("general", "fixture/alternate#low"), /1 running child update\(s\) failed/);
		assert.ok(h.notifications.some((message) => message.includes("session identity changed")));
		assert.deepEqual((await modelState(h.cwd, id)).configurations, [], "a changed session identity must never be mutated");
	} finally { await popup.close(); }
});

test("saved callbacks from a former session cannot change the new session's model assignments", { timeout: 15000 }, async (t) => {
	const h = await harness(t), popup = h.openModels();
	try {
		(h.ctx as any).mode = "json";
		await h.emit("session_start");
		const count = h.entries.length;
		await assert.rejects(popup.save("general", "fixture/alternate#high"), /Parent session changed/);
		assert.equal(h.entries.length, count);
	} finally { await popup.close(); }
});

test("reset rejects an unavailable configured default instead of silently resuming the old model", { timeout: 15000 }, async (t) => {
	const h = await harness(t, { "agent-scope": "both" });
	let popup = h.openModels();
	try { await popup.save("general", "fixture/alternate#high"); }
	finally { await popup.close(); }
	const first = await h.invoke({ prompt: prompt("old assigned model") });
	await fs.writeFile(path.join(h.cwd, ".pi", "pi.jsonc"), JSON.stringify({ agent: { general: { model: "fixture/missing" } } }));
	await h.emit("session_start");
	popup = h.openModels();
	try { await popup.save("general", null); }
	finally { await popup.close(); }
	const result = await h.invoke({ sessionID: first.details.sessionID, prompt: prompt("must not run on the old model") });
	assert.match(result.content[0].text, /Model "fixture\/missing" is not available/);
});

test("configured inline thinking is shown accurately and used as the Pi child model argument", { timeout: 15000 }, async (t) => {
	const h = await harness(t, { "agent-scope": "both" });
	await fs.mkdir(path.join(h.cwd, ".pi"), { recursive: true });
	await fs.writeFile(path.join(h.cwd, ".pi", "pi.jsonc"), JSON.stringify({ agent: { general: { model: "fixture/alternate#high" } } }));
	await h.emit("session_start");
	const popup = h.openModels();
	try {
		const entry = popup.entries().find((entry: any) => entry.id === "general");
		assert.equal(entry.reference, "fixture/alternate"); assert.equal(entry.thinkingLevel, "high");
	} finally { await popup.close(); }
	const result = await h.invoke({ prompt: prompt("configured inline thinking") });
	const state = await modelState(h.cwd, result.details.sessionID);
	assert.equal(state.model, "fixture/alternate"); assert.equal(state.thinkingLevel, "high");
});

test("restored preferences clamp changed catalog thinking support just like the displayed assignment", { timeout: 15000 }, async (t) => {
	const h = await harness(t);
	const popup = h.openModels();
	try {
		await popup.save("general", "fixture/alternate#high");
		(h.ctx.modelRegistry.getAvailable()[1] as any).thinkingLevelMap = { high: null };
		assert.equal(popup.entries().find((entry: any) => entry.id === "general").thinkingLevel, "medium");
	} finally { await popup.close(); }
	const result = await h.invoke({ prompt: prompt("current supported thinking") });
	assert.equal(result.details?.status, "completed", result.content[0].text);
	assert.equal((await modelState(h.cwd, result.details.sessionID)).thinkingLevel, "medium");
});

test("Scout assignments are available when experimental discovery enables that role", { timeout: 15000 }, async (t) => {
	const h = await harness(t, { "agent-experimental": true }), popup = h.openModels();
	try {
		assert.deepEqual(popup.entries().map((entry: any) => entry.id), ["explore", "general", "scout"]);
		await popup.save("scout", "fixture/alternate#high");
		assert.equal(h.entries.at(-1).data.agent, "scout");
		assert.equal(h.ctx.model?.id, "small");
	} finally { await popup.close(); }
});
