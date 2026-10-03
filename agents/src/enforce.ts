/**
 * Per-call permission enforcement inside a dispatched subagent.
 *
 * OpenCode evaluates an agent's permission ruleset on **every tool call**, not
 * just at the tool level (`permission.assert` inside each tool implementation).
 * A ruleset like:
 *
 *   bash:
 *     "*": deny
 *     "echo *": allow
 *
 * blocks `rm -rf /` while allowing `echo hi`.
 *
 * Pi's `--tools` can only gate whole tools, so the parent sends the ruleset to
 * the child (base64 JSON on `--agent-permissions`) and the child evaluates it
 * here, per call, using the same wildcard semantics and last-match-wins order.
 *
 * The mapping from a Pi tool call to OpenCode's (action, resources) pair mirrors
 * `src/requests.ts` in the parent, kept minimal because the child only needs
 * enough to decide allow/ask/deny.
 */

import fs from "node:fs";
import path from "node:path";
import { evaluatePath, insideRelative, resolvePermissionPath, type PermissionPath } from "./path-rules.ts";
import { evaluate, permissionActionFor } from "./permissions.ts";
import { scan, type ScanResult } from "./shell.ts";
import type { PermissionRule } from "./types.ts";
import type { PermissionCheck } from "./forms.ts";

export interface ToolCallLike {
	toolName: string;
	input?: unknown;
}

/**
 * The resources OpenCode would evaluate for this call.
 *
 * Mirrors the parent's mapping: a file path for path tools, the pattern for
 * search tools, the parsed command for shell tools.
 */
export function resourcesFor(toolName: string, input: Record<string, unknown>, cwd?: string): string[] {
	const action = permissionActionFor(toolName);
	if (!action) return ["*"];

	if (action === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		return scan(command, { cwd: cwd ?? process.cwd(), toolName }).commands.map((item) => item.resource);
	}
	if (action === "grep" || action === "glob" || action === "websearch") {
		const pattern = input.pattern ?? input.query;
		return typeof pattern === "string" && pattern ? [pattern] : ["*"];
	}
	const target = action === "webfetch" ? input.url : action === "subagent" ? input.agent : inputPath(input);
	if (cwd && ["read", "edit", "list"].includes(action)) {
		return resolvePermissionPath(cwd, typeof target === "string" ? target : ".", toolName === "read")?.groups.map((group) => group[0]) ?? [];
	}
	if (typeof target === "string" && target) return [target.replaceAll("\\", "/")];
	return ["*"];
}

function inputPath(input: Record<string, unknown>): string | undefined {
	for (const key of ["path", "file_path", "filePath", "filepath", "target", "directory", "dir"]) {
		if (typeof input[key] === "string") return input[key] as string;
	}
	return undefined;
}

/** The action a Pi tool maps to, or undefined when the ruleset does not gate it. */
export function actionFor(toolName: string): string | undefined {
	return permissionActionFor(toolName);
}

/**
 * Decide whether this call is denied by the ruleset.
 *
 * Returns a reason string when blocked, or undefined when the call may proceed.
 * Ask checks are reported separately for the root approval UI. Hard denials
 * cannot be approved away; callers must recheck the policy after a reply.
 */
