import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// Render actual child-page/sidebar components with synthetic data, never launching agents.
const entry = process.env.PI_TEST_PACKAGE_DIR
	? pathToFileURL(path.join(process.env.PI_TEST_PACKAGE_DIR, "dist/index.js")).href
	: import.meta.resolve("@earendil-works/pi-coding-agent");
const { createJiti } = await import(new URL("core/extensions/jiti-loader.js", entry));
const { VIRTUAL_MODULES } = await import(new URL("core/extensions/virtual-modules.js", entry));
const jiti = createJiti(import.meta.url, { virtualModules: VIRTUAL_MODULES, tryNative: false, moduleCache: false });
const { ChildSessionPage } = await jiti.import(new URL("../agents/src/view.ts", import.meta.url).href);
const { ChildWorkspacePage } = await jiti.import(new URL("../pi-side-panel/extensions/agents-ui.ts", import.meta.url).href);
const { initTheme } = VIRTUAL_MODULES["@earendil-works/pi-coding-agent"];
const { getKeybindings, stripTerminalSequences, visibleWidth } = VIRTUAL_MODULES["@earendil-works/pi-tui"];
const themeModule = await import(new URL("modes/interactive/theme/theme.js", entry));
initTheme("dark", false);

function render(width, branch, snapshotName) {
	const theme = themeModule.theme;
	const tui = { terminal: { rows: 30, columns: width }, requestRender() {} };
	const children = [{ id: "child", agent: "General", title: "Update authentication", status: "running", current: true }];
	const data = { entries: [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Authentication changes are isolated and ready for review." }] } }],
		model: { provider: "fixture", id: "small", contextWindow: 32000 }, stats: { spend: 0, tokens: 1200, cacheHitRate: 0, files: ["src/auth.ts"], tools: ["read", "write"] } };
	const cwd = path.resolve("fixture-workspace");
	const page = new ChildSessionPage(tui, theme, getKeybindings(), "child", data, () => {}, { cwd, title: "General: Update authentication", children,
		viewChild() {}, interruptChild: async () => "fixture" });
	const decorated = new ChildWorkspacePage({ sessionID: "parent", childID: "child", cwd, branch, tui, theme, page, component: page, viewChild() {} },
		{ ui: { theme }, modelRegistry: { find() {} } }, { hidden: () => false, width: () => 32, branch: () => "main", files: () => [], resources: () => ({}), persistWidth() {} });
	try {
		const lines = decorated.render(width);
		if (process.env.WORKTREE_UI_SNAPSHOT_DIR) {
			mkdirSync(process.env.WORKTREE_UI_SNAPSHOT_DIR, { recursive: true });
			writeFileSync(path.join(process.env.WORKTREE_UI_SNAPSHOT_DIR, `${snapshotName}.json`), JSON.stringify(lines));
		}
		assert.equal(lines.length, 30);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), "child workspace must fit its viewport");
		return lines.map(stripTerminalSequences).join("\n");
	} finally { decorated.dispose(); }
}

test("shared child pages retain the parent branch and existing composer/sidebar layout", () => {
	const text = render(120, undefined, "shared");
	assert.match(text, /main/);
	assert.match(text, /Context/);
	assert.match(text, /Subagents/);
});

test("isolated child pages display their own branch rather than the parent's branch", () => {
	const text = render(120, "pi-agent/child", "isolated");
	assert.match(text, /pi-agent\/child/);
	assert.doesNotMatch(text, /\bmain\b/);
});

test("isolated child pages remain bounded on narrow terminals", () => {
	assert.match(render(60, "pi-agent/child", "narrow"), /Subagents/);
});
