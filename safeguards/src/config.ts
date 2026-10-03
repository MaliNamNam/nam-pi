/**
 * Configuration loading.
 *
 * Reads `permission`, `permissionFallback`, and `safeguards` sections from the
 * Pi agent directory config and the project config. Project values override
 * agent-directory values, matching Pi's settings precedence.
 *
 * Config files (first one that exists wins, per directory):
 *   <agent-dir>/safeguards.json   <agent-dir>/pi.jsonc   <agent-dir>/settings.json
 *   <cwd>/.pi/safeguards.json     <cwd>/.pi/settings.json
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { normalizeRules } from "./rules.ts";
import type { Effect, Ruleset } from "./types.ts";

export interface SafeguardsConfig {
	/** Configured rules, in precedence order (earlier files first). */
	rules: Ruleset;
	/** Effect used when no rule matches. */
	fallback: Effect;
	/** Enable the repeated-tool-call (doom loop) guard. */
	doomLoop: boolean;
	/** Number of identical calls before the doom-loop guard triggers. */
	doomLoopThreshold: number;
	/** Prompt when a tool touches a path outside the working directory. */
	externalDirectory: boolean;
	/**
	 * Keep the built-in guards active even when config uses a catch-all rule.
	 * Set false for exact OpenCode rule ordering.
	 */
	strictGuards: boolean;
	/** Ask for every permission decision instead of prompting. */
	auto: boolean;
	/** Where the rules came from, for `/safeguards show`. */
	sources: string[];
	/** Problems found while loading, for `/safeguards show`. */
	warnings: string[];
}

/**
 * OpenCode's permissive baseline. Every action is allowed unless a later rule
 * says otherwise.
 */
export const PERMISSIVE_DEFAULTS: Ruleset = [{ action: "*", resource: "*", effect: "allow" }];

/**
 * Built-in safety guards, matching OpenCode's defaults.
 *
 * Defaults precede user configuration, matching OpenCode v2. Catch-all rules
 * can override them. The optional `safeguards.strictGuards: true` mode re-applies
 * guards for actions not explicitly named by the user's configuration.
 */
export const GUARD_RULES: Ruleset = [
	{ action: "external_directory", resource: "*", effect: "ask" },
	{ action: "doom_loop", resource: "*", effect: "ask" },
	{ action: "read", resource: "*.env", effect: "ask" },
	{ action: "read", resource: "*.env.*", effect: "ask" },
	{ action: "read", resource: "*.env.example", effect: "allow" },
];

/** @deprecated Use PERMISSIVE_DEFAULTS and GUARD_RULES. Kept for reference. */
export const DEFAULT_RULES: Ruleset = [...PERMISSIVE_DEFAULTS, ...GUARD_RULES];

/**
 * Paths Pi itself needs to read and write. Allowlisted so the external
 * directory prompt does not fire for Pi's own bookkeeping.
 */
export function internalPathRules(): Ruleset {
	const agentDir = getAgentDir();
	return [
		{ action: "external_directory", resource: join(agentDir, "*").replaceAll("\\", "/"), effect: "allow" },
		{ action: "read", resource: join(agentDir, "*").replaceAll("\\", "/"), effect: "allow" },
	];
}

/* ------------------------------------------------------------------ */
/* JSONC parsing (no dependencies)                                     */
/* ------------------------------------------------------------------ */

function stripJsonComments(source: string): string {
	let out = "";
	let quoted = false;
	let escaped = false;
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (quoted) {
			out += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') quoted = false;
			continue;
		}
		if (char === '"') {
			quoted = true;
			out += char;
			continue;
		}
		if (char === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
			const line = source[i + 1] === "/";
			i++;
			if (line) {
				while (i + 1 < source.length && source[i + 1] !== "\n") i++;
			} else {
				let closed = false;
				while (i + 1 < source.length) {
					if (source[i] === "*" && source[i + 1] === "/") {
						i++;
						closed = true;
						break;
					}
					if (source[i] === "\n") out += "\n";
					i++;
				}
				if (!closed) throw new Error("Unterminated block comment");
			}
			continue;
		}
		out += char;
	}
	return out;
}

function stripTrailingCommas(source: string): string {
	let out = "";
	let quoted = false;
	let escaped = false;
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (quoted) {
			out += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') quoted = false;
			continue;
		}
		if (char === '"') {
			quoted = true;
			out += char;
			continue;
		}
		if (char === "," && /^[\s]*[}\]]/.test(source.slice(i + 1))) continue;
		out += char;
	}
	return out;
}

export function parseJsonc(source: string): unknown {
	return JSON.parse(stripTrailingCommas(stripJsonComments(source)));
}

