/**
 * `@agent` autocomplete.
 *
 * OpenCode offers subagents in the `@` autocomplete menu. Pi already uses `@`
 * for file arguments, so this provider offers the same menu for the `::name`
 * mention form the input handler accepts, plus `@name` for agents whose name
 * does not collide with a file.
 *
 * The provider delegates to the built-in one whenever the token is not an agent
 * mention, so file completion keeps working unchanged.
 */

import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import type { AgentDefinition } from "./types.ts";

/**
 * Matches an agent mention at a token boundary.
 *
 * `@name` is OpenCode's form. `::name` stays as an alias because a CLI argument
 * (`pi "@explore ..."`) is resolved as a file by Pi's argument parser, so the
 * `::` spelling is the one that works from the shell.
 */
export function extractAgentToken(textBeforeCursor: string): string | undefined {
	const at = textBeforeCursor.match(/(?:^|[ \t])@([^\s@:]*)$/);
	if (at) return at[1];
	const colon = textBeforeCursor.match(/(?:^|[ \t])::([^\s:]*)$/);
	return colon?.[1];
}

/** The prefix the completion replaces, so inserted text keeps the typed form. */
export function mentionPrefix(token: string, textBeforeCursor: string): string {
	return textBeforeCursor.trimEnd().endsWith(`@${token}`) ? `@${token}` : `::${token}`;
}

/** Agents offered for completion, sorted by id, hidden ones excluded. */
export function completableAgents(all: AgentDefinition[]): AgentDefinition[] {
	return all
		.filter((agent) => agent.mode !== "primary")
		.filter((agent) => !agent.hidden)
		.toSorted((left, right) => left.id.localeCompare(right.id));
}

export function formatAgentItem(agent: AgentDefinition): AutocompleteItem {
	return {
		value: `@${agent.id}`,
		label: agent.id,
		description: agent.description || "This subagent should only be called when explicitly requested.",
	};
}

/** Filter by id prefix, falling back to substring matches. */
export function filterAgents(all: AgentDefinition[], query: string): AutocompleteItem[] {
	const agents = completableAgents(all);
	const normalized = query.toLowerCase();
	if (!normalized) return agents.map(formatAgentItem);
	const matches = agents.filter(
		(agent) => agent.id.toLowerCase().startsWith(normalized) || agent.description.toLowerCase().includes(normalized),
	);
	return matches.map(formatAgentItem);
}

export function createAgentAutocompleteProvider(
	current: AutocompleteProvider,
	getAgents: () => AgentDefinition[],
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const textBeforeCursor = currentLine.slice(0, cursorCol);
			const token = extractAgentToken(textBeforeCursor);
			if (token === undefined) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const suggestions = filterAgents(getAgents(), token);
			if (suggestions.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			return { items: suggestions, prefix: mentionPrefix(token, textBeforeCursor) };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}
