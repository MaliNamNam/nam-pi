/**
 * OpenCode-style Safeguards for Pi
 *
 * Ports OpenCode's permission system (v2) to Pi as an extension:
 *
 *   read / edit / glob / grep / list / bash / task / skill / lsp / question /
 *   webfetch / websearch / external_directory / doom_loop
 *
 * Each permission resolves to `allow`, `ask`, or `deny`. `ask` prompts with
 * Allow once / Always allow / Reject; `always` persists a pattern for the
 * project, matching OpenCode's saved-permission behavior.
 *
 * Configuration (all optional) lives in `<agent-dir>/safeguards.json`,
 * `<agent-dir>/pi.jsonc`, `<agent-dir>/settings.json`, or the project's
 * `.pi/safeguards.json` / `.pi/settings.json`:
 *
 * ```jsonc
 * {
 *   "permission": {
 *     "*": "allow",
 *     "bash": { "*": "ask", "git *": "allow", "rm *": "deny" },
 *     "edit": { "*": "ask", "docs/**": "allow" },
 *     "webfetch": { "*": "ask", "https://en.wikipedia.org/*": "allow" }
 *   },
 *   "permissionFallback": "ask",
 *   "safeguards": { "doomLoop": true, "doomLoopThreshold": 3 }
 * }
 * ```
 *
 * Commands: `/safeguards`, `/safeguards show`, `/safeguards reset`,
 * `/safeguards auto`, `/safeguards deny <action> [resource]`,
 * `/safeguards allow <action> [resource]`, `/safeguards check <action> <resource>`.
 */

import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { SafeguardEngine, describe, truncate, type SafeguardResult, type ToolRequest } from "./src/engine.ts";
import { buildGenericPathRequest, buildPathRequest, buildShellRequest } from "./src/requests.ts";
import { findApprovalBridge, registerPermissionPolicy } from "./src/approval-bridge.ts";
import { matchWildcard, toPosix } from "./src/rules.ts";

/** Tools whose call itself is a permission decision in OpenCode. */
const PASSTHROUGH_ACTIONS: Record<string, string> = {
	webfetch: "webfetch",
	websearch: "websearch",
	question: "question",
	questionnaire: "question",
	task: "task",
	subagent: "subagent",
	skill: "skill",
	lsp: "lsp",
};

export default function safeguards(pi: ExtensionAPI): void {
	// The factory runs before the session cwd is bound, so the engine is created
	// on the first session_start and refreshed on every later one.
	let engine = createEngine();
	registerPermissionPolicy(pi, () => engine, buildRequest);

	pi.registerFlag("safeguards-auto", {
		description: "Auto-approve safeguards permission requests that are not denied",
		type: "boolean",
	});

	/* -------------------------------------------------------------- */
	/* Status line                                                    */
	/* -------------------------------------------------------------- */

	const updateStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		// "on" is the default; only surface non-default auto-approve in the footer.
		ctx.ui.setStatus("safeguards", engine.auto ? "safeguards: auto" : undefined);
	};

	pi.on("session_start", (_event, ctx) => {
		engine = createEngine(ctx.cwd, pi);
		updateStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("safeguards", undefined);
	});

	/* -------------------------------------------------------------- */
	/* Tool interception                                              */
	/* -------------------------------------------------------------- */

	pi.on("tool_call", async (event, ctx) => {
		const bridge = findApprovalBridge(pi);
		if (bridge) return bridge.guard(event, ctx);
		const request = buildRequest(engine, event);
		const doom = await checkDoomLoop(engine, event, ctx);

		if (doom?.block) return block(doom);
		if (!request) return undefined;

		const guarded = await engine.guard(request, ctx);
		if (guarded.block) return block(guarded);
		return undefined;
	});

	/* -------------------------------------------------------------- */
	/* Commands                                                       */
	/* -------------------------------------------------------------- */

	pi.registerCommand("safeguards", {
		description: "Show or change permission safeguards (auto, allow, deny, reset, check)",
		handler: async (args, ctx) => {
				const [subcommand = "show", ...rest] = args.trim().split(/\s+/).filter(Boolean);
				switch (subcommand) {
					case "auto": {
						engine.auto = !engine.auto;
						updateStatus(ctx);
						ctx.ui.notify(`Safeguards auto-approve ${engine.auto ? "enabled" : "disabled"}`, "info");
						return;
					}
					case "reset": {
						const removed = engine.saved.clear();
						ctx.ui.notify(`Cleared ${removed} saved permission rule(s) for this project`, "info");
						return;
					}
					case "allow":
					case "deny": {
						const action = rest[0];
						if (!action) {
							ctx.ui.notify(`Usage: /safeguards ${subcommand} <action> [resource]`, "warning");
							return;
						}
						const resource = rest.slice(1).join(" ") || "*";
						if (subcommand === "allow") {
							engine.saved.add(action, [resource]);
							ctx.ui.notify(`Saved allow rule: ${action} ${resource}`, "info");
						} else {
							await addDenyRule(ctx, action, resource);
						}
						return;
					}
					case "check": {
						const action = rest[0];
						const resource = rest.slice(1).join(" ");
						if (!action || !resource) {
							ctx.ui.notify("Usage: /safeguards check <action> <resource>", "warning");
							return;
						}
						const result = engine.explain(action, resource);
						ctx.ui.notify(
							`${action} ${resource} -> ${result.effect}${
								result.rule ? ` (rule: ${result.rule.action} ${result.rule.resource})` : ""
							}`,
							"info",
						);
						return;
					}
					default: {
						await showStatus(engine, ctx);
						return;
					}
				}
			},
		});

	pi.registerShortcut(Key.ctrlShift("a"), {
		description: "Toggle safeguards auto-approve",
		handler: async (ctx) => {
			engine.auto = !engine.auto;
			updateStatus(ctx);
			ctx.ui.notify(`Safeguards auto-approve ${engine.auto ? "enabled" : "disabled"}`, "info");
		},
	});
}


