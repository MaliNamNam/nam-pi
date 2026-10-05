import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// Exercise real presentation components without launching agents or opening sessions.
const entry = process.env.PI_TEST_PACKAGE_DIR
	? pathToFileURL(path.join(process.env.PI_TEST_PACKAGE_DIR, "dist/index.js")).href
	: import.meta.resolve("@earendil-works/pi-coding-agent");
const { createJiti } = await import(new URL("core/extensions/jiti-loader.js", entry));
const { VIRTUAL_MODULES } = await import(new URL("core/extensions/virtual-modules.js", entry));
const jiti = createJiti(import.meta.url, { virtualModules: VIRTUAL_MODULES, tryNative: false, moduleCache: false });
const extensions = process.env.SUBAGENT_SIDEBAR_EXTENSION_DIR
	? pathToFileURL(path.resolve(process.env.SUBAGENT_SIDEBAR_EXTENSION_DIR) + path.sep)
	: new URL("../", import.meta.url);
const { Sidebar } = await jiti.import(new URL("pi-side-panel/extensions/slate/sidebar.ts", extensions).href);
const { ChildSessionPage } = await jiti.import(new URL("agents/src/view.ts", extensions).href);
const { ChildWorkspacePage } = await jiti.import(new URL("pi-side-panel/extensions/agents-ui.ts", extensions).href);
const { initTheme } = VIRTUAL_MODULES["@earendil-works/pi-coding-agent"];
const { getKeybindings, sliceByColumn, stripTerminalSequences, visibleWidth } = VIRTUAL_MODULES["@earendil-works/pi-tui"];
const themeModule = await import(new URL("modes/interactive/theme/theme.js", entry));
initTheme("dark", false);

const attempt = (id, status, fields = {}) => ({ id, parentID: "parent", agent: "Explore", title: "Map clip quality gates", status, ...fields });
const rows = (lines) => lines.map(stripTerminalSequences).filter((line) => /[●✓✗■] /.test(line));
function capture(lines, name) {
	const directory = process.env.SUBAGENT_SIDEBAR_SNAPSHOT_DIR;
	if (!directory) return;
	mkdirSync(directory, { recursive: true });
	writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(lines));
}
function rootPanel(children) {
	const sidebar = new Sidebar();
	const viewed = [];
	sidebar.bind({ terminal: { rows: 40, columns: 140 }, requestRender() {} }, themeModule.theme);
	sidebar.setActions({ viewSubagent(id) { viewed.push(id); } });
	sidebar.setSubagents(children);
	return { sidebar, viewed, render: () => sidebar.render(48, 40, 4) };
}

test("sidebar hides a cancelled attempt replaced by a completed sibling without changing history", () => {
	const children = [attempt("completed", "completed"), attempt("cancelled", "cancelled")];
	const original = structuredClone(children);
	const { sidebar, viewed, render } = rootPanel(children);
	try {
		const lines = render();
		capture(lines, "replaced-completed");
		assert.deepEqual(children, original, "saved/composer children must not be filtered in place");
		assert.equal(rows(lines).length, 1);
		assert.match(rows(lines)[0], /✓ Explore: Map clip quality gates/);
		assert.match(lines.map(stripTerminalSequences).join("\n"), /Subagents · 0 running/);
		const y = lines.findIndex((line) => stripTerminalSequences(line).includes("✓ Explore:"));
		sidebar.handleMouse({ type: "click", button: "left", x: 8, y, width: 48, height: 40, screenX: 8 });
		assert.deepEqual(viewed, ["completed"], "the remaining row must open the replacement's ID");
		sidebar.handleMouse({ type: "click", button: "left", x: 8, y: y + 1, width: 48, height: 40, screenX: 8 });
		assert.deepEqual(viewed, ["completed"], "the hidden row must not leave a click target");
	} finally { sidebar.dispose(); }
});