function readJsonc(file: string): unknown {
	return parseJsonc(readFileSync(file, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstExisting(candidates: string[]): string | undefined {
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/* ------------------------------------------------------------------ */
/* Config extraction                                                   */
/* ------------------------------------------------------------------ */

interface Extracted {
	rules: Ruleset;
	fallback?: Effect;
	auto?: boolean;
	externalDirectory?: boolean;
	doomLoop?: boolean;
	doomLoopThreshold?: number;
	strictGuards?: boolean;
}

/** Parse OpenCode-shaped `permission` plus the `safeguards` options block. */
export function extractConfig(raw: unknown, warnings: string[]): Extracted {
	const result: Extracted = { rules: [] };
	if (!isRecord(raw)) return result;

	const permission = raw.permission;
	if (typeof permission === "string") {
		result.rules.push(...normalizeRules("*", permission));
	} else if (isRecord(permission)) {
		for (const [action, value] of Object.entries(permission)) {
			const effect =
				typeof value === "string"
					? value
					: isRecord(value)
						? value["*"]
						: undefined;
			if (effect !== undefined && effect !== "allow" && effect !== "ask" && effect !== "deny") {
				warnings.push(`permission.${action}: expected "allow", "ask", or "deny"`);
				continue;
			}
			result.rules.push(...normalizeRules(action, value));
		}
	} else if (permission !== undefined) {
		warnings.push("permission: expected a string or an object");
	}

	if (typeof raw.permissionFallback === "string") {
		const value = raw.permissionFallback;
		if (value === "allow" || value === "ask" || value === "deny") result.fallback = value;
		else warnings.push(`permissionFallback: expected "allow", "ask", or "deny"`);
	}

	const safeguards = raw.safeguards;
	if (safeguards !== undefined && !isRecord(safeguards)) {
		warnings.push("safeguards: expected an object");
	} else if (isRecord(safeguards)) {
		if (typeof safeguards.auto === "boolean") result.auto = safeguards.auto;
		if (typeof safeguards.externalDirectory === "boolean") {
			result.externalDirectory = safeguards.externalDirectory;
		}
		if (typeof safeguards.doomLoop === "boolean") result.doomLoop = safeguards.doomLoop;
		if (typeof safeguards.strictGuards === "boolean") result.strictGuards = safeguards.strictGuards;
		if (typeof safeguards.doomLoopThreshold === "number" && safeguards.doomLoopThreshold > 0) {
			result.doomLoopThreshold = Math.floor(safeguards.doomLoopThreshold);
		}
		if (safeguards.externalDirectory === false) {
			result.rules.push({ action: "external_directory", resource: "*", effect: "allow" });
		}
		if (safeguards.doomLoop === false) {
			result.rules.push({ action: "doom_loop", resource: "*", effect: "allow" });
		}
	}

	return result;
}

export interface LoadOptions {
	cwd: string;
	agentDir?: string;
}

export function loadConfig(options: LoadOptions): SafeguardsConfig {
	const agentDir = options.agentDir ?? getAgentDir();
	const warnings: string[] = [];
	const sources: string[] = [];

	const globalFile = firstExisting([
		join(agentDir, "safeguards.json"),
		join(agentDir, "pi.jsonc"),
		join(agentDir, "settings.json"),
	]);
	const projectFile = firstExisting([
		join(options.cwd, ".pi", "safeguards.json"),
		join(options.cwd, ".pi", "settings.json"),
	]);

	const rules: Ruleset = [];
	let fallback: Effect | undefined;
	let auto: boolean | undefined;
	let doomLoop: boolean | undefined;
	let doomLoopThreshold: number | undefined;
	let strictGuards: boolean | undefined;

	for (const file of [globalFile, projectFile]) {
		if (!file) continue;
		try {
			const extracted = extractConfig(readJsonc(file), warnings);
			if (extracted.rules.length > 0 || extracted.fallback !== undefined) sources.push(file);
			rules.push(...extracted.rules);
			if (extracted.fallback !== undefined) fallback = extracted.fallback;
			if (extracted.auto !== undefined) auto = extracted.auto;
			if (extracted.doomLoop !== undefined) doomLoop = extracted.doomLoop;
			if (extracted.doomLoopThreshold !== undefined) doomLoopThreshold = extracted.doomLoopThreshold;
			if (extracted.strictGuards !== undefined) strictGuards = extracted.strictGuards;
		} catch (error) {
			warnings.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return {
		rules,
		fallback: fallback ?? "ask",
		doomLoop: doomLoop ?? true,
		doomLoopThreshold: doomLoopThreshold ?? 3,
		externalDirectory: true,
		strictGuards: strictGuards ?? false,
		auto: auto ?? false,
		sources,
		warnings,
	};
}
