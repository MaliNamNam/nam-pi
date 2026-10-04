import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const entry = process.env.PI_TEST_PACKAGE_DIR
	? pathToFileURL(path.join(process.env.PI_TEST_PACKAGE_DIR, "dist/index.js")).href
	: import.meta.resolve("@earendil-works/pi-coding-agent");
const { createJiti } = await import(new URL("core/extensions/jiti-loader.js", entry));
const { VIRTUAL_MODULES } = await import(new URL("core/extensions/virtual-modules.js", entry));
const { AssistantMessageComponent, UserMessageComponent, initTheme } = VIRTUAL_MODULES["@earendil-works/pi-coding-agent"];
const { getKeybindings, stripTerminalSequences, visibleWidth } = VIRTUAL_MODULES["@earendil-works/pi-tui"];
const themeModule = await import(new URL("modes/interactive/theme/theme.js", entry));
const jiti = createJiti(import.meta.url, { virtualModules: VIRTUAL_MODULES, tryNative: false, moduleCache: false });
const extensionDir = process.env.CONVERSATION_FRAME_EXTENSION_DIR
	? pathToFileURL(path.resolve(process.env.CONVERSATION_FRAME_EXTENSION_DIR) + path.sep)
	: new URL("../pi-side-panel/extensions/", import.meta.url);
const { installConversationFrames } = await jiti.import(new URL("slate/conversation-frames.ts", extensionDir).href);
const sidePanel = await jiti.import(new URL("side-panel.ts", extensionDir).href, { default: true });
const { ChildSessionPage } = await jiti.import(new URL("../agents/src/view.ts", import.meta.url).href);
initTheme("dark", false);

const plain = (component, width = 64) => component.render(width).map(stripTerminalSequences);
const text = (component, width = 64) => plain(component, width).join("\n");
const message = (content, extra = {}) => ({ role: "assistant", content, stopReason: "stop", ...extra });
function install(t) {
	const uninstall = installConversationFrames(() => themeModule.theme);
	assert.equal(typeof uninstall, "function");
	t.after(uninstall);
	return uninstall;
}
function snapshot(name, hideThinking = false) {
	if (!process.env.CONVERSATION_FRAME_SNAPSHOT_DIR) return;
	const user = new UserMessageComponent("Please explain **how this works**.\n\nKeep the messages easy to read.");
	const assistant = new AssistantMessageComponent(message([
		{ type: "thinking", thinking: "I'll check the existing renderer and preserve its behavior." },
		{ type: "text", text: "The conversation now has **clear visual separation**.\n\n- Your prompts sit on the right.\n- My replies and thoughts sit on the left." },
	]), hideThinking);
	const lines = [...user.render(72), "", ...assistant.render(72)];
	mkdirSync(process.env.CONVERSATION_FRAME_SNAPSHOT_DIR, { recursive: true });
	writeFileSync(path.join(process.env.CONVERSATION_FRAME_SNAPSHOT_DIR, `${name}.json`), JSON.stringify(lines));
}

snapshot("before");

test("user frames have a right-edge person title and only a left gutter", (t) => {
	install(t);
	const user = new UserMessageComponent("A user prompt");
	const lines = plain(user);
	assert.match(lines[0], /^ {3}╭─+ 👤 ─╮$/u);
	assert.match(lines.at(-1), /^ {3}╰─+╯$/u);
	assert.ok(lines.slice(1, -1).every((line) => /^ {3}│.*│$/u.test(line)));
	assert.ok(lines.every((line) => visibleWidth(line) === 64));
	assert.match(lines.join("\n"), /A user prompt/);
	const raw = user.render(64).join("\n");
	assert.match(raw, /\x1b\]133;A\x07/);
	assert.match(raw, /\x1b\]133;B\x07\x1b\]133;C\x07/);
});

test("assistant replies and thoughts use separate left-edge titles and a right gutter", (t) => {
	install(t);
	const assistant = new AssistantMessageComponent(message([
		{ type: "thinking", thinking: "A private reasoning block" },
		{ type: "text", text: "An assistant answer" },
	]));
	const lines = plain(assistant);
	assert.equal(lines.filter((line) => /^╭─ 🧠 ─+╮ {3}$/u.test(line)).length, 1);
	assert.equal(lines.filter((line) => /^╭─ 🤖 ─+╮ {3}$/u.test(line)).length, 1);
	assert.equal(lines.filter((line) => /^╰─+╯ {3}$/u.test(line)).length, 2);
	assert.match(lines.join("\n"), /A private reasoning block/);
	assert.match(lines.join("\n"), /An assistant answer/);
	snapshot("after");
});

