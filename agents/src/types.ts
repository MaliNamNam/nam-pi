/**
 * Shared types for the OpenCode-compatible agent system.
 */

/** Where an agent definition came from. Later sources override earlier ones. */
export type AgentSource = "builtin" | "user" | "project";

/** OpenCode agent mode. */
export type AgentMode = "primary" | "subagent" | "all";

/** OpenCode permission rule, as produced by its `permission` config. */
export interface PermissionRule {
	action: string;
	resource: string;
	effect: "allow" | "ask" | "deny";
}

export interface AgentDefinition {
	/** Agent id used in `@` mentions and the `subagent` tool's `agent` parameter. */
	id: string;
	/** Display name. */
	name: string;
	/** When to use this agent. Empty uses OpenCode's fallback listing text. */
	description: string;
	mode: AgentMode;
	/** Hide from listings. Only meaningful for `subagent`, as in OpenCode. */
	hidden: boolean;
	/** Replaces the default system prompt for this agent. */
	systemPrompt: string;
	/**
	 * Pi tool allowlist. `undefined` means every tool is available.
	 * Config-derived caches are rebuilt after rule merging; per-call checks still
	 * enforce resource restrictions. Manual role/tool caps remain independent.
	 */
	tools: string[] | undefined;
	/** True for a permission-derived cache; false preserves an explicit role cap. */
	toolsFromPermissions?: boolean;
	/** OpenCode permission ruleset. Evaluated last-match-wins. */
	permissions: PermissionRule[];
	/** Model override, `provider/model` or `provider/model:thinking`. */
	model?: string;
	/** Default thinking level for this agent (Pi's native field). */
	thinkingLevel?: string;
	/**
	 * OpenCode's `variant`, e.g. "max". Applies only when this agent's own
	 * `model` is used, matching OpenCode's documented behavior.
	 */
	variant?: string;
	/**
	 * True when `mode` came from config rather than the default. Lets a merge
	 * distinguish an explicit `mode: "all"` from an omitted one.
	 */
	modeExplicit?: boolean;
	/** Presence-sensitive config fields: omitted is not false/empty/generated. */
	configuredFields?: Array<"name" | "description" | "hidden" | "systemPrompt">;
	/** Sampling temperature, injected into the provider request. */
	temperature?: number;
	/** Nucleus sampling, injected into the provider request. */
	topP?: number;
	/** Max agentic iterations before forcing a text response. */
	steps?: number;
	/** Marked experimental in OpenCode. Disabled unless explicitly enabled. */
	experimental?: boolean;
	/** File this definition came from, when not built-in. */
	filePath?: string;
	/** Set by the discovery layer; built-in definitions omit it. */
	source?: AgentSource;
}

/** Result of resolving an agent by id or name. */
export interface AgentResolution {
	agent: AgentDefinition | undefined;
	/** True when the caller passed a name that matched nothing. */
	unknown: boolean;
}

/** Options controlling discovery. */
export interface DiscoveryOptions {
	cwd: string;
	/** Load project-local agents. Off by default, matching the subagent example's trust model. */
	agentScope?: "user" | "project" | "both";
	/** Include experimental agents such as Scout. */
	experimental?: boolean;
	/** Extra directories to scan, from `safeguards.agents.paths`. */
	paths?: string[];
}
