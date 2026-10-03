import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Persisted non-context marker, also emitted in Pi JSON/RPC/SDK event streams. */
export const INTERACTION_DECLINED = "pi-agents-interaction-declined";
export type DeclineReason = "permission" | "question";

/** One requesting execution, not a process, SDK worker, or whole session family. */
export class ExecutionInteractions {
	private nonce = randomUUID();
	private controller = new AbortController();
	private stopped = false;
	private readonly append: (type: string, data: unknown) => void;
	constructor(append: ExecutionInteractions["append"]) { this.append = append; }
	get id(): string { return this.nonce; }
	get signal(): AbortSignal { return this.controller.signal; }
	begin(): void {
		this.controller.abort(); // late replies from the previous execution are stale
		this.nonce = randomUUID(); this.controller = new AbortController(); this.stopped = false;
	}
	cancel(): void { this.controller.abort(); }
	decline(ctx: Pick<ExtensionContext, "abort">, id: string, reason: DeclineReason, signal: AbortSignal): boolean {
		if (id !== this.nonce || this.stopped || signal.aborted || this.controller.signal.aborted) return false;
		this.stopped = true;
		// Record before abort: a tool-phase abort need not produce an assistant
		// stopReason=aborted, so child completion must not be reported as success.
		try { this.append(INTERACTION_DECLINED, { version: 1, interactionID: id, reason }); }
		finally {
			this.controller.abort(); // settle same-execution permission/question waits
			ctx.abort(); // Pi's non-awaiting, session-scoped operation abort
		}
		return true;
	}
}

/** Only this versioned marker can turn a child result into explicit cancellation. */
export function declinedEvent(value: unknown): boolean {
	const event = value as { type?: unknown; entry?: { customType?: unknown; data?: { version?: unknown; interactionID?: unknown; reason?: unknown } } } | null;
	const data = event?.entry?.data;
	return event?.type === "entry_appended" && event.entry?.customType === INTERACTION_DECLINED && data?.version === 1 &&
		typeof data.interactionID === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(data.interactionID) && ["permission", "question"].includes(String(data.reason));
}
