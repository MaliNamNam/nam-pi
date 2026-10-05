import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { parseModelRef } from "./models.ts";

export const SUBAGENT_MODELS_TYPE = "pi-subagent-model";

/** Session-wide assignments: each role's latest receipt wins across tree branches. */
export function restoreSubagentModels(entries: readonly SessionEntry[]): Map<string, string | null> {
	const models = new Map<string, string | null>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SUBAGENT_MODELS_TYPE) continue;
		const data = entry.data as { agent?: unknown; model?: unknown } | undefined;
		if (typeof data?.agent !== "string") continue;
		if (data.model === null) models.set(data.agent, null);
		else if (typeof data.model === "string") {
			try { parseModelRef(data.model); models.set(data.agent, data.model); }
			catch { /* malformed saved assignments do not replace a valid one */ }
		}
	}
	return models;
}
