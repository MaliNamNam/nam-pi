import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import { BUILTIN_AGENTS } from "../src/builtin.ts";
import { blockedByRules } from "../src/enforce.ts";
import { DEFAULT_AGENT_PERMISSIONS, evaluate, explicitlyAllowedTools, filterToolNames } from "../src/permissions.ts";

const rules = (id: string) => [...DEFAULT_AGENT_PERMISSIONS, ...BUILTIN_AGENTS.find((agent) => agent.id === id)!.permissions];
const registered = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls", "web_access", "vcc_recall", "questionnaire", "subagent"];

test("explore asks for external directories instead of denying them, like V2", () => {
	assert.equal(evaluate("external_directory", `${os.tmpdir().replaceAll("\\", "/")}/*`, rules("explore")).effect, "ask");
	const outside = blockedByRules(rules("explore"), { toolName: "read", input: { path: os.homedir() } }, { cwd: process.cwd(), enforceExternal: true });
	assert.match(outside ?? "", /^External directory requires approval/);
});

test("explore offers read-only search, web and recall tools, never shell, edits or nesting", () => {
	const offered = filterToolNames(rules("explore"), registered);
	assert.deepEqual(offered, ["read", "grep", "find", "ls", "web_access", "vcc_recall"]);
	assert.deepEqual(explicitlyAllowedTools(rules("explore"), registered), ["read", "grep", "find", "ls", "web_access", "vcc_recall"]);
});

test("general and explore may run web_access and vcc_recall in a child", () => {
	for (const id of ["general", "explore"]) {
		for (const toolName of ["web_access", "vcc_recall"]) {
			assert.equal(blockedByRules(rules(id), { toolName, input: { input: "query" } }, { cwd: process.cwd(), enforceExternal: true }), undefined, `${id} ${toolName}`);
		}
	}
	// A blanket allow does not activate tools that Pi's selection leaves off.
	assert.deepEqual(explicitlyAllowedTools(rules("general"), registered), ["vcc_recall"]);
});