test("streaming, thinking visibility, rebuilds and tool-only messages retain native behavior", (t) => {
	install(t);
	const assistant = new AssistantMessageComponent();
	assistant.updateContent(message([{ type: "thinking", thinking: "first thought" }, { type: "text", text: "partial" }]), true);
	assert.match(text(assistant), /partial/);
	assistant.updateContent(message([{ type: "thinking", thinking: "first thought and more" }, { type: "text", text: "complete answer" }]));
	assert.match(text(assistant), /complete answer/);
	assert.doesNotMatch(text(assistant), /partial/);
	assistant.setHideThinkingBlock(true);
	assert.match(text(assistant), /🧠/u);
	assert.doesNotMatch(text(assistant), /Thinking\.\.\./);
	assert.equal((text(assistant).match(/╭/gu) ?? []).length, 1, "only the reply stays framed");
	assert.doesNotMatch(text(assistant), /first thought/);
	assistant.setHideThinkingBlock(false);
	assistant.setOutputPad(2);
	assistant.invalidate();
	assert.equal((text(assistant).match(/╭/gu) ?? []).length, 2);
	assistant.updateContent(message([{ type: "toolCall", id: "fixture", name: "read", arguments: {} }]));
	assert.equal(text(assistant), "");
});

test("thinking clicks are translated through the frame and borders never toggle them", (t) => {
	install(t);
	const assistant = new AssistantMessageComponent(message([
		{ type: "thinking", thinking: "Click to collapse this thought" },
		{ type: "text", text: "The answer stays visible" },
	]));
	const lines = plain(assistant);
	const top = lines.findIndex((line) => line.includes("🧠"));
	const click = (x, y) => assistant.handleMouse({ type: "click", button: "left", x, y, width: 64, height: lines.length });
	assert.equal(click(1, top), undefined);
	assert.equal(click(0, top + 1), undefined);
	assert.equal(click(63, top + 1), undefined);
	assert.match(text(assistant), /Click to collapse/);
	assert.equal(click(2, top + 1)?.handled, true);
	assert.equal(plain(assistant)[top].trim(), "🧠");
	assert.doesNotMatch(text(assistant), /Thinking\.\.\./);
	assert.doesNotMatch(text(assistant), /Click to collapse/);
	assert.equal(click(2, top), undefined, "blank space beside the brain does not toggle it");
	assert.equal(click(0, top + 1), undefined, "blank separator does not toggle it");
	assert.equal(click(0, top), undefined, "leading padding does not toggle the thought");
	assert.equal(click(3, top)?.handled, true);
	assert.match(text(assistant), /Click to collapse/);
	assert.equal(click(3, top)?.handled, true, "the visible frame's brain title hides the thought again");
	assert.equal(plain(assistant)[top].trim(), "🧠");
	assert.doesNotMatch(text(assistant), /Click to collapse/);
});

test("hidden thoughts show only a standalone brain and preserve custom native labels on shutdown", (t) => {
	const uninstall = install(t);
	const assistant = new AssistantMessageComponent(message([{ type: "thinking", thinking: "Hidden reasoning" }]), true,
		undefined, "Custom collapsed label");
	snapshot("collapsed", true);
	assert.deepEqual(plain(assistant).filter((line) => line.trim()).map((line) => line.trim()), ["🧠"]);
	assert.doesNotMatch(text(assistant), /Hidden reasoning|Custom collapsed label|Thinking|[╭╮╰╯│─]/u);
	for (const width of [0, 1, 2, 7, 8, 25, 64]) {
		assert.ok(assistant.render(width).every((line) => visibleWidth(line) <= width));
	}
	assistant.setHiddenThinkingLabel("Another native label");
	assistant.setOutputPad(2);
	assistant.invalidate();
	assert.deepEqual(plain(assistant).filter((line) => line.trim()).map((line) => line.trim()), ["🧠"]);
	uninstall();
	assert.match(text(assistant), /Another native label/);
	assert.doesNotMatch(text(assistant), /🧠/u);
});

test("the brain stays at the same horizontal column and click position when toggled", (t) => {
	install(t);
	const assistant = new AssistantMessageComponent(message([{ type: "thinking", thinking: "Aligned reasoning" }]));
	snapshot("aligned", true);
	for (const width of [8, 9, 11, 25, 64, 120, 25]) {
		assistant.setHideThinkingBlock(false);
		const expanded = plain(assistant, width).find((line) => line.includes("🧠"));
		const column = visibleWidth(expanded.slice(0, expanded.indexOf("🧠")));
		assistant.setHideThinkingBlock(true);
		const collapsed = plain(assistant, width).find((line) => line.includes("🧠"));
		assert.equal(visibleWidth(collapsed.slice(0, collapsed.indexOf("🧠"))), column, `${width} columns`);
		assert.equal(collapsed.trim(), "🧠");
		const click = () => {
			const lines = plain(assistant, width);
			return assistant.handleMouse({ type: "click", button: "left", x: column,
				y: lines.findIndex((line) => line.includes("🧠")), width, height: lines.length });
		};
		assert.equal(click()?.handled, true);
		assert.match(text(assistant, width), /╭─ 🧠/u);
		assert.equal(click()?.handled, true);
		assert.doesNotMatch(text(assistant, width), /Aligned|[╭╮╰╯│─]/u);
	}
});