/* ------------------------------------------------------------------ */
/* Request building                                                   */
/* ------------------------------------------------------------------ */

function buildRequest(engine: SafeguardEngine, event: ToolCallEvent): ToolRequest | undefined {
	const input = (event.input ?? {}) as Record<string, unknown>;

	if (event.toolName === "bash" || event.toolName === "powershell") {
		return buildShellRequest({ engine, toolName: event.toolName, input });
	}

	const pathRequest = buildPathRequest({ engine, toolName: event.toolName, input });
	if (pathRequest) return pathRequest;

	const action = PASSTHROUGH_ACTIONS[event.toolName];
	if (action) return buildActionRequest(event.toolName, action, input);

	// Unknown/extension tool: still guard external paths.
	return buildGenericPathRequest({ engine, toolName: event.toolName, input });
}

function buildActionRequest(
	toolName: string,
	action: string,
	input: Record<string, unknown>,
): ToolRequest | undefined {
	const resources = resourcesFor(action, input);
	const lines = [`Tool: ${toolName}`];
	const url = stringField(input, "url");
	const query = stringField(input, "query");
	const agent = stringField(input, "agent") || stringField(input, "subagent_type");
	const skill = stringField(input, "skill") || stringField(input, "name");
	if (url) lines.push(`URL: ${url}`);
	if (query) lines.push(`Query: ${query}`);
	if (agent) lines.push(`Agent: ${agent}`);
	if (skill) lines.push(`Skill: ${skill}`);

	const title = titleFor(action, { url, query, agent, skill });
	return {
		toolName,
		checks: [{ action, resources, save: saveFor(action, resources) }],
		title,
		lines,
	};
}

function resourcesFor(action: string, input: Record<string, unknown>): string[] {
	if (action === "webfetch") {
		const url = stringField(input, "url");
		return url ? [url] : ["*"];
	}
	if (action === "websearch") {
		const query = stringField(input, "query");
		return query ? [query] : ["*"];
	}
	if (action === "task" || action === "subagent") {
		const agent = stringField(input, "agent") || stringField(input, "subagent_type");
		return agent ? [agent] : ["*"];
	}
	if (action === "skill") {
		const skill = stringField(input, "skill") || stringField(input, "name") || stringField(input, "id");
		return skill ? [skill] : ["*"];
	}
	if (action === "lsp") {
		const operation = stringField(input, "operation") || stringField(input, "method") || "request";
		const file = stringField(input, "path");
		return file ? [`${operation} ${file}`] : [operation];
	}
	return ["*"];
}

function saveFor(action: string, resources: string[]): string[] {
	if (action === "task" || action === "subagent") return resources.length > 0 ? resources : ["*"];
	if (action === "skill") return resources.length > 0 ? resources : ["*"];
	return ["*"];
}

function titleFor(
	action: string,
	values: { url: string; query: string; agent: string; skill: string },
): string {
	if (action === "webfetch") return `WebFetch ${values.url || ""}`.trim();
	if (action === "websearch") return `WebSearch "${values.query || ""}"`;
	if (action === "task" || action === "subagent") return `Launch ${values.agent || "subagent"}`;
	if (action === "skill") return `Load skill ${values.skill || ""}`.trim();
	if (action === "question") return "Ask the user a question";
	if (action === "lsp") return "Run LSP query";
	return `Call ${action}`;
}

