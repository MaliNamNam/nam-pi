import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { SafeguardEngine, ToolRequest } from "./engine.ts";

// Structural, versioned contract: safeguards remains installable on its own.
// The matching coordinator lives in agents/src/approvals.ts.
const APPROVAL_BRIDGE = "pi-agents:approval-bridge:v1";
const PERMISSION_POLICIES = "pi-agents:permission-policies:v1";
type PermissionBlock = { block: true; reason: string } | undefined;
interface Assessment { checks: Array<{ action: string; resource: string }>; reason?: string; denied?: string; }
interface ApprovalBridge { guard(event: ToolCallEvent, ctx: ExtensionContext): Promise<PermissionBlock>; }
interface PolicyQuery { version: 1; event: ToolCallEvent; context: ExtensionContext; add(policy: { assess(): Assessment }): void; }

export function findApprovalBridge(pi: ExtensionAPI): ApprovalBridge | undefined {
	let bridge: ApprovalBridge | undefined;
	pi.events?.emit(APPROVAL_BRIDGE, { version: 1, connect(value: ApprovalBridge) { bridge = value; } });
	return bridge;
}

/** Contribute every check before either extension opens a permission dialog. */
export function registerPermissionPolicy(pi: ExtensionAPI, currentEngine: () => SafeguardEngine,
	buildRequest: (engine: SafeguardEngine, event: ToolCallEvent) => ToolRequest | undefined): void {
	pi.events?.on(PERMISSION_POLICIES, (data) => {
		const query = data as PolicyQuery;
		if (query?.version !== 1 || typeof query.add !== "function") return;
		const engine = currentEngine();
		let repeats: number | undefined;
		query.add({ assess: () => {
			// Revalidation must not count as another identical tool call.
			repeats ??= engine.recordCall(query.event.toolName, query.event.input ?? {});
			const request = buildRequest(engine, query.event);
			const requests: ToolRequest[] = request ? [request] : [];
			if (engine.config.doomLoop && repeats >= engine.config.doomLoopThreshold) {
				requests.push(engine.doomLoopRequest(query.event.toolName, query.event.input ?? {}, repeats));
			}
			const checks: Assessment["checks"] = [], reasons: string[] = [];
			for (const item of requests) {
				const decision = engine.assess(item);
				if (decision.denied) return { checks: [], denied: decision.denied };
				checks.push(...decision.checks);
				if (decision.reason) reasons.push(decision.reason);
			}
			return { checks, reason: reasons.join("\n") || undefined };
		} });
	});
}
