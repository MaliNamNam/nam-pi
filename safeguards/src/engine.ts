/**
 * The safeguard engine.
 *
 * Owns the rule set, the "always allow" store, the prompt UI, the doom-loop
 * detector, and the tool_call interceptor that turns all of it into a single
 * `block` decision.
 *
 * Mirrors OpenCode's `Permission` service: evaluate -> deny / ask / allow.
 * A single tool call can require several checks (for example a read that also
 * touches an external directory); all checks are evaluated and, when any of
 * them asks, the user sees one prompt.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GUARD_RULES, internalPathRules, loadConfig, PERMISSIVE_DEFAULTS, type SafeguardsConfig } from "./config.ts";
import { contains, decide, evaluate, externalGrantPath, resolveAbsolute, resourceForPath, toPosix } from "./rules.ts";
import { SavedPermissions } from "./saved.ts";
import { scan } from "./shell.ts";
import type { Effect, PermissionReply, Rule, Ruleset } from "./types.ts";

/** Prompt choices, in display order. */
export const OPTION_ONCE = "Allow once";
export const OPTION_ALWAYS = "Always allow";
export const OPTION_REJECT = "Reject";

/** One rule evaluation inside a tool request. */
export interface Check {
	/** Permission key, for example `read`, `edit`, `bash`, `external_directory`. */
	action: string;
	/** Resources evaluated against the rules. */
	resources: string[];
	/** Patterns an "always allow" grant saves for this check. */
	save: string[];
}

export interface ToolRequest {
	toolName: string;
	checks: Check[];
	/** First line of the prompt. */
	title: string;
	/** Extra context lines shown in the prompt. */
	lines: string[];
	/** Diff or patch preview, when available. */
	diff?: string;
}

export interface SafeguardResult {
	effect: Effect;
	/** Set when the tool must not run. */
	block?: boolean;
	reason?: string;
}

export interface EngineOptions {
	cwd: string;
	/** Isolated agents inherit policy files without resolving tools against the parent checkout. */
	configCwd?: string;
	agentDir?: string;
	/** Project identifier used to scope saved grants. */
	projectId: string;
}

interface PendingAsk {
	action: string;
	resources: string[];
	save: string[];
}

export class SafeguardEngine {
	config: SafeguardsConfig;
	saved: SavedPermissions;
	auto: boolean;

	/** Working directory all relative paths resolve against. */
	readonly cwd: string;

	private readonly agentDir: string;
	private readonly configCwd: string;
	private readonly promptCache = new Map<string, Promise<PermissionReply>>();
	private readonly history: Array<{ toolName: string; hash: string }> = [];

	constructor(options: EngineOptions) {
		this.cwd = options.cwd;
		this.agentDir = options.agentDir ?? "";
		this.configCwd = options.configCwd ?? options.cwd;
		this.config = loadConfig({ cwd: this.configCwd, agentDir: options.agentDir });
		this.saved = new SavedPermissions(options.projectId);
		this.auto = this.config.auto;
	}

	/* -------------------------------------------------------------- */
	/* Rules                                                          */
	/* -------------------------------------------------------------- */

	/**
	 * Configured rules, lowest precedence first. The fallback effect is not a
	 * rule: `decide` applies it only when nothing matched, so it can never shadow
	 * an explicit rule.
	 */
	configuredRules(): Ruleset {
		return [...PERMISSIVE_DEFAULTS, ...GUARD_RULES, ...internalPathRules(), ...this.config.rules, ...this.guardRules()];
	}

	/**
	 * Re-apply the built-in guards unless the user named the action explicitly.
	 * This keeps a catch-all `"*": "allow"` from silently disabling the env-file,
	 * external-directory, and doom-loop guards. Set `safeguards.strictGuards` to
	 * false for OpenCode's exact last-match-wins ordering.
	 */
	private guardRules(): Ruleset {
		if (!this.config.strictGuards) return [];
		const named = new Set(this.config.rules.map((rule) => rule.action));
		return GUARD_RULES.filter((rule) => !named.has(rule.action));
	}

	savedRules(): Ruleset {
		return this.saved.rules();
	}

	reload(): void {
		this.config = loadConfig({ cwd: this.configCwd, agentDir: this.agentDir || undefined });
		this.auto = this.config.auto;
	}

	/** Explain the decision for one action/resource pair. */
	explain(action: string, resource: string): { effect: Effect; rule?: Rule } {
		const result = evaluate(action, resource, [...this.configuredRules(), ...this.savedRules()]);
		return { effect: result.effect, rule: result.rule };
	}

