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
const jiti = createJiti(import.meta.url, { virtualModules: VIRTUAL_MODULES, tryNative: false, moduleCache: false });
const extensions = process.env.SUBAGENT_MODELS_EXTENSION_DIR
	? pathToFileURL(path.resolve(process.env.SUBAGENT_MODELS_EXTENSION_DIR) + path.sep)
	: new URL("../", import.meta.url);
const { Sidebar } = await jiti.import(new URL("pi-side-panel/extensions/slate/sidebar.ts", extensions).href);
const { SubagentModelPicker } = await jiti.import(new URL("agents/src/subagent-model-picker.ts", extensions).href);
const { ChildSessionPage } = await jiti.import(new URL("agents/src/view.ts", extensions).href);
const { ChildWorkspacePage } = await jiti.import(new URL("pi-side-panel/extensions/agents-ui.ts", extensions).href);
const { clampPiVariant } = await jiti.import(new URL("agents/src/models.ts", extensions).href);
const { initTheme } = VIRTUAL_MODULES["@earendil-works/pi-coding-agent"];
const { KeybindingsManager } = await import(new URL("core/keybindings.js", entry));
const { getKeybindings, stripTerminalSequences, visibleWidth } = VIRTUAL_MODULES["@earendil-works/pi-tui"];
const { clampThinkingLevel } = VIRTUAL_MODULES["@earendil-works/pi-ai"];
const themeModule = await import(new URL("modes/interactive/theme/theme.js", entry));
initTheme("dark", false);

function snapshot(name, lines) {
	const directory = process.env.SUBAGENT_MODELS_SNAPSHOT_DIR;
	if (!directory) return;
	mkdirSync(directory, { recursive: true });
	writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(lines));
}

test("Subagents heading opens its settings even before any children have been launched", () => {
	const sidebar = new Sidebar();
	let opened = 0;
	sidebar.bind({ terminal: { rows: 30, columns: 140 }, requestRender() {} }, themeModule.theme);
	sidebar.setActions({ openSubagents() { opened++; } });
	try {
		const lines = sidebar.render(48, 30, 4);
		snapshot("empty-sidebar", lines);
		assert.ok(lines.every((line) => visibleWidth(line) <= 48));
		const y = lines.findIndex((line) => stripTerminalSequences(line).includes("Subagents ·"));
		assert.ok(y >= 0);
		sidebar.handleMouse({ type: "click", button: "left", x: 8, y, width: 48, height: 30, screenX: 8 });
		assert.equal(opened, 1);
	} finally { sidebar.dispose(); }
});

const model = (id, reasoning = true) => ({ provider: "fixture", id, name: id, api: "openai-completions", reasoning,
	thinkingLevelMap: reasoning ? { max: "max", xhigh: null } : undefined, input: ["text"], contextWindow: 32000, maxTokens: 256,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
function pickerFixture(saveError) {
	const alpha = model("alpha"), beta = model("beta", false), models = [alpha, beta];
	const entries = ["explore", "general", "scout"].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), model: alpha,
		reference: "fixture/alpha", thinkingLevel: "high", overridden: false }));
	const saves = [];
	let closed = 0;
	const registry = { getAvailable: () => models, find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
		getError() {}, refresh: async () => ({ errors: new Map(), aborted: false }) };
	const picker = new SubagentModelPicker({ terminal: { rows: 30, columns: 120 }, requestRender() {} }, themeModule.theme, {
		keys: new KeybindingsManager(), registry, entries: () => entries,
		async save(id, reference) {
			if (saveError) throw new Error(saveError);
			saves.push({ id, reference });
			const entry = entries.find((entry) => entry.id === id);
			const [ref, thinkingLevel] = (reference ?? "fixture/alpha#high").split("#");
			entry.model = registry.find(...ref.split("/"));
			entry.reference = ref; entry.thinkingLevel = thinkingLevel; entry.overridden = reference !== null;
		}, close() { closed++; },
	});
	return { picker, entries, saves, closed: () => closed };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

