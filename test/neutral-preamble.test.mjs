import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const entry = process.env.PI_TEST_PACKAGE_DIR
	? pathToFileURL(path.join(process.env.PI_TEST_PACKAGE_DIR, "dist/index.js")).href
	: import.meta.resolve("@earendil-works/pi-coding-agent");
const { buildSystemPromptSections } = await import(new URL("core/system-prompt.js", entry));
const { getSystemMessageText } = await import(new URL("../node_modules/@earendil-works/pi-ai/dist/utils/text.js", entry));
const extensionPath = process.env.PI_TEST_EXTENSION_PATH
	? pathToFileURL(process.env.PI_TEST_EXTENSION_PATH)
	: new URL("../neutral-preamble.ts", import.meta.url);
const { default: extension } = await import(extensionPath.href);
const identity = "You are an expert coding assistant operating inside pi, a coding agent harness.";
let handler;
extension({ on(event, callback) {
	assert.equal(event, "context_with_system");
	handler = callback;
} });

test("removes only the default identity while preserving Pi's generated prompt and tools", () => {
	const sections = buildSystemPromptSections({
		cwd: "C:/project", selectedTools: ["read", "bash", "edit", "write"],
		toolSnippets: { read: "Read files", bash: "Run commands", edit: "Edit files", write: "Write files" },
		toolGuidelines: { read: ["Read the complete file before editing"] },
		promptGuidelines: ["Keep all project rules"],
		contextFiles: [{ path: "C:/project/AGENTS.md", content: "Do not delete user changes" }],
		appendSystemPrompt: "Preserve extension guidance",
	});
	const message = { role: "system", content: "", sections, timestamp: 0, toolsAdded: [{ name: "read", description: "Read files", parameters: { type: "object" } }] };
	const before = structuredClone(message);
	const { messages } = handler({ messages: [message] });
	assert.equal(getSystemMessageText(messages[0]), getSystemMessageText(message).replace(`${identity} `, ""));
	assert.deepEqual(messages[0].sections, { ...sections, preamble: sections.preamble.replace(`${identity} `, "") });
	assert.equal(messages[0].toolsAdded, message.toolsAdded);
	assert.deepEqual(message, before);
});

test("preserves resumed-session prompt and tool transitions and never edits conversation text", () => {
	const messages = [
		{ role: "system", content: "", sections: { preamble: `${identity} You help users by reading files.` }, timestamp: 0, toolsAdded: [{ name: "read" }] },
		{ role: "user", content: [{ type: "text", text: identity }], timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: identity }], timestamp: 2 },
		{ role: "toolResult", content: [{ type: "text", text: `export const preamble = "${identity}";` }], timestamp: 3 },
		{ role: "system", content: "", sections: { preamble: `${identity} Updated guidance.`, project_context: "New project instructions", removed: null }, timestamp: 4, toolsAdded: [{ name: "edit" }], toolsRemoved: [{ name: "read" }] },
	];
	const before = structuredClone(messages);
	const result = handler({ messages }).messages;
	assert.deepEqual(result, messages.map((message) => message.role === "system"
		? { ...message, sections: { ...message.sections, preamble: message.sections.preamble.replace(`${identity} `, "") } }
		: message));
	for (const index of [1, 2, 3]) assert.equal(result[index], messages[index]);
	assert.deepEqual(handler({ messages: result }).messages, result, "repeated requests must be idempotent");
	assert.deepEqual(messages, before);
});

test("handles plain system prompts without stripping custom identities or quoted instructions", () => {
	const messages = [
		{ role: "system", content: `${identity} You help users by reading files.\n\nKeep all rules.`, timestamp: 0 },
		{ role: "system", content: "You are a research assistant. Keep this identity.", timestamp: 1 },
		{ role: "system", content: `Keep this quoted source: "${identity}"`, timestamp: 2 },
		{ role: "system", content: "", sections: { preamble: "You are a custom agent.", project_context: identity }, timestamp: 3 },
	];
	const result = handler({ messages }).messages;
	assert.equal(result[0].content, "You help users by reading files.\n\nKeep all rules.");
	assert.deepEqual(result.slice(1), messages.slice(1));
});

test("the actual Pi CLI sends only the identity change and keeps project instructions and tool schemas", async (t) => {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-neutral-preamble-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const agentDir = path.join(directory, "agent");
	await mkdir(agentDir);
	await writeFile(path.join(directory, "AGENTS.md"), "Keep this project instruction exactly unchanged.");
	const payloads = [];
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		payloads.push(JSON.parse(body));
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.end(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const fixture = path.join(directory, "fixture.ts");
	await writeFile(fixture, `export default function (pi) {
		pi.registerProvider("prompt-fixture", {
			baseUrl: "http://127.0.0.1:${server.address().port}/v1", api: "openai-completions", apiKey: "test-only",
			models: [{ id: "prompt-check", name: "Prompt check", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		});
	}`);
	const cli = fileURLToPath(new URL("bundle/cli.js", entry));
	const args = [cli, "--offline", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-approve", "--extension", fixture, "--provider", "prompt-fixture", "--model", "prompt-check", "--print"];
	for (const extensions of [[], ["--extension", fileURLToPath(extensionPath)]]) {
		const execution = promisify(execFile)(process.execPath, [...args, ...extensions, "Reply OK."], {
			cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, timeout: 15000,
		});
		execution.child.stdin.end(); // Print mode waits for EOF on redirected stdin.
		const { stdout } = await execution;
		assert.match(stdout, /OK/);
	}
	assert.equal(payloads.length, 2);
	const [before, after] = payloads;
	assert.ok(before.messages[0].content.startsWith(`${identity} `));
	assert.equal(after.messages[0].content, before.messages[0].content.replace(`${identity} `, ""));
	assert.match(after.messages[0].content, /Keep this project instruction exactly unchanged\./);
	assert.deepEqual(after.tools, before.tools);
	assert.deepEqual(after.messages.slice(1), before.messages.slice(1));
});
