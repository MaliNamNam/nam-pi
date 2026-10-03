import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { initTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { completedSubagentResult, INLINE_OUTPUT_MAX_CHARS } from "../src/subagent-result.ts";
import agents from "../index.ts";

const knownModel = {
	provider: "local", id: "small", reasoning: true,
	thinkingLevelMap: { max: "max", xhigh: null },
};

test("dispatch rejects foreign sessions, unknown models and unavailable variants before spawning", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-dispatch-"));
	let execute: ((...args: any[]) => Promise<{ content: { text: string }[] }>) | undefined;
	let renderer: { renderCall: (...args: any[]) => { render(width: number): string[] }; renderResult: (...args: any[]) => { render(width: number): string[] } } | undefined;
	const handlers = new Map<string, (...args: any[]) => any>();
	const pi = {
		on: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, handler); },
		registerFlag: () => {}, getFlag: () => undefined,
		registerTool: (tool: { name: string; execute: typeof execute; renderCall: any; renderResult: any }) => {
			if (tool.name === "subagent") { execute = tool.execute; renderer = tool; }
		},
		registerCommand: () => {}, registerMessageRenderer: () => {},
		getActiveTools: () => ["read", "subagent"], setActiveTools: () => {},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd, hasUI: false, isIdle: () => true,
		modelRegistry: { getAvailable: () => [knownModel] },
		model: knownModel,
		sessionManager: {
			getSessionId: () => "parent-a",
			getSessionFile: () => path.join(cwd, "parent.jsonl"),
			getSessionDir: () => path.join(cwd, "sessions"),
		},
	} as unknown as ExtensionContext;
	try {
		agents(pi);
		handlers.get("session_start")?.({}, ctx);
		assert.ok(execute);
		assert.ok(renderer);
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		assert.match(renderer.renderCall({ agent: "explore", description: "Find auth code" }, theme).render(80).join("\n"), /Find auth code/);
		assert.match(renderer.renderResult({ content: [{ type: "text", text: "working" }], details: {
			sessionID: "sub-explore-test", status: "running", agent: "explore", description: "Find auth code",
			progress: ["→ read src/auth.ts"],
		} }, { expanded: true }, theme).render(80).join("\n"), /read src\/auth.ts/);
		initTheme("dark", false);
		const largeOutput = "**Restored output**\n\n" + "x".repeat(INLINE_OUTPUT_MAX_CHARS);
		const restored = JSON.parse(JSON.stringify(completedSubagentResult(largeOutput, {
			sessionID: "sub-explore-test", status: "completed", agent: "explore", description: "Large result",
		})));
		const expanded = stripTerminalSequences(renderer.renderResult(restored, { expanded: true }, theme).render(80).join("\n"));
		assert.match(expanded, /Restored output/);
		assert.doesNotMatch(expanded, /<subagent|<\/subagent>/, "only the output body should be rendered");
		assert.equal(renderer.renderResult(restored, { expanded: false }, theme).render(80).join(""), "");
		const invoke = async (more: Record<string, unknown>) => {
			const result = await execute!("test", { agent: "explore", prompt: "Find files", description: "Search files", ...more }, new AbortController().signal, undefined, ctx);
			return result.content[0].text;
		};
		assert.match(await invoke({ sessionID: "foreign" }), /not found or not a child/);
		assert.match(await invoke({ model: "invalid" }), /Invalid model/);
		assert.match(await invoke({ model: "local/missing" }), /is not available/);
		assert.match(await invoke({ model: "local/small#xhigh" }), /Variant.*not available/);
		assert.match(await invoke({ model: "local/small#unknown" }), /Variant.*not available/);
		assert.equal((await fs.readdir(cwd)).includes("sessions"), false, "invalid requests must not reserve a child");
	} finally {
		handlers.get("session_shutdown")?.({}, ctx);
		await fs.rm(cwd, { recursive: true, force: true });
	}
});
