/**
 * Pattern matching, path handling, and permission evaluation.
 *
 * Wildcard semantics mirror OpenCode (`packages/core/src/util/wildcard.ts`):
 *   `*` matches zero or more characters, `?` matches exactly one,
 *   everything else is literal, and `\` is normalized to `/`.
 */

import os from "node:os";
import path from "node:path";
import type { Decision, Effect, Rule, Ruleset } from "./types.ts";

/* ------------------------------------------------------------------ */
/* Wildcards                                                           */
/* ------------------------------------------------------------------ */

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

export function wildcardToRegExp(pattern: string): RegExp {
	let escaped = pattern
		.replaceAll("\\", "/")
		.replace(REGEX_SPECIALS, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	// `foo *` also matches bare `foo`, matching OpenCode's trailing-space handling.
	if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";
	return new RegExp(`^${escaped}$`, "s");
}

const patternCache = new Map<string, RegExp>();

export function matchWildcard(input: string, pattern: string): boolean {
	const normalized = input.replaceAll("\\", "/");
	let regex = patternCache.get(pattern);
	if (!regex) {
		regex = wildcardToRegExp(pattern);
		if (patternCache.size > 2000) patternCache.clear();
		patternCache.set(pattern, regex);
	}
	return regex.test(normalized);
}

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

export function expandHome(input: string, home = os.homedir()): string {
	if (input === "~" || input === "$HOME") return home;
	if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(home, input.slice(2));
	if (input.startsWith("$HOME/") || input.startsWith("$HOME\\")) return path.join(home, input.slice(6));
	return input;
}

export function toPosix(input: string): string {
	return input.replaceAll("\\", "/");
}

/** Strip a leading `@` that Pi's file arguments use. */
export function stripAtPrefix(input: string): string {
	return input.startsWith("@") && !input.startsWith("@@") ? input.slice(1) : input;
}

/** Lexical absolute path. Does not require the path to exist. */
export function resolveAbsolute(input: string, cwd: string): string {
	const expanded = expandHome(stripAtPrefix(input.trim()));
	if (!expanded) return path.resolve(cwd);
	return path.resolve(cwd, expanded);
}

/** True when `target` is `root` or inside it (lexically). */
export function contains(root: string, target: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resource name for a path: relative to cwd for internal paths, absolute for
 * external ones. Matches OpenCode's `FileAccess.resolve` behavior.
 */
export function resourceForPath(absolute: string, cwd: string, worktree?: string): string {
	const resolved = path.resolve(absolute);
	const insideCwd = contains(cwd, resolved);
	const insideWorktree = worktree ? contains(worktree, resolved) : false;
	if (insideCwd || insideWorktree) {
		const relative = path.relative(cwd, resolved);
		return toPosix(relative === "" ? "." : relative);
	}
	return toPosix(resolved);
}

/**
 * The directory that an "always allow" grant should cover for an external path.
 * Grants the project root when the path lives in another repository, otherwise
 * the containing directory.
 */
export function externalGrantPath(absolute: string, projectRoot?: string): string {
	const resolved = path.resolve(absolute);
	const directory = path.dirname(resolved);
	if (projectRoot && contains(projectRoot, resolved)) return toPosix(path.join(projectRoot, "*"));
	return toPosix(path.join(directory, "*"));
}

/** Expand a glob-style `*` prefix into a literal directory prefix. */
export function globPrefix(value: string): string {
	const wildcard = value.indexOf("*");
	if (wildcard === -1) return value;
	const prefix = value.slice(0, wildcard);
	if (/^[\\/]+$/.test(prefix) || /^[A-Za-z]:[\\/]$/.test(prefix)) return prefix;
	return prefix.replace(/[\\/]+$/, "");
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

export function normalizeEffect(value: unknown, fallback: Effect = "ask"): Effect {
	if (value === "allow" || value === "deny" || value === "ask") return value;
	return fallback;
}

/** Flatten OpenCode-style config (scalar or `{ pattern: effect }`) into rules. */
export function normalizeRules(action: string, value: unknown): Ruleset {
	if (value === undefined) return [];
	if (typeof value === "string") {
		const effect = normalizeEffect(value, "ask");
		return [{ action, resource: "*", effect }];
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
	const rules: Ruleset = [];
	for (const [resource, raw] of Object.entries(value as Record<string, unknown>)) {
		if (raw !== "allow" && raw !== "deny" && raw !== "ask") continue;
		rules.push({ action, resource: expandHome(resource), effect: raw });
	}
	return rules;
}

/**
 * Evaluate one resource. The **last** matching rule wins, so catch-all `*`
 * rules belong first in the list.
 */
export function evaluate(
	action: string,
	resource: string,
	...rulesets: Ruleset[]
): { effect: Effect; rule?: Rule; fallback: boolean } {
	const all = rulesets.flat();
	for (let index = all.length - 1; index >= 0; index--) {
		const rule = all[index];
		if (!matchWildcard(action, rule.action)) continue;
		if (!matchWildcard(resource, rule.resource)) continue;
		return { effect: rule.effect, rule, fallback: false };
	}
	return { effect: "ask", fallback: true };
}

/**
 * Resolve a set of resources. Any `deny` denies the whole request (checked
 * against configured rules only, so a saved "always allow" can never override
 * an explicit deny). Otherwise `ask` wins over `allow`.
 */
export function decide(
	action: string,
	resources: string[],
	configured: Ruleset,
	saved: Ruleset,
	fallback: Effect = "ask",
): Decision {
	const list = resources.length > 0 ? resources : ["*"];

	for (const resource of list) {
		const result = evaluate(action, resource, configured);
		if (result.effect === "deny") {
			return { effect: "deny", rule: result.rule, save: "*", resources: list };
		}
	}

	let effect: Effect = "allow";
	let rule: Rule | undefined;
	for (const resource of list) {
		const result = evaluate(action, resource, [...configured, ...saved]);
		if (result.effect === "ask") {
			effect = "ask";
			rule = result.rule;
			break;
		}
		if (result.effect === "allow") {
			effect = "allow";
			rule = result.rule;
		}
	}

	if (effect === "allow" && !rule && fallback !== "allow") {
		return { effect: fallback, rule: undefined, fallback: true, save: "*", resources: list };
	}

	return {
		effect,
		rule,
		fallback: !rule,
		save: "*",
		resources: list,
	};
}
