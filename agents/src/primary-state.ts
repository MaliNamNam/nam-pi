import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./types.ts";

export const PRIMARY_SELECTION_TYPE = "opencode-primary-agent";

/** Recover the active primary from the selected branch, not the process's last session. */
export function restorePrimaryAgent(entries: readonly SessionEntry[], agents: AgentDefinition[]): {
	id: string;
	needsLeaveReminder: boolean;
} {
	let requested: string | undefined;
	let lastReminder: "plan-mode-reminder" | "plan-mode-leave" | undefined;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === PRIMARY_SELECTION_TYPE) {
			const id = (entry.data as { id?: unknown } | undefined)?.id;
			requested = typeof id === "string" ? id : "build";
		}
		if (entry.type === "custom_message" &&
			(entry.customType === "plan-mode-reminder" || entry.customType === "plan-mode-leave")) {
			lastReminder = entry.customType;
		}
	}
	const selectable = (agent: AgentDefinition) => agent.mode !== "subagent" && !agent.hidden;
	const fallback = agents.find((agent) => agent.id === "build" && selectable(agent)) ?? agents.find(selectable);
	const id = agents.some((agent) => agent.id === requested && selectable(agent)) ? requested! : fallback?.id ?? "build";
	return { id, needsLeaveReminder: id !== "plan" && lastReminder === "plan-mode-reminder" };
}
