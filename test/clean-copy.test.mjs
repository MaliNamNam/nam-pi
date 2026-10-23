import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const entry = process.env.PI_TEST_PACKAGE_DIR
	? pathToFileURL(path.join(process.env.PI_TEST_PACKAGE_DIR, "dist/index.js")).href
	: import.meta.resolve("@earendil-works/pi-coding-agent");
const { createJiti } = await import(new URL("core/extensions/jiti-loader.js", entry));
const { VIRTUAL_MODULES } = await import(new URL("core/extensions/virtual-modules.js", entry));
const { AssistantMessageComponent, UserMessageComponent, initTheme } = VIRTUAL_MODULES["@earendil-works/pi-coding-agent"];
const { TuiAltScreen, stripTerminalSequences, visibleWidth } = VIRTUAL_MODULES["@earendil-works/pi-tui"];
const themeModule = await import(new URL("modes/interactive/theme/theme.js", entry));
const jiti = createJiti(import.meta.url, { virtualModules: VIRTUAL_MODULES, tryNative: false, moduleCache: false });
const extensionDir = new URL("../pi-side-panel/extensions/", import.meta.url);
const { installConversationFrames } = await jiti.import(new URL("slate/conversation-frames.ts", extensionDir).href);
const cleanCopy = await jiti.import(new URL("../clean-copy.ts", import.meta.url).href);
initTheme("dark", false);
// Patch before any screen assertions; the wrapper is what the tests exercise.
await cleanCopy.default();
const patched = TuiAltScreen.prototype.getActiveSelectionText;

const { stripFrameChrome } = cleanCopy;
const message = (content) => ({ role: "assistant", content, stopReason: "stop" });
function install(t) {
	const uninstall = installConversationFrames(() => themeModule.theme);
	assert.equal(typeof uninstall, "function");
	t.after(uninstall);
	return uninstall;
}

/** A minimal alt-screen carrying `previousScreen` rows, with a stubbed terminal. */
function screen(lines) {
	const ui = new TuiAltScreen({ columns: 64, rows: 40, write() {} }, false, undefined, { mouse: false });
	ui.previousScreen = lines;
	ui.flash = () => {};
	return ui;
}
function selectAll(ui, lines) {
	ui.selectionAnchor = { row: 0, col: 0 };
	ui.selectionFocus = { row: lines.length - 1, col: 1 << 20 };
}

test("framed content rows copy back as the message text", () => {
	assert.equal(stripFrameChrome("│ A user prompt       │"), "A user prompt");
	assert.equal(stripFrameChrome("   │ copied, which makes the copied text mangled.  │"), "copied, which makes the copied text mangled.");
	// A selection that starts mid-line keeps no trailing chrome either.
	assert.equal(stripFrameChrome("Hey man, the border frame is also   │"), "Hey man, the border frame is also");
	assert.equal(stripFrameChrome("plain text"), "plain text");
	assert.equal(stripFrameChrome(""), "");
});

test("border rows drop, inscribed titles keep their text", () => {
	assert.equal(stripFrameChrome("╭──────╮"), "");
	assert.equal(stripFrameChrome("   ╰──────╯"), "");
	assert.equal(stripFrameChrome("├─┼──┤"), "");
	assert.equal(stripFrameChrome("│"), "");
	assert.equal(stripFrameChrome("   ╭─ 👤 ──╮"), "");
	assert.equal(stripFrameChrome("╭─ write · src/main.ts ──╮"), "write · src/main.ts");
	// A framed markdown rule is border-shaped, and so is a bare `───` rule row.
	assert.equal(stripFrameChrome("│ ────── │"), "");
	assert.equal(stripFrameChrome("──────"), "");
});

test("nested frames peel while inner content survives", () => {
	assert.equal(stripFrameChrome("│ ╰────╯ │"), "");
	assert.equal(stripFrameChrome("│ ╭─ write · src/main.ts ─╮ │"), "write · src/main.ts");
	// One cell per side: markdown table edges stay, tree markers stay.
	assert.equal(stripFrameChrome("│ │ a │ b │ │"), "│ a │ b │");
	assert.equal(stripFrameChrome("│ │  ├── agents/ │"), "│  ├── agents/");
});

test("chrome-only selections report no selection", () => {
	const lines = ["   ╭─ 👤 ─╮", "   │ text │", "   ╰──────╯"];
	const ui = screen(lines);
	ui.selectionAnchor = { row: 2, col: 0 };
	ui.selectionFocus = { row: 2, col: visibleWidth(lines[2]) };
	assert.equal(ui.getActiveSelectionText(), undefined);
	assert.equal(ui.hasActiveSelection(), false);
});

test("framed user messages copy cleanly through the real pipeline", (t) => {
	install(t);
	const user = new UserMessageComponent("Please explain how this works.");
	const lines = user.render(64);
	assert.match(stripTerminalSequences(lines[0]), /^ {3}╭─+ 👤 ─╮$/u);
	const ui = screen(lines);
	selectAll(ui, lines);
	const copied = ui.getActiveSelectionText() ?? "";
	assert.equal(copied.trim(), "Please explain how this works.");
});

test("framed replies and thoughts copy without chrome", (t) => {
	install(t);
	const assistant = new AssistantMessageComponent(message([
		{ type: "thinking", thinking: "A private reasoning block" },
		{ type: "text", text: "An assistant answer" },
	]));
	const lines = assistant.render(64);
	const ui = screen(lines);
	selectAll(ui, lines);
	const copied = ui.getActiveSelectionText();
	assert.ok(copied);
	for (const line of copied.split("\n")) {
		assert.ok(!/^[│┃╭╮╰╯├┤─ ]+$/u.test(line), copied);
		assert.ok(!/^ *[│┃]/u.test(line), copied);
		assert.ok(!/[│┃] *$/u.test(line), copied);
	}
	assert.match(copied, /A private reasoning block/u);
	assert.match(copied, /An assistant answer/u);
});

test("markdown tables keep their cell pipes", (t) => {
	install(t);
	const assistant = new AssistantMessageComponent(message([
		{ type: "text", text: "| a | b |\n| --- | --- |\n| 1 | 2 |" },
	]));
	const lines = assistant.render(80);
	const ui = screen(lines);
	selectAll(ui, lines);
	const copied = ui.getActiveSelectionText() ?? "";
	const rows = copied.split("\n").filter((line) => line.includes("a"));
	assert.ok(rows.length > 0, copied);
	assert.ok(rows.every((row) => row.includes("│")), copied);
});

test("copy-on-select delivers the clean text to the clipboard", async (t) => {
	install(t);
	const user = new UserMessageComponent("A user prompt");
	const lines = user.render(64);
	const ui = screen(lines);
	selectAll(ui, lines);
	let captured;
	ui.copySelection = async (text) => {
		captured = text;
		return true;
	};
	assert.equal(await ui.copySelectionToClipboard(), true);
	assert.equal((captured ?? "").trim(), "A user prompt");
});

test("patching is idempotent", async () => {
	await cleanCopy.default();
	assert.equal(TuiAltScreen.prototype.getActiveSelectionText, patched);
	const lines = ["   │ text │"];
	const ui = screen(lines);
	ui.selectionAnchor = { row: 0, col: 0 };
	ui.selectionFocus = { row: 0, col: visibleWidth(lines[0]) };
	assert.equal(ui.getActiveSelectionText(), "text");
});
