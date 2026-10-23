import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const entry = process.env.PI_TEST_PACKAGE_DIR
	? pathToFileURL(path.join(process.env.PI_TEST_PACKAGE_DIR, "dist/index.js")).href
	: import.meta.resolve("@earendil-works/pi-coding-agent");
const { createJiti } = await import(new URL("core/extensions/jiti-loader.js", entry));
const { VIRTUAL_MODULES } = await import(new URL("core/extensions/virtual-modules.js", entry));
const jiti = createJiti(import.meta.url, { virtualModules: VIRTUAL_MODULES, tryNative: false, moduleCache: false });
const { preparePayload, losslessPng, IMAGE_REMOVED, default: install } = await jiti.import(new URL("../image-budget.ts", import.meta.url).href);
const require = createRequire(new URL("../package.json", entry));
const { PhotonImage } = require("@silvia-odwyer/photon-node");

const pixels = new Uint8Array(64 * 32 * 4);
for (let y = 0; y < 32; y++) {
	for (let x = 0; x < 64; x++) pixels.set([x * 4, y * 8, x < 32 ? 240 : 20, x < 16 ? 128 : 255], (y * 64 + x) * 4);
}
const image = new PhotonImage(pixels, 64, 32);
const png = Buffer.from(image.get_bytes());
image.free();
const pngUrl = `data:image/png;base64,${png.toString("base64")}`;
const bytes = (payload) => Buffer.byteLength(JSON.stringify(payload));
const payload = () => ({
	model: "factory/claude-opus-5-5", stream: true, reasoning_effort: "xhigh",
	messages: [
		{ role: "system", content: "Keep all project rules and Unicode: café." },
		{ role: "user", content: [{ type: "text", text: "Inspect this image." }, { type: "image_url", image_url: { url: pngUrl, detail: "high" } }] },
		{ role: "assistant", tool_calls: [{ id: "read-1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "original.png" }) } }] },
		{ role: "tool", tool_call_id: "read-1", content: "Read image file [image/png]" },
		{ role: "user", content: [{ type: "image_url", image_url: { url: pngUrl } }, { type: "image_url", image_url: { url: "https://example.test/original.png" } }] },
	],
	tools: [{ type: "function", function: { name: "read", description: `Keep quoted data unchanged: ${pngUrl}`, parameters: { type: "object", properties: { path: { type: "string" } } } } }],
});

test("lossless WebP preserves dimensions, every RGBA pixel, and transparency", () => {
	const result = losslessPng(pngUrl);
	assert.match(result, /^data:image\/webp;base64,/);
	assert.ok(result.length < pngUrl.length);
	const decoded = PhotonImage.new_from_byteslice(Buffer.from(result.split(",")[1], "base64"));
	try {
		assert.equal(decoded.get_width(), 64);
		assert.equal(decoded.get_height(), 32);
		assert.deepEqual(decoded.get_raw_pixels(), pixels);
	} finally { decoded.free(); }
});

test("requests below the budget are returned untouched, including their original image format", () => {
	const original = payload();
	const result = preparePayload(original, bytes(original) + 1);
	assert.equal(result.payload, original);
	assert.equal(result.changed, 0);
});

test("oversized requests shrink only inline image copies, preserving text, tools, history, and remote URLs", () => {
	const original = payload();
	const before = structuredClone(original);
	const webpUrl = losslessPng(pngUrl);
	const limit = bytes(original) - (pngUrl.length - webpUrl.length) * 2 + 1;
	const result = preparePayload(original, limit);
	assert.equal(result.changed, 2);
	assert.ok(bytes(result.payload) <= limit);
	const expected = structuredClone(before);
	expected.messages[1].content[1].image_url.url = webpUrl;
	expected.messages[4].content[0].image_url.url = webpUrl;
	assert.deepEqual(result.payload, expected);
	assert.deepEqual(original, before, "never modify objects retained in saved session history");
});

test("compression stops once the request fits rather than converting every image", () => {
	const original = payload();
	const webpUrl = losslessPng(pngUrl);
	const limit = bytes(original) - (pngUrl.length - webpUrl.length) + 1;
	const result = preparePayload(original, limit);
	assert.equal(result.changed, 1);
	assert.equal(result.payload.messages[4].content[0].image_url.url, pngUrl);
});

test("repeated requests reuse cached image copies without modifying the original payload", () => {
	const original = payload();
	const cache = new Map();
	const limit = bytes(original) - 1;
	const first = preparePayload(original, limit, cache);
	assert.equal(cache.size, 1);
	assert.deepEqual(preparePayload(original, limit, cache), first);
	assert.equal(original.messages[1].content[1].image_url.url, pngUrl);
});

test("unsupported or malformed images are never resized or recompressed lossily", () => {
	for (const url of ["data:image/jpeg;base64,AAAA", "data:image/gif;base64,AAAA", "data:image/png;base64,AAAA", "https://example.test/image.png"]) assert.equal(losslessPng(url), undefined);
	const animated = Buffer.concat([png.subarray(0, 33), Buffer.from([0, 0, 0, 8]), Buffer.from("acTL"), Buffer.alloc(12), png.subarray(33)]);
	assert.equal(losslessPng(`data:image/png;base64,${animated.toString("base64")}`), undefined, "never turn animations into a still image");
	const original = { messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(500) }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } }] }] };
	const before = structuredClone(original);
	assert.throws(() => preparePayload(original, 100), /still too large.*eviction/i);
	assert.deepEqual(original, before);
});