test("each standalone brain expands only its own hidden thinking run", (t) => {
	install(t);
	const assistant = new AssistantMessageComponent(message([
		{ type: "thinking", thinking: "First hidden reasoning" },
		{ type: "text", text: "Interleaved reply" },
		{ type: "thinking", thinking: "Second hidden reasoning" },
	]), true);
	const clickBrain = (index, x) => {
		const lines = plain(assistant);
		const rows = lines.flatMap((line, y) => line.trim() === "🧠" ? [y] : []);
		return assistant.handleMouse({ type: "click", button: "left", x, y: rows[index], width: 64, height: lines.length });
	};
	assert.equal(clickBrain(1, 4)?.handled, true, "both columns of the emoji are clickable");
	assert.match(text(assistant), /Second hidden reasoning/);
	assert.doesNotMatch(text(assistant), /First hidden reasoning|Thinking\.\.\./);
	assert.equal(plain(assistant).filter((line) => line.trim() === "🧠").length, 1);
	assert.equal(clickBrain(0, 3)?.handled, true);
	assert.match(text(assistant), /First hidden reasoning/);
	assert.match(text(assistant), /Second hidden reasoning/);
	assert.equal(plain(assistant).filter((line) => line.trim() === "🧠").length, 0);
	const lines = plain(assistant);
	const headers = lines.flatMap((line, y) => line.includes("╭─ 🧠") ? [y] : []);
	assert.equal(assistant.handleMouse({ type: "click", button: "left", x: 4, y: headers[1], width: 64, height: lines.length })?.handled, true);
	assert.match(text(assistant), /First hidden reasoning/);
	assert.doesNotMatch(text(assistant), /Second hidden reasoning/);
	assert.equal(plain(assistant).filter((line) => line.trim() === "🧠").length, 1);
});

test("visible reasoning named Thinking... is still framed rather than mistaken for a hidden label", (t) => {
	install(t);
	const assistant = new AssistantMessageComponent(message([{ type: "thinking", thinking: "Thinking..." }]));
	assert.match(text(assistant), /╭─ 🧠/u);
	assert.match(text(assistant), /Thinking\.\.\./);
});

test("existing messages, Markdown transformers, padding and user background survive wrapping", (t) => {
	const calls = [];
	const transformer = (markdown, { messageType }) => { calls.push(messageType); return `${markdown}\n\nTransformed content`; };
	const user = new UserMessageComponent("**bold** user text", undefined, 2, [transformer]);
	const assistant = new AssistantMessageComponent(message([{ type: "text", text: "**bold** reply" }]), false, undefined, undefined, 2, [transformer]);
	const nativeBody = new UserMessageComponent("**bold** user text", undefined, 1, [transformer])
		.render(59).find((line) => stripTerminalSequences(line).includes("bold"));
	install(t);
	assert.match(text(user), /👤/u);
	assert.match(text(user), /Transformed content/);
	assert.match(text(assistant), /Transformed content/);
	assert.ok(calls.includes("user"));
	assert.ok(calls.includes("assistant"));
	user.setOutputPad(1);
	user.invalidate();
	assert.equal((text(user).match(/╭/gu) ?? []).length, 1);
	const body = user.render(64).find((line) => stripTerminalSequences(line).includes("bold"));
	assert.match(body, /\x1b\[(?:48;|4[0-7]m)/);
	assert.ok(body.includes(nativeBody), "retain the native Markdown ANSI and background sequences");
});

test("consecutive thoughts stay one brain frame, interleaved text retains message order", (t) => {
	install(t);
	const assistant = new AssistantMessageComponent(message([
		{ type: "thinking", thinking: "first thought" },
		{ type: "thinking", thinking: "second thought" },
		{ type: "text", text: "first answer" },
		{ type: "thinking", thinking: "third thought" },
		{ type: "text", text: "last answer" },
	]));
	const result = text(assistant);
	assert.equal((result.match(/🧠/gu) ?? []).length, 2);
	assert.equal((result.match(/🤖/gu) ?? []).length, 2);
	assert.ok(result.indexOf("second thought") < result.indexOf("first answer"));
	assert.ok(result.indexOf("first answer") < result.indexOf("third thought"));
	assert.ok(result.indexOf("third thought") < result.indexOf("last answer"));
});

test("narrow widths, Unicode, code blocks and resize stay bounded without dropping text", (t) => {
	install(t);
	const content = "Long content 中文 😀 " + "wrapped words ".repeat(12) + "\n\n```ts\nconst value = 42;\n```";
	for (const component of [new UserMessageComponent(content), new AssistantMessageComponent(message([{ type: "text", text: content }]))]) {
		for (const width of [0, 1, 2, 4, 7, 8, 9, 11, 12, 25, 64, 120, 25]) {
			for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `row exceeds ${width} columns`);
		}
		const result = text(component, 25).replace(/[│╭╮╰╯─👤🤖]/gu, "").replace(/\s/gu, "");
		assert.match(result, /Longcontent中文😀/u);
		assert.match(result, /constvalue=42;/);
		assert.equal((text(component, 25).match(/╭/gu) ?? []).length, 1);
	}
});