export function blockedByRules(
	rules: PermissionRule[], call: ToolCallLike, options?: { cwd?: string; enforceExternal?: boolean; approvals?: PermissionCheck[] },
): string | undefined {
	const action = actionFor(call.toolName) ?? call.toolName;
	const input = call.input && typeof call.input === "object" && !Array.isArray(call.input)
		? call.input as Record<string, unknown> : {};
	const pathAction = ["read", "edit", "list"].includes(action);
	const rawPath = inputPath(input);
	const takesPath = ["read", "edit", "write", "grep", "find", "ls"].includes(call.toolName) || rawPath !== undefined;
	const target = options?.cwd && takesPath ? resolvePermissionPath(options.cwd, rawPath || ".", call.toolName === "read") : undefined;
	if (options?.cwd && takesPath && !target) return "Invalid tool path: cannot safely resolve path permissions";
	let shell: ScanResult | undefined;
	if (action === "bash") {
		try { shell = scan(typeof input.command === "string" ? input.command : "", { cwd: options?.cwd ?? process.cwd(), toolName: call.toolName }); }
		catch (error) { return error instanceof Error ? error.message : "Failed to parse shell command"; }
	}
	const groups = pathAction && target ? target.groups :
		(shell ? shell.commands.map((item) => item.resource) : resourcesFor(call.toolName, input)).map((resource) => [resource]);
	const resources = groups.map((group) => group[0]);
	const evaluations = groups.map((group) => pathAction && target ? evaluatePath(action, group, rules) : evaluate(action, group[0], rules));
	// A physical-target deny cannot be overridden by allowing its symlink alias.
	// Check all hard denies before asking about external or dynamic shell access.
	for (let index = 0; index < evaluations.length; index++) {
		const result = evaluations[index];
		if (result.effect === "deny") {
			const rule = result.rule;
			return `Permission denied by the agent's ruleset: ${action} (${resources[index]})` +
				(rule ? ` (rule: ${rule.action} ${rule.resource} -> deny)` : "");
		}
	}
	// For an unknown extension tool we cannot infer its side effects or paths.
	// A child requires a specific allow rule for that tool, not a catch-all.
	if (!actionFor(call.toolName) && options?.enforceExternal &&
		(!rules.some((rule) => rule.action === call.toolName && rule.resource === "*" && rule.effect === "allow") ||
			evaluate(call.toolName, "*", rules).effect !== "allow")) {
		return `Unrecognized subagent tool requires an explicit permission rule: ${call.toolName}`;
	}
	const external = externalPathCheck(rules, call.toolName, input, options, target);
	if (external && !requiresApproval(external)) return external;
	const approvals: string[] = external ? [external] : [];
	// Match OpenCode v2 ShellTool.prepare: external-directory checks cover cwd
	// changes, not arbitrary argument strings or every use of a shell variable.
	// The scanner exposes nested commands too, so prefix allows cannot hide a
	// denied command in a pipeline, substitution, group, or script block.
	for (const directory of shell?.directories ?? []) {
		const check = externalPathCheck(rules, call.toolName, { directory }, options);
		if (check && !requiresApproval(check)) return check;
		if (check) approvals.push(check);
	}
	if (rules.length === 0) return approvals.join("\n") || undefined;

	for (let index = 0; index < evaluations.length; index++) {
		const result = evaluations[index];
		if (result.effect === "ask") {
			options?.approvals?.push({ action, resource: resources[index] });
			const rule = result.rule;
			const detail = rule ? ` (rule: ${rule.action} ${rule.resource} -> ask)` : "";
			approvals.push(`Permission requires approval by the agent's ruleset: ${action} (${resources[index]})${detail}`);
		}
	}
	return [...new Set(approvals)].join("\n") || undefined;
}

/** Distinguish a resolvable prompt from a hard denial. */
export function requiresApproval(reason: string): boolean {
	return reason.startsWith("Permission requires approval") || reason.startsWith("External directory requires approval");
}

/** Check external paths separately from the tool's own action (including symlinks). */
function externalPathCheck(
	rules: PermissionRule[], tool: string, input: Record<string, unknown>,
	options?: { cwd?: string; enforceExternal?: boolean; approvals?: PermissionCheck[] },
	target?: PermissionPath,
): string | undefined {
	if (!options?.cwd || (!options.enforceExternal && !rules.some((rule) => rule.action === "external_directory"))) return undefined;
	const raw = inputPath(input);
	const pathTool = ["read", "edit", "write", "grep", "find", "ls"].includes(tool);
	if (raw === undefined && !pathTool) return undefined;
	const resolved = target ?? resolvePermissionPath(options.cwd, raw || ".", tool === "read");
	if (!resolved) return "Invalid tool path: cannot safely resolve external-directory permissions";
	if (insideRelative(resolved.canonicalCwd, resolved.canonical) !== undefined) return undefined;
	let directory = ["ls", "find", "grep"].includes(tool) || typeof input.directory === "string" || typeof input.dir === "string";
	try { directory = fs.statSync(resolved.canonical).isDirectory(); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "Invalid tool path: cannot resolve target type"; }
	const boundary = directory ? resolved.canonical : path.dirname(resolved.canonical);
	const resource = path.join(boundary, "*").replaceAll("\\", "/");
	const effect = evaluatePath("external_directory", [resource], rules);
	if (effect.effect === "allow") return undefined;
	if (effect.effect === "ask") options.approvals?.push({ action: "external_directory", resource });
	return `External directory ${effect.effect === "ask" ? "requires approval" : "denied"}: ${resource}`;
}

/** Decode the ruleset passed by the parent. Invalid input fails closed. */
export function decodePermissions(encoded: string | boolean | undefined): PermissionRule[] {
	if (typeof encoded !== "string" || !encoded) return [];
	try {
		const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as unknown;
		if (!Array.isArray(parsed)) throw new Error("Invalid permission ruleset");
		if (!parsed.every((rule) => rule && typeof rule === "object" &&
			typeof rule.action === "string" && typeof rule.resource === "string" &&
			["allow", "ask", "deny"].includes(rule.effect))) throw new Error("Invalid permission rule");
		return parsed.filter((rule): rule is PermissionRule => {
			if (!rule || typeof rule !== "object") return false;
			const candidate = rule as Partial<PermissionRule>;
			return (
				typeof candidate.action === "string" &&
				typeof candidate.resource === "string" &&
				(candidate.effect === "allow" || candidate.effect === "ask" || candidate.effect === "deny")
			);
		});
	} catch {
		return [{ action: "*", resource: "*", effect: "deny" }];
	}
}

/** Normalize a resource to OpenCode's forward-slash form. */
export function normalizeResource(input: string): string {
	return input.replaceAll("\\", "/");
}