	/* -------------------------------------------------------------- */
	/* Decision                                                       */
	/* -------------------------------------------------------------- */

	private evaluateRequest(request: ToolRequest): { asks: PendingAsk[]; denied?: string } {
		const asks: PendingAsk[] = [];
		for (const check of request.checks) {
			const decision = decide(check.action, check.resources, this.configuredRules(), this.savedRules(), this.config.fallback);
			if (decision.effect === "deny") {
				const rule = decision.rule;
				const detail = rule ? ` (rule: ${rule.action} ${rule.resource} -> deny)` : "";
				return { asks: [], denied: `Permission denied by configuration: ${check.action} (${describe(check.resources)})${detail}` };
			}
			if (decision.effect === "ask") asks.push({ action: check.action, resources: check.resources,
				save: check.save.length > 0 ? check.save : defaultSave(check) });
		}
		return { asks };
	}

	/** Pure preflight for the paired agents root queue; never prompts or saves. */
	assess(request: ToolRequest): { checks: Array<{ action: string; resource: string }>; reason?: string; denied?: string } {
		const { asks, denied } = this.evaluateRequest(request);
		if (denied) return { checks: [], denied };
		if (this.auto || !asks.length) return { checks: [] };
		return { checks: asks.flatMap((ask) => ask.resources.map((resource) => ({ action: ask.action, resource }))),
			reason: `Permission requires approval by safeguards: ${[request.title, ...request.lines].join("\n")}` };
	}

	async guard(request: ToolRequest, ctx: ExtensionContext): Promise<SafeguardResult> {
		const { asks, denied } = this.evaluateRequest(request);
		if (denied) return { effect: "deny", block: true, reason: denied };
		if (asks.length === 0) return { effect: "allow" };

		if (this.auto) {
			ctx.ui.notify(`auto: allowed ${request.title}`, "info");
			return { effect: "allow" };
		}

		const reply = await this.prompt(request, asks, ctx);
		if (reply === "reject") {
			return {
				effect: "deny",
				block: true,
				reason: `Permission denied by user: ${describe(asks.flatMap((ask) => ask.resources))}`,
			};
		}
		if (reply === "always") {
			for (const ask of asks) {
				const added = this.saved.add(ask.action, dedupe(ask.save));
				if (added.length > 0) {
					ctx.ui.notify(`Always allowing ${ask.action}: ${added.map((rule) => rule.resource).join(", ")}`, "info");
				}
			}
		}
		return { effect: "allow" };
	}

	/* -------------------------------------------------------------- */
	/* Prompting                                                      */
	/* -------------------------------------------------------------- */

	private promptKey(asks: PendingAsk[]): string {
		return asks
			.map((ask) => `${ask.action}\u0000${[...ask.resources].sort().join("\u0001")}`)
			.sort()
			.join("\u0002");
	}

	private async prompt(
		request: ToolRequest,
		asks: PendingAsk[],
		ctx: ExtensionContext,
	): Promise<PermissionReply> {
		const key = this.promptKey(asks);
		const existing = this.promptCache.get(key);
		if (existing) return existing;

		const promise = this.runPrompt(request, asks, ctx).finally(() => {
			this.promptCache.delete(key);
		});
		this.promptCache.set(key, promise);
		return promise;
	}

	private async runPrompt(
		request: ToolRequest,
		asks: PendingAsk[],
		ctx: ExtensionContext,
	): Promise<PermissionReply> {
		const patterns = dedupe(asks.flatMap((ask) => ask.save));

		if (!ctx.hasUI) {
			// Fail closed: an unattended run must not silently approve.
			ctx.ui.notify(`Permission required but no UI is available; blocking ${request.title}`, "warning");
			return "reject";
		}

		const title = [request.title, ...request.lines].join("\n");
		const choice = await ctx.ui.select(title, [OPTION_ONCE, OPTION_ALWAYS, OPTION_REJECT]);

		if (choice === OPTION_ALWAYS) {
			const detail =
				patterns.length === 0
					? "This will always allow this request for this project."
					: patterns.length === 1 && patterns[0] === "*"
						? `This will always allow ${asks[0]?.action ?? request.toolName} for this project.`
						: `This will always allow the following patterns for this project:\n${patterns
								.map((pattern) => `- ${pattern}`)
								.join("\n")}`;
			const confirmed = await ctx.ui.confirm("Always allow?", detail);
			if (confirmed) return "always";
			return "reject";
		}

		if (choice === OPTION_ONCE) return "once";
		return "reject";
	}

	/* -------------------------------------------------------------- */
	/* Doom loop detection                                            */
	/* -------------------------------------------------------------- */

