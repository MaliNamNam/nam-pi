import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { permissionKey, type FormReply, type PermissionCheck } from "./forms.ts";

/** Versioned event-bus contract; safeguards implements it without importing agents. */
export const APPROVAL_BRIDGE = "pi-agents:approval-bridge:v1";
export const PERMISSION_POLICIES = "pi-agents:permission-policies:v1";
export interface PermissionAssessment { checks: PermissionCheck[]; reason?: string; denied?: string; }
export interface PermissionPolicy { assess(): PermissionAssessment; }
export type PermissionBlock = { block: true; reason: string } | undefined;
export interface ApprovalBridge { guard(event: ToolCallEvent, ctx: ExtensionContext): Promise<PermissionBlock>; }
export interface BridgeQuery { version: 1; connect(bridge: ApprovalBridge): void; }
export interface PolicyQuery { version: 1; event: ToolCallEvent; context: ExtensionContext; add(policy: PermissionPolicy): void; }

interface ApprovalEntry {
	input: string;
	policies: PermissionPolicy[];
	ready: Promise<string | undefined>;
	approved: Set<string>;
	signal: AbortSignal;
}
interface CoordinatorOptions {
	policies(event: ToolCallEvent, ctx: ExtensionContext): PermissionPolicy[];
	signal(ctx: ExtensionContext): AbortSignal;
	prompt(event: ToolCallEvent, ctx: ExtensionContext, assessment: PermissionAssessment, signal: AbortSignal): Promise<FormReply>;
	/** Explicit user rejection only; policy/transport failures never invoke this. */
	onDeclined?(event: ToolCallEvent, ctx: ExtensionContext, signal: AbortSignal): void;
}

/** One preflight/prompt for all policies, independent of extension load order. */
export class ApprovalCoordinator implements ApprovalBridge {
	private readonly entries = new Map<string, ApprovalEntry>();
	private readonly options: CoordinatorOptions;
	constructor(options: CoordinatorOptions) { this.options = options; }
	clear(): void { this.entries.clear(); }
	forget(id: string): void { this.entries.delete(id); }

	async guard(event: ToolCallEvent, ctx: ExtensionContext): Promise<PermissionBlock> {
		// Bind a once reply to the exact session, call ID and arguments, not just
		// a path. Parallel calls and later reuse of an ID cannot share approval.
		const id = event.toolCallId ? JSON.stringify([ctx.sessionManager.getSessionId(), event.toolCallId]) : undefined;
		const input = JSON.stringify([event.toolName, event.input]);
		let entry = id ? this.entries.get(id) : undefined;
		if (!entry || entry.input !== input) {
			const signal = this.options.signal(ctx);
			let policies: PermissionPolicy[];
			try { policies = this.options.policies(event, ctx); }
			catch { return { block: true, reason: "Permission policy unavailable" }; }
			entry = { input, policies, ready: Promise.resolve(undefined), approved: new Set(), signal };
			if (id) this.entries.set(id, entry);
			entry.ready = this.approve(entry, event, ctx);
		}
		const denied = await entry.ready;
		if (denied) return { block: true, reason: denied };
		if (entry.signal.aborted) return { block: true, reason: "Permission request cancelled" };
		// Recheck even when the second interceptor reuses the reply: a changed
		// hard deny, resource, symlink target or step budget always wins.
		const current = this.assess(entry.policies);
		if (current.denied) return { block: true, reason: current.denied };
		if (current.checks.some((check) => !entry.approved.has(permissionKey(check)))) {
			return { block: true, reason: current.reason ?? "Permission requires approval" };
		}
		return undefined;
	}

	private assess(policies: PermissionPolicy[]): PermissionAssessment {
		const checks = new Map<string, PermissionCheck>(), reasons = new Set<string>();
		try {
			for (const policy of policies) {
				const decision = policy.assess();
				if (decision.denied) return { checks: [], denied: decision.denied };
				for (const check of decision.checks) checks.set(permissionKey(check), check);
				if (decision.reason) reasons.add(decision.reason);
			}
		} catch { return { checks: [], denied: "Permission policy unavailable" }; }
		return { checks: [...checks.values()], reason: [...reasons].join("\n") || undefined };
	}

	private async approve(entry: ApprovalEntry, event: ToolCallEvent, ctx: ExtensionContext): Promise<string | undefined> {
		const assessment = this.assess(entry.policies);
		if (assessment.denied) return assessment.denied;
		if (entry.signal.aborted) return "Permission request cancelled";
		if (!assessment.checks.length) return undefined;
		let reply: FormReply;
		try { reply = await this.options.prompt(event, ctx, assessment, entry.signal); }
		catch { return "Permission approval unavailable"; }
		if (entry.signal.aborted) return "Permission request cancelled";
		if (reply.reply === "reject") {
			if (reply.reason === "declined") this.options.onDeclined?.(event, ctx, entry.signal);
			return reply.reason === "declined" ? "The user declined this tool call" : assessment.reason ?? "Permission requires approval";
		}
		for (const check of assessment.checks) entry.approved.add(permissionKey(check));
		return undefined;
	}
}
