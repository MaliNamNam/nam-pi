/**
 * Shared types for the OpenCode-style safeguards extension.
 *
 * The vocabulary mirrors OpenCode's `permission` config:
 *   - action:   the tool/permission key ("read", "edit", "bash", "webfetch", ...)
 *   - resource: the thing being acted on (path, glob, command, url, ...)
 *   - effect:   "allow" | "ask" | "deny"
 */

export type Effect = "allow" | "ask" | "deny";

/** A pattern rule. `resource` uses OpenCode wildcard syntax. */
export interface Rule {
	action: string;
	resource: string;
	effect: Effect;
}

export type Ruleset = Rule[];

/** Object or scalar form, matching OpenCode's config syntax. */
export type RuleConfig = Effect | Record<string, Effect>;

export type PermissionConfig = RuleConfig | Record<string, RuleConfig>;

/** Result of resolving one resource against the ruleset. */
export interface Decision {
	effect: Effect;
	/** The rule that produced the decision, when one matched. */
	rule?: Rule;
	/** True when no rule matched and the fallback effect was used. */
	fallback?: boolean;
	/** Pattern the user would grant with "always allow". */
	save: string;
	/** Resources that are part of the same request (for batch approvals). */
	resources: string[];
}

/** What the user chose in the permission prompt. */
export type PermissionReply = "once" | "always" | "reject";

/** A pending prompt, used to de-duplicate parallel identical requests. */
export interface PendingPrompt {
	key: string;
	promise: Promise<PermissionReply>;
}