	/**
	 * Record a tool call. Returns the number of identical consecutive calls,
	 * matching OpenCode's `doom_loop` guard (default threshold: 3).
	 */
	recordCall(toolName: string, input: unknown): number {
		const hash = stableHash(input);
		this.history.push({ toolName, hash });
		if (this.history.length > 64) this.history.splice(0, this.history.length - 64);

		let repeats = 0;
		for (let index = this.history.length - 1; index >= 0; index--) {
			const entry = this.history[index];
			if (entry.toolName !== toolName || entry.hash !== hash) break;
			repeats++;
		}
		return repeats;
	}

	resetHistory(): void {
		this.history.length = 0;
	}

	doomLoopRequest(toolName: string, input: unknown, repeats: number): ToolRequest {
		return {
			toolName,
			checks: [{ action: "doom_loop", resources: ["*"], save: ["*"] }],
			title: `Repeated tool call detected (${repeats}x)`,
			lines: [
				`Tool: ${toolName}`,
				`Input: ${truncate(stableStringify(input), 240)}`,
				"",
				"This keeps the session running despite repeated identical calls.",
			],
		};
	}

	/* -------------------------------------------------------------- */
	/* Request construction                                           */
	/* -------------------------------------------------------------- */

	/** Absolute path plus external-directory authorization for one path. */
	resolvePath(input: string): {
		absolute: string;
		resource: string;
		external: boolean;
		grant: string;
	} {
		const absolute = resolveAbsolute(input, this.cwd);
		if (contains(this.cwd, absolute)) {
			return { absolute, resource: resourceForPath(absolute, this.cwd), external: false, grant: "*" };
		}
		return {
			absolute,
			resource: toPosix(absolute),
			external: true,
			grant: externalGrantPath(absolute, this.projectRoot(absolute)),
		};
	}

	/**
	 * The external_directory check for a path, or undefined when the path is
	 * internal or the rule set already allows it.
	 */
	externalCheck(absolute: string, grant: string): Check | undefined {
		const resource = toPosix(absolute);
		const decision = decide("external_directory", [resource], this.configuredRules(), this.savedRules(), this.config.fallback);
		if (decision.effect === "allow") return undefined;
		return { action: "external_directory", resources: [resource], save: [grant] };
	}

	/** Build the shell request for a bash/powershell command. */
	shellRequest(command: string, toolName: string): ToolRequest {
		const result = scan(command, { cwd: this.cwd, toolName });
		const checks: Check[] = [];

		// A `cd` outside the working directory needs the external directory grant.
		for (const directory of result.directories) {
			const resolved = this.resolvePath(directory);
			if (!resolved.external) continue;
			const resource = toPosix(path.join(resolved.absolute, "*"));
			const check = this.externalCheck(resource, resource);
			if (check) checks.push(check);
		}

		const commands = result.commands;
		if (commands.length > 0) checks.push({
			action: "bash",
			resources: commands.map((item) => item.resource),
			save: commands.map((item) => item.save),
		});

		return {
			toolName,
			checks,
			title: commands.length <= 1 ? "Run command" : `Run ${commands.length} commands`,
			lines: [`$ ${command}`],
		};
	}

	/** Display path relative to cwd when possible. */
	displayPath(absolute: string): string {
		return contains(this.cwd, absolute) ? path.relative(this.cwd, absolute) || "." : absolute;
	}

	/** Walk up from a path to the nearest repository root, when one exists. */
	private projectRoot(absolute: string): string | undefined {
		let current = path.dirname(absolute);
		const root = path.parse(current).root;
		while (current !== root) {
			if (existsSync(path.join(current, ".git"))) return current;
			current = path.dirname(current);
		}
		return undefined;
	}
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function defaultSave(check: Check): string[] {
	return check.resources.length > 0 ? check.resources : ["*"];
}

function dedupe(values: string[]): string[] {
	return [...new Set(values.filter((value) => value.length > 0))];
}

export function describe(resources: string[]): string {
	const list = resources.length > 0 ? resources : ["*"];
	if (list.length === 1) return list[0];
	return `${list[0]} (+${list.length - 1} more)`;
}

export function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Stable stringify + hash so identical inputs produce identical signatures. */
export function stableHash(value: unknown): string {
	return hashString(stableStringify(value));
}

export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function hashString(input: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < input.length; index++) {
		hash ^= input.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/** True when the path exists and is a directory. */
export function isDirectory(absolute: string): boolean {
	try {
		return statSync(absolute).isDirectory();
	} catch {
		return false;
	}
}

/** Canonical path, falling back to the lexical path when it does not exist. */
export function canonicalPath(absolute: string): string {
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}
