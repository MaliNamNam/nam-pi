import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { clampPiVariant, selectChildModel } from "../src/models.ts";
import { restoreSubagentModels, SUBAGENT_MODELS_TYPE } from "../src/subagent-models.ts";

const receipt = (agent: string, model: unknown) => ({ type: "custom", customType: SUBAGENT_MODELS_TYPE, data: { agent, model } }) as SessionEntry;

test("session-wide assignments restore each role's latest receipt regardless of tree branch", () => {
	const entries = [receipt("explore", "fixture/alpha#high"), receipt("general", "fixture/beta#low"),
		{ ...receipt("explore", "fixture/beta#max"), parentId: "another-branch" }];
	const models = restoreSubagentModels(entries);
	assert.equal(models.get("explore"), "fixture/beta#max");
	assert.equal(models.get("general"), "fixture/beta#low");
	assert.equal(restoreSubagentModels([]).size, 0, "separate new sessions start from config defaults");
});

test("resets retain an explicit follow-defaults marker and malformed receipts do not overwrite valid settings", () => {
	const models = restoreSubagentModels([receipt("explore", "fixture/alpha#high"), receipt("explore", "invalid"),
		receipt("general", "fixture/beta#low"), receipt("general", null), receipt("explore", 7),
		{ ...receipt("explore", "fixture/beta"), customType: "unrelated" } as SessionEntry]);
	assert.equal(models.get("explore"), "fixture/alpha#high");
	assert.equal(models.get("general"), null);
});

test("configured Pi thinking levels take precedence over variants and apply without an agent model override", () => {
	assert.deepEqual(selectChildModel({ agent: { id: "explore", model: "fixture/alpha", thinkingLevel: "high", variant: "low" }, parentThinking: "medium" }),
		{ model: "fixture/alpha", thinkingLevel: "high" });
	assert.deepEqual(selectChildModel({ agent: { id: "general", thinkingLevel: "low" }, parentModel: "fixture/alpha", parentThinking: "medium" }),
		{ model: "fixture/alpha", thinkingLevel: "low" });
	assert.deepEqual(selectChildModel({ agent: { id: "general", thinkingLevel: "low" }, previousAgent: "explore", parentThinking: "medium" }),
		{ model: undefined, thinkingLevel: "low" });
});

test("explicit tool model choices retain precedence and untouched continuations preserve their saved selection", () => {
	const agent = { id: "explore", model: "fixture/alpha", thinkingLevel: "high" };
	assert.deepEqual(selectChildModel({ agent, explicitModel: "fixture/beta", explicitThinking: "low", parentThinking: "medium" }),
		{ model: "fixture/beta", thinkingLevel: "low" });
	assert.deepEqual(selectChildModel({ agent, previousAgent: "explore", parentModel: "fixture/beta" }),
		{ model: undefined, thinkingLevel: undefined });
});

test("thinking changes clamp to supported levels and non-reasoning models remain off", () => {
	assert.equal(clampPiVariant({ reasoning: false }, "high"), "off");
	assert.equal(clampPiVariant({ reasoning: true }, "max"), "high");
	assert.equal(clampPiVariant({ reasoning: true, thinkingLevelMap: { low: null, medium: null } }, "low"), "high");
	assert.equal(clampPiVariant({ reasoning: true }, "unknown"), "off");
});
