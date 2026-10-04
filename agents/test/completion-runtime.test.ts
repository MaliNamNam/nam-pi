import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import agents from "../index.ts";
import { jobsDir } from "../src/jobs.ts";

// A real Pi parent and a local mock endpoint; synthetic child output only.
// No subagent is launched, and no real-provider credentials are accessed.
test("Pi's next provider request contains the completion after the parent tool batch", { timeout: 15_000 }, async (t) => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-completion-runtime-"));
	const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
	process.env.PI_CODING_AGENT_DIR = path.join(cwd, "config");
	process.env.XDG_CONFIG_HOME = path.join(cwd, "xdg");
	const requests: any[] = [];
	let closeSession = async () => {};
	const server = http.createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		requests.push(JSON.parse(body));
		const first = requests.length === 1;
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "parent", choices: [{
			index: 0, delta: first ? { role: "assistant", tool_calls: [{ index: 0, id: "independent-work", type: "function",
				function: { name: "independent_work", arguments: "{}" } }] } : { content: "Parent done." }, finish_reason: null,
		}] })}\n\n`);
		res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "parent",
			choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }] })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
	t.after(async () => {
		await closeSession();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		await fs.rm(cwd, { recursive: true, force: true });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const runtime = await ModelRuntime.create({ authPath: path.join(cwd, "unused-auth.json"), modelsPath: null, refreshOnCreate: false });
	runtime.registerProvider("completion-fixture", {
		baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "local-fixture",
		models: [{ id: "parent", name: "Parent", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 256,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	});
	const model = runtime.getModel("completion-fixture", "parent");
	assert.ok(model);
	const manager = SessionManager.inMemory(cwd);
	const loader = new DefaultResourceLoader({
		cwd, agentDir: process.env.PI_CODING_AGENT_DIR, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		agentsFilesOverride: () => ({ agentsFiles: [] }),
		extensionFactories: [agents, (pi) => {
			pi.registerTool({
				name: "independent_work", label: "Independent work", description: "Finish a non-overlapping parent task",
				parameters: Type.Object({}),
				execute: async () => {
					const dir = jobsDir(cwd), outputPath = path.join(dir, "child-fixture.jsonl");
					await fs.mkdir(dir, { recursive: true });
					await fs.writeFile(path.join(dir, "child-fixture.json"), JSON.stringify({
						id: "child-fixture", agent: "explore", description: "Find auth code", parentSessionID: manager.getSessionId(),
						startedAt: Date.now(), outputPath, pid: process.pid,
					}));
					await fs.writeFile(outputPath, [
						{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Auth is in src/auth.ts." }], stopReason: "stop" } },
						{ type: "agent_settled" },
					].map((event) => JSON.stringify(event) + "\n").join(""));
					return { content: [{ type: "text", text: "Independent task finished." }], details: undefined };
				},
			});
		}],
	});
	await loader.reload();
	const { session } = await createAgentSession({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, model, modelRuntime: runtime,
		resourceLoader: loader, sessionManager: manager, tools: ["independent_work", "subagent"], thinkingLevel: "off",
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
	});
	closeSession = async () => {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	};
	const errors: string[] = [];
	await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error.error) });
	await session.prompt("Explore authentication while completing an independent task.");
	await session.waitForIdle();
	assert.deepEqual(errors, []);
	assert.equal(requests.length, 2, "no extra follow-up request after settlement");
	assert.match(requests[0].tools.find((tool: any) => tool.function.name === "subagent").function.description, /foreground.*depends/i);
	assert.match(requests[0].messages.find((message: any) => message.role === "system").content, /Do not repeat delegated exploration/);
	const next = requests[1].messages;
	const text = (message: any) => typeof message.content === "string" ? message.content :
		(message.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
	const resultIndex = next.findIndex((message: any) => message.role === "tool" && text(message).includes("Independent task finished."));
	const completionIndex = next.findIndex((message: any) => message.role === "user" && text(message).includes("Auth is in src/auth.ts."));
	assert.ok(resultIndex >= 0, "the independent tool result reaches the next request");
	assert.ok(completionIndex > resultIndex, "completion enters after the tool result, before the next request");
	assert.equal(session.messages.filter((message: any) => message.customType === "subagent-completion").length, 1);
});