test("text-only oversize requests fail clearly without truncating conversation text", () => {
	const original = { messages: [{ role: "user", content: "x".repeat(500) }] };
	assert.throws(() => preparePayload(original, 100), /still too large.*eviction/i);
	assert.equal(original.messages[0].content.length, 500);
});

test("only Factory's OpenAI-compatible requests are affected", async () => {
	const handlers = new Map();
	install({ on: (event, handler) => handlers.set(event, handler) });
	const handler = handlers.get("before_provider_request");
	const large = { messages: [{ role: "user", content: "x".repeat(4_400_000) }] };
	for (const model of [{ provider: "openai", api: "openai-completions" }, { provider: "factory", api: "anthropic-messages" }, undefined]) {
		assert.equal(await handler({ payload: large }, { model }), undefined);
	}
	assert.equal(await handler({ payload: payload() }, { model: { provider: "factory", api: "openai-completions" } }), undefined);
});

test("an image budget failure explicitly aborts the request, because Pi swallows extension hook exceptions", async () => {
	const handlers = new Map();
	install({ on: (event, handler) => handlers.set(event, handler) });
	let aborted = false;
	const notices = [];
	assert.throws(() => handlers.get("before_provider_request")(
		{ payload: { messages: [{ role: "user", content: "x".repeat(4_400_000) }] } },
		{ model: { provider: "factory", api: "openai-completions" }, abort: () => { aborted = true; }, ui: { notify: (message, type) => notices.push([message, type]) } },
	), /still too large.*eviction/i);
	assert.equal(aborted, true);
	assert.equal(notices[0][1], "error");
	assert.match(notices[0][0], /Conversation text and saved images are unchanged/);
});

const inline = (mime, data) => ({ type: "image_url", image_url: { url: `data:${mime};base64,${data}` } });
const jpeg = (value, size = 2048) => inline("image/jpeg", Buffer.alloc(size, value).toString("base64"));

test("the eviction notice matches OpenCode V2 and tells the model not to claim omitted contents", () => {
	assert.equal(IMAGE_REMOVED, "[This image was removed to reduce the request size and is no longer visible. Do not make claims about its contents from memory. If needed, retrieve it again with an available tool or ask the user to attach it again.]");
});

