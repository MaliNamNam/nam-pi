/**
 * OpenCode permission ruleset handling.
 *
 * Ported from `packages/core/src/permission.ts` (`evaluate`, `merge`) and
 * `packages/core/src/v1/config/permission.ts` (config normalization).
 *
 * Rules are evaluated last-match-wins, so a catch-all `"*"` belongs first.
 */

import os from "node:os";
import path from "node:path";
import type { AgentDefinition, PermissionRule } from "./types.ts";

/** One action mapping for declaration filtering, legacy config and call enforcement. */
const TOOL_ACTIONS = new Map<string, string>([
	["read", "read"], ["bash", "bash"], ["powershell", "bash"], ["edit", "edit"], ["write", "edit"],
	["grep", "grep"], ["find", "glob"], ["ls", "list"], ["webfetch", "webfetch"], ["websearch", "websearch"],
	// pi-web-access-lean routes search and fetch through one tool.
	["web_access", "websearch"],
	["subagent", "subagent"], ["questionnaire", "question"],
]);

export function permissionActionFor(toolName: string): string | undefined {
	return TOOL_ACTIONS.get(toolName);
}

/** Legacy tools are ordered permission rules, not a separate permanent tool cap. */
export function legacyToolPermissions(raw: unknown): PermissionRule[] {
	if (!isRecord(raw)) return [];
	return Object.entries(raw).flatMap(([tool, enabled]): PermissionRule[] => {
		if (typeof enabled !== "boolean") return [];
		const action = tool === "patch" ? "edit" : tool === "task" ? "subagent" : permissionActionFor(tool) ?? tool;
		return [{ action, resource: "*", effect: enabled ? "allow" : "deny" }];
	});
}

/** Baseline from OpenCode v2's Agent.Info.default. Agent-specific rules follow these. */
export const DEFAULT_AGENT_PERMISSIONS: PermissionRule[] = [
	{ action: "*", resource: "*", effect: "allow" },
	{ action: "external_directory", resource: "*", effect: "ask" },
	{ action: "read", resource: "*.env", effect: "ask" },
	{ action: "read", resource: "*.env.*", effect: "ask" },
	{ action: "read", resource: "*.env.example", effect: "allow" },
];

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