for (const width of [80, 42]) {
	test(`popup lists each agent's model, thinking and default/session source at width ${width}`, async () => {
		const { picker, saves } = pickerFixture();
		try {
			const lines = picker.render(width);
			snapshot(`popup-${width}`, lines);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			const text = lines.map(stripTerminalSequences).join("\n");
			for (const name of ["Explore", "General", "Scout"]) assert.match(text, new RegExp(name));
			assert.match(text, /fixture\/alpha · high/);
			picker.handleInput("\x1b[Z"); // Shift+Tab: cycle only the selected role's thinking.
			await flush();
			assert.deepEqual(saves, [{ id: "explore", reference: "fixture/alpha#max" }]);
			assert.match(picker.render(width).map(stripTerminalSequences).join("\n"), /Explore · session/);
		} finally { picker.dispose(); }
	});
}

test("model selection uses native search, clamps thinking, and never offers a global-default save action", async () => {
	const { picker, saves } = pickerFixture();
	try {
		picker.focused = true;
		picker.handleInput("\r");
		assert.equal(picker.picker.getSearchInput().focused, true, "popup focus must reach the native input");
		const lines = picker.render(80);
		snapshot("native-model-search", lines);
		assert.ok(lines.every((line) => visibleWidth(line) <= 80));
		assert.doesNotMatch(lines.map(stripTerminalSequences).join("\n"), /set as default/);
		picker.handleInput("beta");
		picker.handleInput("\x13");
		assert.deepEqual(saves, [], "Ctrl+S cannot write a global default from this picker");
		picker.handleInput("\r");
		await flush();
		assert.deepEqual(saves, [{ id: "explore", reference: "fixture/beta#off" }]);
		picker.handleInput("\x1b[Z");
		assert.equal(saves.length, 1, "non-reasoning models have no other thinking level");
	} finally { picker.dispose(); }
});

test("mouse rows select the correct agent and reset affects only that session assignment", async () => {
	const { picker, saves } = pickerFixture();
	try {
		const lines = picker.render(80), y = lines.findIndex((line) => stripTerminalSequences(line).includes("General · default"));
		picker.handleMouse({ type: "click", button: "left", x: 8, y, width: 80, height: lines.length, screenX: 8 });
		picker.handleInput("beta"); picker.handleInput("\r");
		await flush();
		picker.handleInput("\x12"); // Ctrl+R: follow config defaults again.
		await flush();
		assert.deepEqual(saves, [{ id: "general", reference: "fixture/beta#off" }, { id: "general", reference: null }]);
	} finally { picker.dispose(); }
});

test("cancel backs out of search without saving, then closes the popup", () => {
	const { picker, saves, closed } = pickerFixture();
	try {
		picker.handleInput("\r"); picker.handleInput("beta"); picker.handleInput("\x1b");
		assert.equal(closed(), 0); assert.deepEqual(saves, []);
		assert.match(picker.render(80).map(stripTerminalSequences).join("\n"), /Subagent models/);
		picker.handleInput("\x1b");
		assert.equal(closed(), 1);
	} finally { picker.dispose(); }
});

test("assignment failures remain visible and disposal closes the native picker", async () => {
	const { picker } = pickerFixture("Fixture model update failed");
	picker.handleInput("\x1b[Z"); await flush();
	assert.match(picker.render(80).map(stripTerminalSequences).join("\n"), /Fixture model update failed/);
	picker.handleInput("\r"); const native = picker.picker;
	picker.dispose(); assert.equal(native.closed, true);
});

test("many configured roles scroll within the popup and custom thinking keybindings work", async () => {
	const { picker, entries, saves } = pickerFixture();
	try {
		for (let i = 0; i < 12; i++) entries.push({ ...entries[0], id: `extra-${i}`, name: `Extra ${i}` });
		for (let i = 0; i < 14; i++) picker.handleInput("\x1b[B");
		const lines = picker.render(80);
		assert.ok(lines.length <= 27, "rows must fit the configured 90% popup height");
		assert.match(lines.map(stripTerminalSequences).join("\n"), /Extra 11/);
		picker.options.keys = new KeybindingsManager({ "app.thinking.cycle": "ctrl+y" });
		picker.handleInput("\x19"); await flush();
		assert.deepEqual(saves, [{ id: "extra-11", reference: "fixture/alpha#max" }]);
	} finally { picker.dispose(); }
});