test("after lossless compression cannot fit, oldest inline images become notices and newest stay byte-identical", () => {
	const original = payload();
	original.messages[1].content.push(jpeg(1));
	original.messages[4].content.push(jpeg(2));
	const before = structuredClone(original);
	const expected = structuredClone(original);
	expected.messages[1].content[1] = { type: "text", text: IMAGE_REMOVED };
	expected.messages[1].content[2] = { type: "text", text: IMAGE_REMOVED };
	expected.messages[4].content[0].image_url.url = losslessPng(pngUrl);
	const limit = bytes(expected);
	const result = preparePayload(original, limit);
	assert.equal(result.omitted, 2);
	assert.equal(result.changed, 2, "all eligible PNGs were tried losslessly before eviction");
	assert.equal(result.afterBytes, limit, "exact byte budget is accepted");
	assert.deepEqual(result.payload, expected);
	assert.deepEqual(original, before);
	assert.deepEqual(result.payload.messages[2], before.messages[2], "tool call arguments and IDs survive");
	assert.deepEqual(result.payload.messages[3], before.messages[3], "tool result text and linkage survive");
	assert.deepEqual(result.payload.messages[4].content.at(-1), before.messages[4].content.at(-1), "newest JPEG is not recompressed");
});

test("repeated requests bound the original transcript each time without accumulating notices in saved history", () => {
	const original = { messages: [{ role: "user", content: [jpeg(1)] }, { role: "user", content: [jpeg(2)] }] };
	const expected = structuredClone(original);
	expected.messages[0].content[0] = { type: "text", text: IMAGE_REMOVED };
	const cache = new Map();
	const limit = bytes(expected) + 512; // Room for another turn's notice and message envelope.
	const first = preparePayload(original, limit, cache);
	assert.equal(first.omitted, 1);
	assert.deepEqual(first.payload, expected);
	assert.deepEqual(preparePayload(original, limit, cache), first);
	assert.equal(preparePayload(first.payload, limit, cache).payload, first.payload, "already bounded payload is idempotent");
	assert.equal(original.messages[0].content[0].type, "image_url");
	original.messages.push({ role: "user", content: [jpeg(3)] });
	const next = preparePayload(original, limit, cache);
	assert.equal(next.omitted, 2);
	assert.deepEqual(next.payload.messages.at(-1), original.messages.at(-1));
	assert.equal(original.messages.filter(m => m.content[0].type === "image_url").length, 3);
});

test("eviction handles tool-read images and all inline image formats but never remote URLs or text/tool definitions", () => {
	const remote = { type: "image_url", image_url: { url: "https://example.test/latest.png" } };
	const original = { messages: [
		{ role: "user", content: [remote, { type: "text", text: "Original request" }] },
		{ role: "tool", tool_call_id: "read-1", content: [{ type: "text", text: "Read image file" }, inline("image/gif", "a".repeat(2048)), inline("image/webp", "b".repeat(2048))] },
		{ role: "user", content: [jpeg(3), { type: "text", text: "Inspect the newest image" }] },
	], tools: payload().tools };
	const before = structuredClone(original);
	const expected = structuredClone(original);
	expected.messages[1].content[1] = { type: "text", text: IMAGE_REMOVED };
	expected.messages[1].content[2] = { type: "text", text: IMAGE_REMOVED };
	const result = preparePayload(original, bytes(expected));
	assert.equal(result.omitted, 2);
	assert.deepEqual(result.payload, expected);
	assert.deepEqual(original, before);
});

test("a single too-large inline image gets an explicit notice, never a silently empty message", () => {
	const original = { messages: [{ role: "user", content: [jpeg(1)] }] };
	const expected = { messages: [{ role: "user", content: [{ type: "text", text: IMAGE_REMOVED }] }] };
	const result = preparePayload(original, bytes(expected));
	assert.equal(result.omitted, 1);
	assert.deepEqual(result.payload, expected);
	assert.equal(original.messages[0].content[0].type, "image_url");
});