/** Ported from OpenCode `packages/core/src/util/wildcard.ts`. */
export function matchWildcard(input: string, pattern: string): boolean {
	const normalized = input.replaceAll("\\", "/");
	let escaped = pattern
		.replaceAll("\\", "/")
		.replace(REGEX_SPECIALS, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";
	return new RegExp(`^${escaped}$`, "s").test(normalized);
}

function expandHome(input: string): string {
	const home = os.homedir();
	if (input === "~" || input === "$HOME") return home;
	if (input.startsWith("~/")) return path.join(home, input.slice(2));
	if (input.startsWith("$HOME/") || input.startsWith("$HOME\\")) return path.join(home, input.slice(6));
	return input;
}

/**
 * Normalize OpenCode's `permission` config into a flat ruleset.
 *
 * Accepts the scalar form (`"edit": "deny"`) and the object form
 * (`"bash": { "*": "ask", "git *": "allow" }`). Object keys keep their config
 * order, which is what makes last-match-wins work.
 */
export function normalizePermissions(raw: unknown): PermissionRule[] {
	if (raw === undefined || raw === null) return [];
	const rules: PermissionRule[] = [];

	if (typeof raw === "string") {
		if (isEffect(raw)) rules.push({ action: "*", resource: "*", effect: raw });
		return rules;
	}
	if (!isRecord(raw)) return rules;

	for (const [configuredAction, value] of Object.entries(raw)) {
		// OpenCode v2 migrates its legacy `task` permission to `subagent`.
		const action = configuredAction === "task" ? "subagent" : configuredAction === "patch" ? "edit" :
			permissionActionFor(configuredAction) ?? configuredAction;
		if (typeof value === "string") {
			if (isEffect(value)) rules.push({ action, resource: "*", effect: value });
			continue;
		}
		if (!isRecord(value)) continue;
		for (const [resource, effect] of Object.entries(value)) {
			if (!isEffect(effect)) continue;
			rules.push({ action, resource: expandHome(resource), effect });
		}
	}
	return rules;
}

function isEffect(value: unknown): value is "allow" | "ask" | "deny" {
	return value === "allow" || value === "ask" || value === "deny";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merge rulesets. Later rules win, matching OpenCode's `merge`. */
export function mergePermissions(...rulesets: PermissionRule[][]): PermissionRule[] {
	return rulesets.flat();
}

/**
 * Evaluate one action/resource pair.
 *
 * Defaults to `ask` when nothing matches, matching OpenCode.
 */
export function evaluate(
	action: string,
	resource: string,
	...rulesets: PermissionRule[][]
): { effect: "allow" | "ask" | "deny"; rule?: PermissionRule } {
	const all = rulesets.flat();
	for (let index = all.length - 1; index >= 0; index--) {
		const rule = all[index];
		if (!matchWildcard(action, rule.action)) continue;
		if (!matchWildcard(resource, rule.resource)) continue;
		return { effect: rule.effect, rule };
	}
	return { effect: "ask" };
}

/**
 * OpenCode's `denied` helper: any resource evaluating to `deny` denies the
 * whole request.
 */
export function isDenied(action: string, resources: string[], rules: PermissionRule[]): boolean {
	return resources.some((resource) => evaluate(action, resource, rules).effect === "deny");
}

/**
 * Whether a subagent may be dispatched. Mirrors OpenCode's filter in
 * `tool/plugin/subagent.ts`: the parent's `subagent` permission must not deny it.
 */
export function canDispatch(parentPermissions: PermissionRule[], agentId: string): boolean {
	return evaluate("subagent", agentId, parentPermissions).effect !== "deny";
}

/** Exact v2 Tool.whollyDisabled semantics: last action match, independently of resources. */
export function whollyDisabled(action: string, permissions: PermissionRule[]): boolean {
	const rule = permissions.findLast((item) => matchWildcard(action, item.action));
	return rule?.resource === "*" && rule.effect === "deny";
}

/** Filter actual registered/selected names; visibility never grants a call permission. */
export function filterToolNames(permissions: PermissionRule[], names: readonly string[]): string[] {
	return names.filter((name) => !whollyDisabled(permissionActionFor(name) ?? name, permissions));
}

/**
 * Registered tools whose action the rules allow by name for every resource.
 * A child activates these even when Pi's default selection omits them
 * (V2's Explore has grep/glob; Pi's defaults do not include grep/find/ls).
 */
export function explicitlyAllowedTools(permissions: PermissionRule[], names: readonly string[]): string[] {
	return filterToolNames(permissions, names.filter((name) => {
		const action = permissionActionFor(name) ?? name;
		return permissions.some((rule) => rule.action === action && rule.resource === "*" && rule.effect === "allow");
	}));
}

/**
 * Pre-bootstrap Pi loadout from known aliases and explicitly named custom tools.
 * A final blanket allow/ask yields undefined; resource-specific checks stay live.
 * Runtime filtering uses the actual selected catalog instead of this finite cache.
 */
export function allowedPiTools(permissions: PermissionRule[]): string[] | undefined {
	const names = new Set(TOOL_ACTIONS.keys());
	const actions = new Set(TOOL_ACTIONS.values());
	for (const rule of permissions) {
		if (rule.action === "external_directory" || actions.has(rule.action) || /[*?]/.test(rule.action)) continue;
		names.add(rule.action);
	}
	const candidates = [...names];
	const allowed = filterToolNames(permissions, candidates);
	return allowed.length === candidates.length ? undefined : allowed;
}

/** Cached config-derived lists must not override the current merged rule sequence. */
export function agentToolAllowlist(agent: AgentDefinition): string[] | undefined {
	if (agent.toolsFromPermissions || agent.tools === undefined) return allowedPiTools(agent.permissions);
	return filterToolNames(agent.permissions, agent.tools);
}

/** Derived caches cannot enumerate every child extension/MCP name before loading.
 * Let the child filter its selected catalog at session_start, before any prompt.
 * Independent manual caps still travel through CLI/SDK startup options.
 */
export function bootstrapToolAllowlist(agent: AgentDefinition): string[] | undefined {
	if (!agent.toolsFromPermissions) return agentToolAllowlist(agent);
	const blanket = agent.permissions.findLastIndex((rule) => rule.action === "*" && rule.resource === "*");
	// Only an unconditional final denial can be safely known without the catalog.
	if (blanket !== -1 && agent.permissions[blanket].effect === "deny" &&
		agent.permissions.slice(blanket + 1).every((rule) => rule.resource === "*" && rule.effect === "deny")) return [];
	return undefined;
}
