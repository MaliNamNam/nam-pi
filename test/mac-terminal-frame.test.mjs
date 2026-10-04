import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// Pi loads extensions through jiti, with its live components supplied as virtual
// modules. PI_TEST_PACKAGE_DIR allows testing against a global Pi installation.
const entry = process.env.PI_TEST_PACKAGE_DIR
	? pathToFileURL(path.join(process.env.PI_TEST_PACKAGE_DIR, "dist/index.js")).href
	: import.meta.resolve("@earendil-works/pi-coding-agent");
const { createJiti } = await import(new URL("core/extensions/jiti-loader.js", entry));
const { VIRTUAL_MODULES } = await import(new URL("core/extensions/virtual-modules.js", entry));
const { ToolExecutionComponent, initTheme } = VIRTUAL_MODULES["@earendil-works/pi-coding-agent"];
const { Text, visibleWidth } = VIRTUAL_MODULES["@earendil-works/pi-tui"];
const jiti = createJiti(import.meta.url, { virtualModules: VIRTUAL_MODULES, tryNative: false, moduleCache: false });
const extension = await jiti.import(new URL("../mac-terminal-frame.ts", import.meta.url).href, { default: true });
const { shellFrameRenderers } = await jiti.import(new URL("../agents/src/mac-frame.ts", import.meta.url).href);
initTheme("dark", false);

const plain = (lines) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
const output = (component, width = 64) => plain(component.render(width)).join("\n");

function harness(t, mode = "tui") {
	const handlers = new Map();
	const tools = new Map();
	const notices = [];
	extension({
		registerTool(definition) { tools.set(definition.name, definition); },
		on(event, handler) { handlers.set(event, handler); },
	});
	const emit = (event) => handlers.get(event)?.({}, { mode, ui: { notify: (...args) => notices.push(args) } });
	emit("session_start");
	t.after(() => emit("session_shutdown"));
	return { tools, notices, emit };
}

function tool(name, definition, args = {}) {
	return new ToolExecutionComponent(name, `call-${name}`, args, { showImages: false }, definition,
		{ requestRender() {} }, process.cwd());
}

function finish(component, text = "extension output", isError = false, isPartial = false) {
	component.updateResult({ content: [{ type: "text", text }], details: undefined, isError }, isPartial);
}

function snapshot(name, component) {
	if (!process.env.MAC_FRAME_SNAPSHOT_DIR) return;
	mkdirSync(process.env.MAC_FRAME_SNAPSHOT_DIR, { recursive: true });
	writeFileSync(path.join(process.env.MAC_FRAME_SNAPSHOT_DIR, `${name}.json`), JSON.stringify(component.render(64)));
}

test("an extension tool without renderers receives a frame and keeps its registration intact", (t) => {
	harness(t);
	const execute = async () => ({ content: [], details: undefined });
	const definition = { name: "web_access", label: "Web Access", description: "Search", parameters: {}, execute,
		exposure: "deferred", defaultActive: false };
	const component = tool("web_access", definition, { op: "search", input: "pi extensions" });
	finish(component);
	snapshot("generic", component);
	const text = output(component);
	assert.match(text, /╭─/);
	assert.match(text, /web_access/);
	assert.match(text, /pi extensions/);
	assert.match(text, /extension output/);
	assert.match(text, /╰─/);
	assert.equal(definition.execute, execute);
	assert.equal(definition.renderShell, undefined);
	assert.equal(definition.renderCall, undefined);
	assert.equal(definition.exposure, "deferred");
	assert.equal(definition.defaultActive, false);
});

test("tools introduced after session start and saved calls without a definition are framed", (t) => {
	harness(t);
	for (const definition of [undefined, { renderShell: "default" }]) {
		const component = tool("late_tool", definition, { nested: { message: "hello" } });
		component.setExpanded(true);
		finish(component, "late output");
		assert.match(output(component), /╭─/);
		assert.match(output(component), /hello/);
		assert.match(output(component), /late output/);
	}
});

test("custom renderers retain state, arguments, options and their own lastComponent", (t) => {
	harness(t);
	const states = [];
	const seen = { call: undefined, result: undefined };
	const definition = {
		renderShell: "self",
		renderCall(args, theme, context) {
			states.push(context.state);
			assert.equal(context.lastComponent, seen.call);
			context.state.token = "shared";
			assert.equal(args.query, "custom query");
			seen.call ??= new Text("", 0, 0);
			seen.call.setText(theme.fg("accent", "custom call"));
			return seen.call;
		},
		renderResult(result, options, theme, context) {
			states.push(context.state);
			assert.equal(context.lastComponent, seen.result);
			assert.equal(context.state.token, "shared");
			assert.equal(result.details.id, 42);
			assert.equal(options.expanded, context.expanded);
			assert.equal(options.isPartial, context.isPartial);
			seen.result ??= new Text("", 0, 0);
			seen.result.setText(theme.fg("success", `custom result ${options.expanded}`));
			return seen.result;
		},
	};
	const component = tool("custom", definition, { query: "custom query" });
	component.updateResult({ content: [], details: { id: 42 }, isError: false }, true);
	component.updateResult({ content: [], details: { id: 42 }, isError: false });
	component.setExpanded(true);
	assert.match(output(component), /custom call/);
	assert.match(output(component), /custom result true/);
	assert.match(output(component), /╭─/);
	assert.ok(states.length >= 5);
	assert.ok(states.every((state) => state === states[0]));
	assert.equal(definition.renderShell, "self");
	let invalidations = 0;
	seen.call.invalidate = () => { invalidations++; };
	component.invalidate();
	assert.ok(invalidations > 0);
});

