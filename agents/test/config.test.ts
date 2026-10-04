import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { BUILTIN_AGENTS } from "../src/builtin.ts";
import { discoverAgents } from "../src/config.ts";

async function fixture(t: TestContext) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-config-"));
	const cwd = path.join(root, "project"), agentDir = path.join(root, "config"), xdg = path.join(root, "xdg");
	const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.XDG_CONFIG_HOME = xdg;
	t.after(async () => {
		for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
		await fs.rm(root, { recursive: true, force: true });
	});
	await fs.mkdir(cwd);
	const write = async (dir: string, name: string, value: unknown) => {
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
	};
	return { cwd, agentDir, xdg, write };
}

test("agent discovery ignores OpenCode JSON and JSONC configuration", async (t) => {
	const { cwd, xdg, write } = await fixture(t);
	for (const name of ["opencode.json", "opencode.jsonc"]) {
		await write(path.join(xdg, "opencode"), name, { agent: {
			explore: { model: "fixture/legacy", variant: "high" },
			"legacy-only": { mode: "subagent" },
		} });
	}
	const result = discoverAgents({ cwd });
	assert.equal(result.agents.find((agent) => agent.id === "explore")?.model, undefined);
	assert.equal(result.agents.some((agent) => agent.id === "legacy-only"), false);
	assert.equal(result.scanned.some((file) => file.includes("opencode")), false);
});

test("pi.json overrides coexist with provider settings and retain built-in subagent restrictions", async (t) => {
	const { cwd, agentDir, write } = await fixture(t);
	await write(agentDir, "pi.json", {
		provider: { fixture: { models: { small: { reasoning: true } } } },
		agent: {
			explore: { model: "fixture/small", variant: "max" },
			general: { model: "fixture/small", variant: "max" },
		},
	});
	const result = discoverAgents({ cwd });
	for (const id of ["explore", "general"]) {
		const agent = result.agents.find((entry) => entry.id === id)!;
		const builtin = BUILTIN_AGENTS.find((entry) => entry.id === id)!;
		assert.equal(agent.model, "fixture/small");
		assert.equal(agent.variant, "max");
		assert.equal(agent.mode, "subagent");
		assert.equal(agent.systemPrompt, builtin.systemPrompt);
		assert.deepEqual(agent.permissions, builtin.permissions);
		assert.equal(agent.filePath, path.join(agentDir, "pi.json"));
	}
	assert.equal(result.agents.some((agent) => agent.id === "scout"), false);
});

test("pi.jsonc overlays pi.json and reads only the agent section of a shared config", async (t) => {
	const { cwd, agentDir, write } = await fixture(t);
	await write(agentDir, "pi.json", { agent: {
		explore: { model: "fixture/json", variant: "low" },
		general: { model: "fixture/json" },
	} });
	await write(agentDir, "pi.jsonc", `{
		// The model extension owns the provider section, not the whole file.
		"provider": { "fixture": { "models": { "small": {} } } },
		"agent": {
			"explore": { "model": "fixture/jsonc", "variant": "max", },
			"general": { "variant": "max", },
		},
	}`);
	const result = discoverAgents({ cwd });
	assert.equal(result.agents.find((agent) => agent.id === "explore")?.model, "fixture/jsonc");
	assert.equal(result.agents.find((agent) => agent.id === "explore")?.variant, "max");
	assert.equal(result.agents.find((agent) => agent.id === "general")?.model, "fixture/json");
	assert.equal(result.agents.find((agent) => agent.id === "general")?.variant, "max");
	assert.ok(result.scanned.indexOf(path.join(agentDir, "pi.json")) < result.scanned.indexOf(path.join(agentDir, "pi.jsonc")));
});

test("project Pi configuration remains opt-in and pi.jsonc wins over pi.json", async (t) => {
	const { cwd, agentDir, write } = await fixture(t);
	await write(agentDir, "pi.jsonc", { agent: { explore: { model: "fixture/user", variant: "max" } } });
	await write(path.join(cwd, ".pi"), "pi.json", { agent: { explore: { model: "fixture/project-json" } } });
	assert.equal(discoverAgents({ cwd }).agents.find((agent) => agent.id === "explore")?.model, "fixture/user");
	assert.equal(discoverAgents({ cwd, agentScope: "both" }).agents.find((agent) => agent.id === "explore")?.model, "fixture/project-json");
	await write(path.join(cwd, ".pi"), "pi.jsonc", { agent: { explore: { model: "fixture/project-jsonc" } } });
	const both = discoverAgents({ cwd, agentScope: "both" }).agents.find((agent) => agent.id === "explore")!;
	assert.equal(both.model, "fixture/project-jsonc");
	assert.equal(both.variant, "max");
	const project = discoverAgents({ cwd, agentScope: "project" }).agents.find((agent) => agent.id === "explore")!;
	assert.equal(project.model, "fixture/project-jsonc");
	assert.equal(project.variant, undefined);
});

test("Pi JSON precedence, Markdown overrides and configured removal remain supported", async (t) => {
	const { cwd, agentDir, write } = await fixture(t);
	await write(agentDir, "settings.json", { agent: { explore: { model: "fixture/settings" } } });
	await write(agentDir, "safeguards.json", { agent: { explore: { model: "fixture/safeguards" } } });
	await write(agentDir, "pi.json", { agent: { explore: { model: "fixture/pi" }, general: { disabled: true } } });
	const json = discoverAgents({ cwd });
	assert.equal(json.agents.find((agent) => agent.id === "explore")?.model, "fixture/pi");
	assert.equal(json.agents.some((agent) => agent.id === "general"), false);
	await write(path.join(agentDir, "agents"), "explore.md", "---\nmodel: fixture/markdown\n---\nMarkdown prompt.");
	assert.equal(discoverAgents({ cwd }).agents.find((agent) => agent.id === "explore")?.model, "fixture/markdown");
	await write(path.join(cwd, ".pi"), "pi.jsonc", { agent: { explore: { model: "fixture/project" } } });
	assert.equal(discoverAgents({ cwd, agentScope: "both" }).agents.find((agent) => agent.id === "explore")?.model, "fixture/project");
});