test("running replacements hide cancelled siblings and failed replacements reveal them again", () => {
	const cancelled = attempt("cancelled", "cancelled");
	const { sidebar, render } = rootPanel([cancelled, attempt("replacement", "running")]);
	try {
		assert.equal(rows(render()).length, 1);
		assert.match(render().map(stripTerminalSequences).join("\n"), /Subagents · 1 running/);
		sidebar.setSubagents([cancelled, attempt("replacement", "completed")]);
		assert.equal(rows(render()).length, 1);
		assert.match(rows(render())[0], /✓/);
		sidebar.setSubagents([cancelled, attempt("replacement", "error")]);
		assert.equal(rows(render()).length, 2);
		sidebar.setSubagents([cancelled]);
		assert.equal(rows(render()).length, 1);
		assert.match(rows(render())[0], /■/);
	} finally { sidebar.dispose(); }
});

test("separate running and completed sessions with matching labels retain their own rows", () => {
	const { sidebar, render } = rootPanel([attempt("one", "running"), attempt("two", "running"), attempt("three", "completed"), attempt("four", "completed")]);
	try {
		assert.equal(rows(render()).length, 4);
		assert.match(render().map(stripTerminalSequences).join("\n"), /Subagents · 2 running/);
	} finally { sidebar.dispose(); }
});

test("cancelled attempts without a matching live or completed sibling remain visible", () => {
	const cancelled = attempt("cancelled", "cancelled");
	const { sidebar, render } = rootPanel([cancelled]);
	try {
		for (const other of [
			attempt("different-parent", "completed", { parentID: "another-parent", prefix: "└─ " }),
			attempt("different-agent", "completed", { agent: "General" }),
			attempt("different-task", "completed", { title: "Map audio gates" }),
			attempt("failed", "error"),
			attempt("also-cancelled", "cancelled"),
		]) {
			sidebar.setSubagents([cancelled, other]);
			assert.equal(rows(render()).length, 2, `${other.id} must not hide the cancelled attempt`);
		}
	} finally { sidebar.dispose(); }
});

test("older presentation data without parent IDs is not assumed to contain siblings", () => {
	const { sidebar, render } = rootPanel([attempt("cancelled", "cancelled", { parentID: undefined }), attempt("completed", "completed", { parentID: undefined })]);
	try { assert.equal(rows(render()).length, 2); }
	finally { sidebar.dispose(); }
});

for (const width of [160, 60]) {
	test(`child preview hides the replaced attempt only in its sidebar at width ${width}`, () => {
		const children = [attempt("completed", "completed", { current: true }), attempt("cancelled", "cancelled")];
		const tui = { terminal: { rows: 30, columns: width }, requestRender() {} };
		const cwd = path.resolve("fixture-workspace");
		const page = new ChildSessionPage(tui, themeModule.theme, getKeybindings(), "completed", ["Replacement completed."], () => {}, {
			cwd, title: "Explore: Map clip quality gates", children, viewChild() {}, interruptChild: async () => "fixture",
		});
		const decorated = new ChildWorkspacePage({ sessionID: "parent", childID: "completed", cwd, tui, theme: themeModule.theme, page, component: page, viewChild() {} },
			{ ui: { theme: themeModule.theme }, modelRegistry: { find() {} } },
			{ hidden: () => false, width: () => 32, branch: () => "main", files: () => [], resources: () => ({}), persistWidth() {} });
		try {
			const lines = decorated.render(width);
			capture(lines, `child-${width}`);
			assert.equal(lines.length, 30);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			const pane = lines.map((line) => sliceByColumn(line, decorated.chatWidth, decorated.paneWidth));
			assert.equal(rows(pane).length, 1);
			assert.match(rows(pane)[0], /✓ Explore:/);
			assert.deepEqual(page.snapshot.children, children, "the full family remains available for inspection");
			page.handleInput("\x01"); // Ctrl+A shows inactive sessions in the composer.
			assert.equal((page.render(120).map(stripTerminalSequences).join("\n").match(/Explore: Map clip quality gates/g) ?? []).length, 3,
				"both inactive attempts remain in the composer, alongside the child-page title");
		} finally { decorated.dispose(); }
	});
}