test("streaming stays open, completion closes the frame, and failures are explicit", (t) => {
	harness(t);
	const component = tool("stream", {});
	finish(component, "partial", false, true);
	assert.match(output(component), /running…/);
	assert.doesNotMatch(output(component), /╰─/);
	finish(component, "final");
	assert.match(output(component), /╰─/);
	assert.doesNotMatch(output(component), /running…/);
	finish(component, "permission denied", true);
	assert.match(output(component), /permission denied/);
	assert.match(output(component), /✗ failed/);
	assert.match(output(component, 8), /failed/);
});

test("renderer callback failures fall back inside the frame", (t) => {
	harness(t);
	const component = tool("broken", {
		renderCall() { throw new Error("broken call renderer"); },
		renderResult() { throw new Error("broken result renderer"); },
	}, { message: "fallback" });
	finish(component, "fallback output");
	assert.match(output(component), /fallback output/);
	assert.match(output(component), /╭─/);
	assert.match(output(component), /╰─/);
});

test("framed custom components receive correctly translated mouse coordinates", (t) => {
	harness(t);
	const events = [];
	const child = { render: () => ["clickable"], invalidate() {}, handleMouse(event) {
		events.push(event);
		return { handled: true };
	} };
	const component = tool("clickable", { renderCall: () => child });
	component.render(64);
	component.handleMouse({ type: "click", button: "left", x: 2, y: 4, width: 64, height: 5 });
	assert.equal(events.length, 1);
	assert.equal(events[0].x, 0);
	assert.equal(events[0].y, 0);
	assert.equal(events[0].width, 60);
	component.handleMouse({ type: "click", button: "left", x: 0, y: 1, width: 64, height: 5 });
	assert.equal(events.length, 1, "title and borders do not reach the child");
});

test("ANSI controls, wide characters, huge output and resizing stay within the frame", (t) => {
	harness(t);
	const component = tool("unicode", { renderResult: () => ({
		render: () => Array.from({ length: 1000 }, (_, i) => `${i} 中文😀\tred\r\n\x1b[31mcolor\x1b[0m\x1b[2J\x1b]0;unsafe\x07`),
		invalidate() {},
	}) });
	finish(component);
	for (const expanded of [false, true]) {
		component.setExpanded(expanded);
		for (const width of [0, 1, 4, 8, 11, 12, 25, 64, 120]) {
			const lines = component.render(width);
			assert.ok(lines.length <= (expanded ? 410 : 30));
			for (const line of lines) {
				assert.ok(visibleWidth(line) <= width, `row exceeds ${width} columns`);
				assert.doesNotMatch(line, /[\r\t]|\x1b\[2J|\x1b\]0;/);
			}
		}
	}
});

test("image-only results keep the native fallback indicator", (t) => {
	harness(t);
	const component = tool("image_tool", {});
	component.updateResult({ content: [{ type: "image", mimeType: "image/png", data: "" }], isError: false });
	assert.match(output(component), /image\/png/);
	assert.match(output(component), /╰─/);
});

test("built-ins and tracked shell frames are not framed twice or activated differently", (t) => {
	const { tools } = harness(t);
	assert.deepEqual([...tools.keys()], ["read", "edit", "write", "grep", "find", "ls"]);
	for (const name of ["grep", "find", "ls"]) assert.equal(tools.get(name).defaultActive, false);
	for (const [name, definition] of [...tools, ["bash", shellFrameRenderers("bash")], ["powershell", shellFrameRenderers("powershell")]]) {
		const component = tool(name, definition, { path: "fixture.ts", command: "echo test" });
		finish(component);
		const text = output(component);
		assert.equal((text.match(/╭/g) ?? []).length, 1, name);
		assert.equal((text.match(/╰/g) ?? []).length, 1, name);
	}
});

test("shutdown restores the hook and reload does not stack wrappers", (t) => {
	const original = ToolExecutionComponent.prototype.hasRendererDefinition;
	const first = harness(t);
	const firstHook = ToolExecutionComponent.prototype.hasRendererDefinition;
	const second = harness(t);
	assert.notEqual(ToolExecutionComponent.prototype.hasRendererDefinition, firstHook);
	first.emit("session_shutdown");
	const component = tool("reloaded", {});
	finish(component);
	assert.equal((output(component).match(/╭/g) ?? []).length, 1);
	second.emit("session_shutdown");
	assert.equal(ToolExecutionComponent.prototype.hasRendererDefinition, original);
});

test("non-TUI sessions do not patch components, and incompatible Pi versions produce a warning", (t) => {
	const original = ToolExecutionComponent.prototype.hasRendererDefinition;
	harness(t, "rpc");
	assert.equal(ToolExecutionComponent.prototype.hasRendererDefinition, original);
	ToolExecutionComponent.prototype.hasRendererDefinition = undefined;
	t.after(() => { ToolExecutionComponent.prototype.hasRendererDefinition = original; });
	const { notices } = harness(t);
	assert.equal(notices.length, 1);
	assert.equal(notices[0][1], "warning");
});