function stringField(input: Record<string, unknown>, key: string): string {
	const value = input[key];
	return typeof value === "string" ? value : "";
}

/* ------------------------------------------------------------------ */
/* Doom loop                                                          */
/* ------------------------------------------------------------------ */

async function checkDoomLoop(
	engine: SafeguardEngine,
	event: ToolCallEvent,
	ctx: ExtensionContext,
): Promise<SafeguardResult | undefined> {
	if (!engine.config.doomLoop) return undefined;

	const repeats = engine.recordCall(event.toolName, event.input ?? {});
	if (repeats < engine.config.doomLoopThreshold) return undefined;

	const request = engine.doomLoopRequest(event.toolName, event.input ?? {}, repeats);
	return engine.guard(request, ctx);
}

/* ------------------------------------------------------------------ */
/* Commands                                                           */
/* ------------------------------------------------------------------ */

async function showStatus(engine: SafeguardEngine, ctx: ExtensionCommandContext): Promise<void> {
	const saved = engine.savedRules();
	const configured = engine.config.rules;
	const lines: string[] = [
		`Working directory: ${engine.config.sources.length > 0 ? engine.config.sources.join(", ") : "(no config file)"}`,
		`Fallback: ${engine.config.fallback}`,
		`Auto-approve: ${engine.auto ? "on" : "off"}`,
		`Doom loop guard: ${engine.config.doomLoop ? `on (${engine.config.doomLoopThreshold} repeats)` : "off"}`,
		"",
		"Configured rules (lowest precedence first):",
	];
	for (const rule of configured.slice(-30)) {
		lines.push(`  ${rule.action} ${rule.resource} -> ${rule.effect}`);
	}
	if (configured.length === 0) lines.push("  (none)");
	lines.push("", `Saved rules for this project (${saved.length}):`);
	for (const rule of saved.slice(-30)) {
		lines.push(`  ${rule.action} ${rule.resource} -> allow`);
	}
	if (saved.length === 0) lines.push("  (none)");
	if (engine.config.warnings.length > 0) {
		lines.push("", "Warnings:");
		for (const warning of engine.config.warnings) lines.push(`  ${warning}`);
	}
	lines.push("", "Commands: /safeguards auto | reset | allow <action> [resource] | deny <action> [resource] | check <action> <resource>");

	ctx.ui.notify(lines.join("\n"), "info");
}

/**
 * Add a deny rule to the project config. Denies must live in configuration
 * because saved grants can only ever allow.
 */
async function addDenyRule(ctx: ExtensionCommandContext, action: string, resource: string): Promise<void> {
	const { promises: fs } = await import("node:fs");
	const file = path.join(process.cwd(), ".pi", "safeguards.json");
	let config: Record<string, unknown> = {};
	try {
		const raw = await fs.readFile(file, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
	} catch {
		// Missing or invalid config: start from an empty object.
	}

	const permission = (config.permission && typeof config.permission === "object" && !Array.isArray(config.permission)
		? config.permission
		: {}) as Record<string, unknown>;
	const existing = permission[action];
	const rules: Record<string, unknown> =
		typeof existing === "string"
			? { "*": existing }
			: existing && typeof existing === "object" && !Array.isArray(existing)
				? { ...(existing as Record<string, unknown>) }
				: {};
	rules[resource] = "deny";
	permission[action] = rules;
	config.permission = permission;

	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	ctx.ui.notify(`Added deny rule to ${file}: ${action} ${resource}`, "info");
}

/* ------------------------------------------------------------------ */
/* Wiring                                                             */
/* ------------------------------------------------------------------ */

function createEngine(cwd = process.cwd(), pi?: ExtensionAPI): SafeguardEngine {
	const instance = new SafeguardEngine({
		cwd,
		agentDir: getAgentDir(),
		projectId: projectId(cwd),
	});
	if (pi?.getFlag("safeguards-auto") === true) instance.auto = true;
	return instance;
}

/** Project id: the repository root when there is one, otherwise the cwd. */
export function projectId(cwd: string): string {
	let current = path.resolve(cwd);
	const root = path.parse(current).root;
	while (current !== root) {
		if (existsSync(path.join(current, ".git"))) return toPosix(current);
		current = path.dirname(current);
	}
	return toPosix(path.resolve(cwd));
}

function block(result: SafeguardResult): { block: true; reason: string } {
	return { block: true, reason: result.reason ?? "Blocked by safeguards" };
}

export { matchWildcard, truncate, describe };
export type { ToolRequest, SafeguardResult };
export { SafeguardEngine } from "./src/engine.ts";