test("native model search keeps the selected long ID visible inside a short, narrow popup", async () => {
	const { picker, entries, saves } = pickerFixture();
	try {
		const models = Array.from({ length: 10 }, (_, index) => model(`long-provider-model-${index}-${"identifier-".repeat(5)}`));
		picker.options.registry.getAvailable = () => models;
		picker.options.registry.find = (provider, id) => models.find((model) => model.provider === provider && model.id === id);
		entries[0].model = models[9]; entries[0].reference = `fixture/${models[9].id}`;
		picker.handleInput("\r");
		const lines = picker.render(42);
		snapshot("long-model-search-42", lines);
		assert.ok(lines.length <= 27, `native search must fit its 90% viewport, got ${lines.length}`);
		assert.ok(lines.every((line) => visibleWidth(line) <= 42));
		assert.ok(lines.some((line) => stripTerminalSequences(line).startsWith("→ ")), "Enter's selected model must be on screen");
		assert.match(lines.map(stripTerminalSequences).join("\n"), /long-provider-model-9/);
		picker.handleInput("\r"); await flush();
		assert.equal(saves[0].reference, `fixture/${models[9].id}#high`);
	} finally { picker.dispose(); }
});

test("native mouse coordinates follow the cropped viewport without taking thinking-key focus", () => {
	const { picker, entries } = pickerFixture();
	try {
		const models = Array.from({ length: 10 }, (_, index) => model(`long-model-${index}-${"identifier-".repeat(5)}`));
		picker.options.registry.getAvailable = () => models;
		entries[0].model = models[9];
		picker.handleInput("\r");
		const lines = picker.render(42), native = picker.picker.render(42);
		const y = lines.findIndex((line) => stripTerminalSequences(line).startsWith("→ "));
		let received;
		picker.picker.handleMouse = (event) => { received = event; return { handled: true, focus: true, focusTarget: picker.picker }; };
		const result = picker.handleMouse({ type: "click", button: "left", x: 0, y, width: 42, height: lines.length, screenX: 0 });
		assert.equal(received.y, native.findIndex((line) => stripTerminalSequences(line).startsWith("→ ")));
		assert.equal(received.height, native.length);
		assert.deepEqual(result, { handled: true, focus: true }, "the outer role-settings component must retain focus");
	} finally { picker.dispose(); }
});

test("thinking clamping exactly matches Pi's native policy", () => {
	for (const candidate of [model("alpha"), model("beta", false), { ...model("restricted"), thinkingLevelMap: { low: null, medium: null, max: "max" } }]) {
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "unknown"]) {
			assert.equal(clampPiVariant(candidate, level), clampThinkingLevel(candidate, level));
		}
	}
});

test("child workspace heading opens the same parent-scoped settings callback", () => {
	let opened = 0;
	const tui = { terminal: { rows: 30, columns: 140 }, requestRender() {} }, cwd = path.resolve("fixture-workspace");
	const page = new ChildSessionPage(tui, themeModule.theme, getKeybindings(), "child", ["Fixture child."], () => {}, {
		cwd, title: "Explore: Fixture", children: [], viewChild() {}, interruptChild: async () => "fixture",
	});
	const decorated = new ChildWorkspacePage({ sessionID: "parent", childID: "child", cwd, tui, theme: themeModule.theme, page, component: page, viewChild() {} },
		{ ui: { theme: themeModule.theme }, modelRegistry: { find() {} } }, {
			hidden: () => false, width: () => 32, branch: () => "main", files: () => [], resources: () => ({}), persistWidth() {}, openSubagentModels() { opened++; },
		});
	try {
		const lines = decorated.render(140), y = lines.findIndex((line) => stripTerminalSequences(line).includes("Subagents ·"));
		decorated.handleMouse({ type: "click", button: "left", x: decorated.chatWidth + 8, y, width: 140, height: 30, screenX: decorated.chatWidth + 8 });
		assert.equal(opened, 1);
	} finally { decorated.dispose(); }
});