test("errors and length stops stay visible; tool-containing assistant messages keep their zone behavior", (t) => {
	install(t);
	for (const [stopReason, expected] of [["error", "Error: fixture failure"], ["aborted", "Operation aborted"], ["length", "Response was truncated before completion."]]) {
		const assistant = new AssistantMessageComponent(message([], { stopReason, errorMessage: stopReason === "error" ? "fixture failure" : undefined }));
		assert.match(text(assistant), /🤖/u);
		assert.ok(text(assistant).includes(expected));
	}
	const assistant = new AssistantMessageComponent(message([{ type: "text", text: "Before the tool" }, { type: "toolCall", id: "fixture", name: "read", arguments: {} }]));
	assert.match(text(assistant), /🤖/u);
	assert.doesNotMatch(assistant.render(64).join("\n"), /\x1b\]133;/);
});

test("theme changes repaint the borders instead of retaining stale ANSI", (t) => {
	install(t);
	const user = new UserMessageComponent("Theme test");
	const dark = user.render(64)[0];
	initTheme("light", false);
	t.after(() => initTheme("dark", false));
	user.invalidate();
	assert.notEqual(user.render(64)[0], dark);
	assert.match(plain(user)[0], /👤/u);
});

test("reload does not stack frames; shutdown restores existing and future messages", (t) => {
	const originalUser = UserMessageComponent.prototype.render;
	const originalAssistant = AssistantMessageComponent.prototype.render;
	const first = install(t);
	const user = new UserMessageComponent("reload");
	const assistant = new AssistantMessageComponent(message([{ type: "text", text: "reload answer" }]));
	text(user); text(assistant);
	const second = install(t);
	first();
	assert.equal((text(user).match(/╭/gu) ?? []).length, 1);
	assert.equal((text(assistant).match(/╭/gu) ?? []).length, 1);
	second(); second();
	assert.equal(UserMessageComponent.prototype.render, originalUser);
	assert.equal(AssistantMessageComponent.prototype.render, originalAssistant);
	assert.doesNotMatch(text(user), /╭|👤/u);
	assert.doesNotMatch(text(assistant), /╭|🤖/u);
	assert.doesNotMatch(text(new UserMessageComponent("after shutdown")), /╭/u);
});

test("child-session conversations inherit the same user, thought and reply frames", (t) => {
	install(t);
	const tui = { terminal: { rows: 30, columns: 80 }, requestRender() {} };
	const data = { entries: [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "Child prompt" }] } },
		{ type: "message", message: message([{ type: "thinking", thinking: "Child reasoning" }, { type: "text", text: "Child answer" }]) },
	] };
	const page = new ChildSessionPage(tui, themeModule.theme, getKeybindings(), "fixture", data, () => {},
		{ children: [], viewChild() {}, interruptChild: async () => "fixture" });
	t.after(() => page.dispose());
	const result = text(page, 80);
	assert.match(result, /👤/u);
	assert.match(result, /🧠/u);
	assert.match(result, /🤖/u);
	assert.match(result, /Child prompt/);
	assert.match(result, /Child answer/);
});

test("non-TUI extension sessions leave the native component prototypes untouched", () => {
	const userRender = UserMessageComponent.prototype.render;
	const assistantRender = AssistantMessageComponent.prototype.render;
	const handlers = new Map();
	sidePanel({ on(event, handler) { handlers.set(event, handler); }, registerCommand() {} });
	for (const mode of ["rpc", "json", "print"]) handlers.get("session_start")({}, { mode });
	assert.equal(UserMessageComponent.prototype.render, userRender);
	assert.equal(AssistantMessageComponent.prototype.render, assistantRender);
	handlers.get("session_shutdown")();
});

test("compatibility guard leaves native rendering untouched when the Pi component seam is missing", (t) => {
	const original = AssistantMessageComponent.prototype.render;
	const userRender = UserMessageComponent.prototype.render;
	AssistantMessageComponent.prototype.render = undefined;
	t.after(() => { AssistantMessageComponent.prototype.render = original; });
	assert.equal(installConversationFrames(() => themeModule.theme), undefined);
	assert.equal(UserMessageComponent.prototype.render, userRender);
});
