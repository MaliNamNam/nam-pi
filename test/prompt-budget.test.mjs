import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// Load real extension definitions without starting sessions or reading credentials.
const entry = process.env.PI_TEST_PACKAGE_DIR
	? pathToFileURL(path.join(process.env.PI_TEST_PACKAGE_DIR, "dist/index.js")).href
	: import.meta.resolve("@earendil-works/pi-coding-agent");
const { createJiti } = await import(new URL("core/extensions/jiti-loader.js", entry));
const { VIRTUAL_MODULES } = await import(new URL("core/extensions/virtual-modules.js", entry));
const jiti = createJiti(import.meta.url, { virtualModules: VIRTUAL_MODULES, tryNative: false, moduleCache: false });
const extension = await jiti.import(new URL("../agents/index.ts", import.meta.url).href, { default: true });
const tools = new Map();
extension({
	on() {}, registerFlag() {}, getFlag() {}, registerCommand() {}, registerMessageRenderer() {},
	registerTool(tool) { tools.set(tool.name, tool); },
	getActiveTools() { return [...tools.keys()]; },
});
const tool = tools.get("subagent");

test("subagent declaration stays below its conservative prompt budget", () => {
	const declaration = JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters });
	assert.ok(declaration.length <= 1400, `Subagent declaration is ${declaration.length} characters (budget: 1400)`);
});

test("compact guidance preserves dispatch, continuation, and model-selection rules", () => {
	assert.match(tool.description, /fresh context|no parent history/i);
	assert.match(tool.description, /foreground.*default/i);
	assert.match(tool.description, /foreground.*depends/i);
	assert.match(tool.description, /background.*immediately/i);
	assert.match(tool.description, /notifi/i);
	assert.match(tool.description, /sessionID.*continu/i);
	const guidelines = tool.promptGuidelines.join("\n");
	assert.match(guidelines, /specific non-overlapping work/);
	assert.match(guidelines, /Do not repeat delegated exploration/);
	assert.match(guidelines, /implementation or verification/);
	assert.match(guidelines, /Do not poll or sleep/);
	const { agent, description, model, sessionID, background } = tool.parameters.properties;
	assert.match(agent.description, /not.*(?:listed|available subagents)/i);
	assert.match(agent.description, /model/);
	assert.match(description.description, /3-5/);
	assert.match(model.description, /(?:NEVER|Only).*explicitly/i);
	assert.match(model.description, /providerID\/modelID#variant/);
	assert.match(model.description, /(?:not|never) guess/i);
	assert.match(sessionID.description, /(?:omit|without).*new|fresh/i);
	assert.match(background.description, /(?:not|NEVER).*sleep.*poll/i);
});

test("existing parameter contracts stay compatible and worktree isolation is optional", () => {
	assert.deepEqual([...tools.keys()].sort(), ["bash", "powershell", "questionnaire", "subagent"]);
	assert.deepEqual(tool.parameters.required, ["agent", "description", "prompt"]);
	assert.deepEqual(Object.keys(tool.parameters.properties), ["agent", "description", "prompt", "model", "sessionID", "background", "isolation"]);
	for (const name of ["agent", "description", "prompt", "model", "sessionID", "background"]) {
		assert.equal(tool.parameters.properties[name].type, name === "background" ? "boolean" : "string");
	}
	assert.deepEqual(tool.parameters.properties.isolation.anyOf.map((choice) => choice.const), ["shared", "worktree"]);
	assert.ok(!tool.parameters.required.includes("isolation"));
	assert.match(tool.parameters.properties.isolation.description, /Default shared/);
	assert.match(tool.promptGuidelines.join("\n"), /explicit user approval/);
	assert.equal(tool.exposure, undefined, "tools remain directly available by default");
	assert.equal(tool.promptSnippet, "Delegate a task to a specialized subagent");
	assert.equal(tools.get("questionnaire").parameters.properties.questions.minItems, 1);
});