test("the provider hook returns eviction-only changes and warns the user that older images are no longer visible", () => {
	const handlers = new Map();
	install({ on: (event, handler) => handlers.set(event, handler) });
	const original = { messages: [{ role: "user", content: [jpeg(1, 2_500_000)] }, { role: "user", content: [jpeg(2, 2_500_000)] }] };
	const notices = [];
	const result = handlers.get("before_provider_request")({ payload: original }, {
		model: { provider: "factory", api: "openai-completions" },
		abort: () => assert.fail("a shrinkable request must not be aborted"),
		ui: { notify: (message, type) => notices.push([message, type]) },
	});
	assert.ok(bytes(result) <= 4_300_000);
	assert.equal(result.messages[0].content[0].text, IMAGE_REMOVED);
	assert.deepEqual(result.messages[1], original.messages[1]);
	assert.equal(notices[0][1], "warning");
	assert.match(notices[0][0], /1 older image.*omitted/);
	assert.match(notices[0][0], /Saved originals.*unchanged/);
});

test("the actual Pi CLI evicts old images before HTTP and still blocks oversized non-image context", async (t) => {
	const root = path.join(tmpdir(), "opencode");
	await mkdir(root, { recursive: true });
	const directory = await mkdtemp(path.join(root, "pi-image-budget-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const agentDir = path.join(directory, "agent");
	await mkdir(agentDir);
	const requests = [];
	const server = createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		requests.push(JSON.parse(raw));
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.end('data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const fixture = path.join(directory, "provider.ts");
	await writeFile(fixture, `export default function (pi) {
		pi.registerProvider("factory", { baseUrl: "http://127.0.0.1:${server.address().port}/v1", api: "openai-completions", apiKey: "test-only",
			models: [{ id: "factory/image-budget-fixture", name: "Budget fixture", reasoning: false, input: ["text", "image"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
		pi.on("before_provider_request", (event) => {
			const text = JSON.stringify(event.payload);
			if (text.includes("BLOCK_OVERSIZE")) return { ...event.payload, messages: [{ role: "user", content: "x".repeat(4_400_000) }] };
			if (text.includes("EVICT_IMAGES")) return { ...event.payload, messages: [
				{ role: "user", content: [{ type: "text", text: "Old image" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64," + "a".repeat(3_000_000) } }] },
				{ role: "user", content: [{ type: "text", text: "Newest image" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64," + "b".repeat(3_000_000) } }] },
			] };
		});
	}`);
	const args = [fileURLToPath(new URL("bundle/cli.js", entry)), "--offline", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-approve",
		"--extension", fixture, "--extension", fileURLToPath(new URL("../image-budget.ts", import.meta.url)), "--provider", "factory", "--model", "factory/image-budget-fixture", "--print"];
	for (const prompt of ["Reply OK.", "EVICT_IMAGES", "BLOCK_OVERSIZE"]) {
		const execution = promisify(execFile)(process.execPath, [...args, prompt], { cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, timeout: 15000 });
		execution.child.stdin.end();
		const output = await execution.then((value) => value, (error) => ({ stdout: error.stdout || "", stderr: error.stderr || "" }));
		if (prompt !== "BLOCK_OVERSIZE") assert.equal(output.stdout.trim(), "OK");
		else {
			assert.doesNotMatch(output.stdout, /OK/);
			assert.match(output.stderr, /still too large.*eviction/);
		}
	}
	assert.equal(requests.length, 2, "no HTTP call must be made for the blocked request");
	assert.ok(bytes(requests[1]) <= 4_300_000);
	assert.deepEqual(requests[1].messages[0].content, [{ type: "text", text: "Old image" }, { type: "text", text: IMAGE_REMOVED }]);
	assert.equal(requests[1].messages[1].content[1].image_url.url, "data:image/jpeg;base64," + "b".repeat(3_000_000));
});
