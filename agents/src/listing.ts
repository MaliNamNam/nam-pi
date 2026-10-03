/**
 * Dynamic subagent listing.
 *
 * Ported from OpenCode v2's `context` hook in
 * `packages/core/src/tool/plugin/subagent.ts`:
 *
 *   const available = (yield* agents.list())
 *     .filter((agent) =>
 *       agent.mode !== "primary" &&
 *       !agent.hidden &&
 *       Permission.evaluate(name, agent.id, selected.permissions).effect !== "deny")
 *     .toSorted((a, b) => a.id.localeCompare(b.id))
 *   tool.description = [
 *     tool.description,
 *     "",
 *     "Available subagents:",
 *     ...available.map((agent) =>
 *       `- ${agent.id}: ${agent.description ?? "This subagent should only be called when explicitly requested."}`),
 *   ].join("\n")
 *
 * OpenCode rewrites the tool description before every request (context,
 * compaction, and generate hooks). Pi has no tool-description mutator, so the
 * equivalent is a context entry listing the same agents. The filter, the sort,
 * and the fallback text are identical.
 */

import { canDispatch } from "./permissions.ts";
import type { AgentDefinition } from "./types.ts";

/** OpenCode's fallback when an agent has no description. */
export const NO_DESCRIPTION = "This subagent should only be called when explicitly requested.";

/**
 * Subagents the given parent may dispatch, sorted by id.
 *
 * Mirrors OpenCode's filter exactly: not primary, not hidden, and not denied by
 * the parent's `subagent` permission.
 */
export function availableSubagents(all: AgentDefinition[], parent: AgentDefinition | undefined): AgentDefinition[] {
	return all
		.filter((agent) => agent.mode !== "primary")
		.filter((agent) => !agent.hidden)
		.filter((agent) => (parent ? canDispatch(parent.permissions, agent.id) : true))
		.toSorted((left, right) => left.id.localeCompare(right.id));
}

/** The listing OpenCode appends to the tool description. */
export function subagentListing(all: AgentDefinition[], parent: AgentDefinition | undefined): string | undefined {
	const available = availableSubagents(all, parent);
	if (available.length === 0) return undefined;
	return [
		"Available subagents:",
		...available.map((agent) => `- ${agent.id}: ${agent.description || NO_DESCRIPTION}`),
	].join("\n");
}
