import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SDKWorkerClient } from "../src/sdk-client.ts";

// A private SDK worker, temporary config and local mock endpoint only.
// The first request is held open so model changes can be verified mid-run.
test("SDK model updates persist in the original child and affect its next request without another user task", { timeout: 20000 }, async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sdk-models-"));
	const cwd = path.join(root, "workspace"), agentDir = path.join(root, "config"), sessionDir = path.join(root, "sessions");
	await fs.mkdir(cwd);
	const client = new SDKWorkerClient(agentDir);
	const boundary = new EventEmitter();
	const firstRequest = once(boundary, "request"), gate = once(boundary, "continue");
	const release = () => boundary.emit("continue");
	const requests: any[] = [];
	const server = http.createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		requests.push(JSON.parse(body));
		const first = requests.length === 1;
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (first) { boundary.emit("request"); await gate; }
		res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: requests.at(-1).model, choices: [{
			index: 0, delta: first ? { role: "assistant", tool_calls: [{ index: 0, id: "fixture-tick", type: "function",
				function: { name: "fixture_tick", arguments: "{}" } }] } : { content: "SDK fixture done." }, finish_reason: null,
		}] })}\n\n`);
		res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: requests.at(-1).model,
			choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }] })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
	t.after(async () => {
		release();
		await client.shutdown();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	await fs.mkdir(path.join(agentDir, "extensions"), { recursive: true });
	await fs.writeFile(path.join(agentDir, "extensions", "fixture.ts"), `
import { Type } from "typebox";
export default function (pi) {
  for (const name of ["agent", "agent-permissions", "agent-forms-route", "agent-run-depth"])
    pi.registerFlag(name, { type: "string" });
  pi.registerProvider("sdk-model-fixture", {
    baseUrl: "http://127.0.0.1:${address.port}/v1", api: "openai-completions", apiKey: "local-fixture",
    models: ["alpha", "beta"].map(id => ({ id, name: id, reasoning: id === "beta", input: ["text"], contextWindow: 32000,
      maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }))
  });
  pi.registerTool({ name: "fixture_tick", label: "Fixture tick", description: "Synthetic tool boundary",
    parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "Fixture tick completed." }], details: undefined }) });
}`);
	const id = "sub-explore-sdk-model-fixture";
	const run = await client.start({ agent: { id: "explore", name: "Explore", description: "Fixture", mode: "subagent", hidden: false,
		systemPrompt: "Synthetic SDK fixture.", tools: ["fixture_tick"], permissions: [{ action: "subagent", resource: "*", effect: "deny" }] },
		task: "Complete the synthetic fixture.", cwd, sessionDir, sessionID: id, model: "sdk-model-fixture/alpha", thinkingLevel: "off" });
	const finished = new Promise<void>((resolve) => run.child.once("close", () => resolve()));
	await firstRequest;
	await assert.rejects(run.child.configureModel!("sdk-model-fixture/missing", "off"), /SDK model unavailable/);
	assert.equal(run.child.killed, false, "a rejected configuration must not cancel the original run");
	await run.child.configureModel!("sdk-model-fixture/beta", "high");
	release();
	await finished;
	assert.equal(run.child.exitCode, 0);
	assert.equal(run.child.agent, "explore");
	assert.deepEqual(requests.map((request) => request.model), ["alpha", "beta"]);
	assert.equal(requests[1].reasoning_effort, "high");
	const file = SessionManager.findById(cwd, id, sessionDir);
	assert.ok(file);
	const manager = SessionManager.open(file, sessionDir), entries = manager.getEntries();
	assert.equal(manager.getSessionId(), id);
	assert.equal(entries.filter((entry) => entry.type === "message" && entry.message.role === "user").length, 1);
	assert.ok(entries.some((entry) => entry.type === "model_change" && entry.provider === "sdk-model-fixture" && entry.modelId === "beta"));
	assert.ok(entries.some((entry) => entry.type === "thinking_level_change" && entry.thinkingLevel === "high"));
	await assert.rejects(run.child.configureModel!("sdk-model-fixture/alpha", "off"), /no longer running/);
});
