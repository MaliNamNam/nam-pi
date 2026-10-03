import { randomUUID } from "node:crypto";
import type { AgentDefinition, PermissionRule } from "./types.ts";
import { matchWildcard } from "./permissions.ts";

export const LIVE_PREPARE = "agent-live-prepare";
export const LIVE_CANCEL = "agent-live-cancel";
export const LIVE_APPLIED = "subagent-live-applied";
export const LIVE_PREPARED = "subagent-live-prepared";
export const LIVE_FAILED = "subagent-live-failed";
export interface LiveInputUpdate { agent: AgentDefinition; model?: string; thinkingLevel?: string; }
interface Prepared { id: string; sessionID: string; update: LiveInputUpdate; applied: boolean; }
const ID = /^[a-f0-9-]{36}$/;
const FRAME = /<pi-agent-live:([a-f0-9-]{36})>\n/;
/** Shared SDK eligibility rule: switching cannot upgrade a leaf worker to nested ownership. */
export function leafPolicy(rules: readonly PermissionRule[]): boolean {
	const last = rules.filter((rule) => matchWildcard("subagent", rule.action)).at(-1);
	return last?.resource === "*" && last.effect === "deny";
}
const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const rule = (value: unknown): value is PermissionRule => record(value) && string(value.action) && typeof value.resource === "string" && typeof value.effect === "string" && ["allow", "ask", "deny"].includes(value.effect);

/** No task text in the control command, and no policy/model data in queued/model-visible text. */
export function liveInputCommand(sessionID: string, update: LiveInputUpdate, text: string): { id: string; command: string; text: string } {
	const id = randomUUID();
	const payload = JSON.stringify({ version: 1, id, sessionID, update });
	if (Buffer.byteLength(payload) > 1024 * 1024) throw new Error("Live child configuration exceeds 1 MiB");
	return { id, command: `/${LIVE_PREPARE} ${id} ${Buffer.from(payload).toString("base64")}`, text: `<pi-agent-live:${id}>\n${text}` };
}

export function decodeLiveInput(encoded: string, sessionID: string): Omit<Prepared, "applied"> {
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 1400000) throw new Error("Invalid live child configuration");
	let data: unknown;
	try { data = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")); } catch { throw new Error("Invalid live child configuration"); }
	if (!record(data) || data.version !== 1 || typeof data.id !== "string" || !ID.test(data.id) || data.sessionID !== sessionID || !record(data.update)) throw new Error("Live child configuration identity mismatch");
	const { agent, model, thinkingLevel } = data.update;
	if (!record(agent) || !string(agent.id) || typeof agent.name !== "string" || !["all", "subagent"].includes(String(agent.mode)) || typeof agent.systemPrompt !== "string" || !Array.isArray(agent.permissions) || !agent.permissions.every(rule)) throw new Error("Invalid live child agent/policy");
	if (agent.toolsFromPermissions !== undefined && typeof agent.toolsFromPermissions !== "boolean") throw new Error("Invalid live child cap metadata");
	if (agent.tools !== undefined && (!Array.isArray(agent.tools) || !agent.tools.every((name) => typeof name === "string"))) throw new Error("Invalid live child tool cap");
	for (const field of ["model", "variant"]) if (agent[field] !== undefined && !string(agent[field])) throw new Error(`Invalid agent ${field}`);
	for (const field of ["temperature", "topP", "steps"]) if (agent[field] !== undefined && (typeof agent[field] !== "number" || !Number.isFinite(agent[field]))) throw new Error(`Invalid agent ${field}`);
	if (model !== undefined && !string(model) || thinkingLevel !== undefined && !levels.has(String(thinkingLevel))) throw new Error("Invalid live child model/thinking level");
	return { id: data.id, sessionID, update: { agent: agent as unknown as AgentDefinition, ...(model ? { model: model as string } : {}), ...(thinkingLevel ? { thinkingLevel: thinkingLevel as string } : {}) } };
}

type Message = { role: string; content?: unknown };
function texts(message: Message): string[] {
	return typeof message.content === "string" ? [message.content] : Array.isArray(message.content)
		? message.content.filter((part) => record(part) && part.type === "text" && typeof part.text === "string").map((part) => part.text as string) : [];
}

/** Prepared configuration is inert until its actual queued user message is next. */
export class LiveInputs {
	private readonly prepared = new Map<string, Prepared>();
	clear(): void { this.prepared.clear(); }
	prepare(input: Omit<Prepared, "applied">): void {
		if (this.prepared.has(input.id)) throw new Error("Duplicate live child input transaction");
		if (this.prepared.size >= 64) throw new Error("Too many pending live child updates");
		this.prepared.set(input.id, { ...input, applied: false });
	}
	cancel(id: string): void { if (!this.prepared.get(id)?.applied) this.prepared.delete(id); }
	private find(message: Message): Prepared | undefined {
		for (const text of texts(message)) { const match = FRAME.exec(text); if (match && this.prepared.has(match[1])) return this.prepared.get(match[1]); }
		return undefined;
	}
	async boundary(messages: readonly Message[], apply: (input: LiveInputUpdate, id: string) => Promise<void>): Promise<void> {
		const first = messages.find((message) => message.role === "user");
		const next = first && this.find(first);
		if (!next || next.applied) return;
		await apply(next.update, next.id);
		next.applied = true;
	}
	/** Pi replaces finalized messages in place before persisting/projecting them. */
	consume<T extends Message>(message: T): T | undefined {
		if (message.role !== "user") return undefined;
		const input = this.find(message);
		if (!input) return undefined;
		if (!input.applied) throw new Error("Live child input reached the transcript before its safe boundary");
		this.prepared.delete(input.id);
		const marker = `<pi-agent-live:${input.id}>\n`;
		return { ...message, content: typeof message.content === "string" ? message.content.replace(marker, "") :
			(message.content as Record<string, unknown>[]).map((part) => part.type === "text" ? { ...part, text: (part.text as string).replace(marker, "") } : part) };
	}
}
