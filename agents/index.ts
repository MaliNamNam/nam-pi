/**
 * OpenCode-style Agents for Pi
 *
 * Ports OpenCode v2's agent system to Pi: primary agents and subagents, the
 * `subagent` dispatch tool with foreground and background modes, session
 * continuation, name mentions, and OpenCode's permission rulesets.
 *
 * Built-in agents (verbatim prompts and permissions from OpenCode):
 *   build    primary   default agent, all tools
 *   plan     primary   read-only planning
 *   general  subagent  full tool access, multi-step work
 *   explore  subagent  read-only codebase search
 *   scout    subagent  external docs/dependency research (experimental)
 *
 * Usage:
 *   ::explore find where auth tokens are validated
 *   /agents                     list agents and their tools
 *   /agent explore              switch the primary agent
 *   /agents running             list running background subagents
 *
 * The `subagent` tool uses OpenCode's parameters plus opt-in workspace isolation:
 *   agent, description, prompt, model, sessionID, background, isolation
 */

import path from "node:path";
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createPowerShellToolDefinition, getAgentDir, getMarkdownTheme, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, MouseRegion, Text, matchesKey, stripTerminalSequences } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents, PLAN_LEAVE_REMINDER, PLAN_REMINDER, primaryAgents, subagents } from "./src/config.ts";
import { JobRegistry, type JobOutcome } from "./src/jobs.ts";
import { createAgentAutocompleteProvider } from "./src/autocomplete.ts";
import { blockedByRules, decodePermissions, requiresApproval } from "./src/enforce.ts";
import { childSessionDir, claimChild, findOwnedChild, listOwnedChildren, migrateOwnedChild, setChildStatus, switchChildAgent, type OwnerContext } from "./src/ownership.ts";
import { listSessionFamily, type FamilyChild } from "./src/family.ts";
import { ChildInterrupts, requestChildInterrupt } from "./src/interrupts.ts";
import { ShellRuns, cancelShellRun, readShellRuns, shellOutput, shellStatusLabel, type ShellRun } from "./src/shells.ts";
import { shellFrameRenderers } from "./src/mac-frame.ts";
import { AGENTS_UI_CONNECT, AGENTS_UI_REQUEST, AGENTS_UI_STATE, AGENTS_UI_DECORATE, type AgentsUIController, type ChildPageDecoration } from "./src/ui.ts";
import { FormHost, requestForm, type PermissionCheck } from "./src/forms.ts";
import { ExecutionInteractions } from "./src/interactions.ts";
import { ApprovalCoordinator, APPROVAL_BRIDGE, PERMISSION_POLICIES, type BridgeQuery, type PermissionPolicy, type PolicyQuery } from "./src/approvals.ts";
import { showRootForm } from "./src/form-ui.ts";
import { PRIMARY_SELECTION_TYPE, restorePrimaryAgent } from "./src/primary-state.ts";
import { availableSubagents, subagentListing } from "./src/listing.ts";
import { SUBAGENT_MODELS_TYPE, restoreSubagentModels } from "./src/subagent-models.ts";
import { SubagentModelPicker, type SubagentModelEntry } from "./src/subagent-model-picker.ts";
import {
	applyProviderOptions,
	decodeProviderOptions,
	hasProviderOptions,
	providerOptions,
} from "./src/provider-options.ts";
import {
	invalidModelMessage,
	clampPiVariant,
	parseModelRef,
	selectChildModel,
	supportedPiVariants,
	toPiModelArgument,
	unavailableModelMessage,
	unavailableVariantMessage,
} from "./src/models.ts";
import { canDispatch, DEFAULT_AGENT_PERMISSIONS, filterToolNames } from "./src/permissions.ts";
import { MAX_STEPS_CUSTOM_TYPE, MAX_STEPS_PROMPT, StepCounter, TOOLS_DISABLED_MESSAGE } from "./src/steps.ts";
import { ChildProgress, type SubagentToolDetails } from "./src/progress.ts";
import { completedSubagentResult, subagentResultOutput } from "./src/subagent-result.ts";
import { OpenCodeComposerEditor, type ComposerChild } from "./src/composer.ts";
import { ChildSessionPage, ChildTranscriptView, readChildTimeline, readChildTranscript, type ChildTranscript, type ChildToolDefinition } from "./src/view.ts";
import { childSystemPrompt, backgroundNotice, forgetDetachedResult, readDetachedResult, runAgent, stopChildProcesses, subagentEnvelope, type DetachedRun, type RunHandle, type RunResult } from "./src/runner.ts";
import { awaitForeground } from "./src/foreground.ts";
import type { AgentDefinition } from "./src/types.ts";
import { captureChildPresentation } from "./src/presentation.ts";
import { decodeLiveInput, leafPolicy, LiveInputs, LIVE_PREPARE, LIVE_CANCEL, LIVE_APPLIED, LIVE_PREPARED, LIVE_FAILED, type LiveInputUpdate } from "./src/live-input.ts";
import { prepareWorktree, createWorktree, verifyWorktree, validWorktree, withWorktreeReport, type WorktreeWorkspace } from "./src/worktrees.ts";

/** OpenCode's default when `experimental.subagent_depth` is unset. */
const DEFAULT_SUBAGENT_DEPTH = 1;

export default function agents(pi: ExtensionAPI): void {
	// Child inspection must use the same registered renderers as the root (not
	// fresh native definitions that discard UI extensions such as shell frames).
	const childToolDefinitions = new Map<string, ChildToolDefinition>();
	const registerTool: ExtensionAPI["registerTool"] = (definition) => {
		childToolDefinitions.set(definition.name, definition);
		pi.registerTool(definition);
	};
	let agents: AgentDefinition[] = [];
	/** The primary agent for this session. `build` is OpenCode's default. */
	let activePrimary = "build";
	let pendingLeavePlan = false;
	let pendingStepReset = false;
	/** Set while this process is itself a dispatched subagent. */
	let runningAsSubagent: string | undefined;
	let missingDispatchedAgent = false;
	let liveAgent: AgentDefinition | undefined;
	const liveInputs = new LiveInputs();
	/** Working directory, captured per session. */
	let cwd = process.cwd();
	/** Whether the extension runtime is still live enough to deliver messages. */
	let runtimeActive = true;
	/** Prevent concurrent timer/turn collectors from delivering the same record twice. */
	let deliveryInFlight: Promise<void> | undefined;
	let deliveryTimer: ReturnType<typeof setInterval> | undefined;
	let hasFinishedTurn = false;
	/** Retain the run's signal so idle delivery cannot resume a cancelled run. */
	let deliverySignal: AbortSignal | undefined;
	let sessionGeneration = 0;
	let parentSessionID: string | undefined;
	const pendingNotices = new Map<string, {
		registry: JobRegistry;
		generation: number;
		timer: ReturnType<typeof setTimeout>;
	}>();
	let acknowledgedChildren = new Set<string>();
	const clearPendingNotices = (): void => {
		for (const pending of pendingNotices.values()) clearTimeout(pending.timer);
		pendingNotices.clear();
	};
	/** Per-session agentic step counter, for OpenCode's `steps` limit. */
	const steps = new StepCounter();

	/**
	 * The permission ruleset this process must enforce.
	 *
	 * A dispatched child receives its agent's ruleset from the parent, because
	 * OpenCode evaluates permissions per call and Pi's tool allowlist cannot
	 * express that. A top-level process reads the ruleset of the agent it is
	 * running as, if any.
	 */
	const strictShellEnabled = (): boolean =>
		pi.getFlag("agent-strict-shell") === true || process.env.PI_AGENT_STRICT_SHELL === "1";

	const activeRules = (): ReturnType<typeof decodePermissions> => {
		if (missingDispatchedAgent || !currentAgent()) return [...DEFAULT_AGENT_PERMISSIONS, { action: "*", resource: "*", effect: "deny" }];
		if (!runningAsSubagent) {
			const agent = currentAgent();
			if (agent?.id !== "plan") return [...DEFAULT_AGENT_PERMISSIONS, ...(agent?.permissions ?? [])];
			const target = path.join(planDirectory(), "*").replaceAll("\\", "/");
			return [
				...DEFAULT_AGENT_PERMISSIONS,
				...agent.permissions,
				{ action: "edit", resource: target, effect: "allow" },
				{ action: "external_directory", resource: target, effect: "allow" },
			];
		}
		if (liveAgent) return [...DEFAULT_AGENT_PERMISSIONS, ...liveAgent.permissions];
		const encoded = pi.getFlag("agent-permissions");
		return [...DEFAULT_AGENT_PERMISSIONS, ...(encoded ? decodePermissions(encoded) : (currentAgent()?.permissions ?? []))];
	};

	/** Prevent two tool calls in this process from writing the same child session concurrently. */
	const activeChildren = new Set<string>();
	const foregroundRuns = new Map<string, { run: DetachedRun; result: Promise<RunResult> }>();
	const agentReceipts = new WeakSet<RunHandle>();
	const agentMetadata = new Map<string, Promise<void>>();
	const receiptRuns = new Map<string, { child: RunHandle; owner: OwnerContext; id: string }>();
	function observeLiveAgent(child: RunHandle, owner: OwnerContext, sessionID: string): void {
		const key = path.resolve(owner.sessionDir, sessionID);
		receiptRuns.set(key, { child, owner, id: sessionID });
		if (agentReceipts.has(child)) return;
		agentReceipts.add(child);
		child.on("agent_switch", (agent: string) => {
			const current = () => receiptRuns.get(key)?.child === child && child.agent === agent;
			const work = (agentMetadata.get(key) ?? Promise.resolve()).catch(() => {}).then(() => switchChildAgent(owner, sessionID, agent, current));
			agentMetadata.set(key, work);
			void work.catch((error) => {
				if (current() && runtimeActive && parentSessionID === owner.parentID) pi.appendEntry("subagent-agent-sync-failed", { childID: sessionID, error: error instanceof Error ? error.message : String(error) });
			}); // a live receipt never creates a second transcript writer
		});
	}
	const foregroundAborters = new Map<string, AbortController>();
	const foregroundBackgrounders = new Map<string, AbortController>();
	const newShellRuns = () => new ShellRuns(() => { if (tuiContext) void refreshComposer(tuiContext, sessionGeneration); });
	let shellRuns = newShellRuns();
	let shellSettings: SettingsManager | undefined;
	let composerEditor: OpenCodeComposerEditor | undefined;
	let uiController: AgentsUIController | undefined;
	let uiChildren: ComposerChild[] = [];
	let composerRefresh = 0;
	pi.events?.on(AGENTS_UI_REQUEST, () => {
		if (!runtimeActive || !uiController) return;
		pi.events.emit(AGENTS_UI_CONNECT, uiController);
		pi.events.emit(AGENTS_UI_STATE, { sessionID: uiController.sessionID, children: uiChildren });
	});
	let previousEditorFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
	let composerFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
	let removeComposerInputListener: (() => void) | undefined;
	let tuiContext: ExtensionContext | undefined;
	let childPageOpen = false;
	let closeChildPage: (() => void) | undefined;
	let subagentModels = new Map<string, string | null>();
	let modelPickerOpen = false;
	let closeModelPicker: (() => void) | undefined;
	let modelUpdateWork: Promise<unknown> = Promise.resolve();
	let formHost: FormHost | undefined;
	let formReady: Promise<FormHost | undefined> | undefined;
	let sessionAborter = new AbortController();
	const interactions = new ExecutionInteractions((type, data) => pi.appendEntry(type, data));
	const closeForms = (): void => {
		sessionAborter.abort();
		interactions.cancel();
		const previous = formReady;
		formReady = undefined; formHost = undefined;
		void previous?.then((host) => host?.dispose()).catch(() => {});
	};
	const formsRoute = async (ctx: ExtensionContext): Promise<string | undefined> => {
		if (runningAsSubagent) return pi.getFlag("agent-forms-route") as string | undefined || process.env.PI_AGENT_FORMS;
		if (!ctx.hasUI || !runtimeActive) return undefined;
		const generation = sessionGeneration;
		formReady ??= FormHost.create(ownerContext(ctx).sessionDir,
			(request, signal) => showRootForm(ctx, request, signal),
			async () => new Set([ctx.sessionManager.getSessionId(), ...(await ownedFamily(ctx)).map((child) => child.id)]),
			() => runtimeActive && generation === sessionGeneration && !childPageOpen).then(async (host) => {
				if (!runtimeActive || generation !== sessionGeneration) { await host.dispose(); return undefined; }
				formHost = host;
				return host;
			}).catch(() => {
				if (generation === sessionGeneration && runtimeActive) ctx.ui.notify("Root form transport unavailable; permission asks will remain blocked", "warning");
				return undefined;
			});
		return (await formReady)?.route;
	};
	const approvals = new ApprovalCoordinator({
		signal: (ctx) => AbortSignal.any([sessionAborter.signal, interactions.signal, ...(ctx.signal ? [ctx.signal] : [])]),
		policies: (event, ctx) => {
			const policies: PermissionPolicy[] = [{ assess: () => {
				if (!runtimeActive) return { checks: [], denied: "Session unavailable" };
				if (runningAsSubagent && strictShellEnabled() && ["bash", "powershell"].includes(event.toolName)) {
					return { checks: [], denied: "Shell tools are disabled for this subagent (--agent-strict-shell)" };
				}
				if (steps.reached) return { checks: [], denied: TOOLS_DISABLED_MESSAGE };
				const checks: PermissionCheck[] = [];
				const reason = blockedByRules(activeRules(), event, { cwd: ctx.cwd, enforceExternal: !!runningAsSubagent, approvals: checks });
				return reason && !requiresApproval(reason) ? { checks: [], denied: reason } : { checks, reason };
			} }];
			pi.events?.emit(PERMISSION_POLICIES, { version: 1, event, context: ctx, add: (policy) => policies.push(policy) } satisfies PolicyQuery);
			return policies;
		},
		prompt: async (event, ctx, assessment, signal) => requestForm(await formsRoute(ctx), ctx.sessionManager.getSessionId(),
			{ kind: "permission", tool: event.toolName, reason: assessment.reason ?? "Permission requires approval", checks: assessment.checks }, signal, interactions.id),
		onDeclined: (_event, ctx, signal) => { interactions.decline(ctx, interactions.id, "permission", signal); },
	});
	pi.events?.on(APPROVAL_BRIDGE, (data) => {
		const query = data as BridgeQuery;
		if (query?.version === 1 && typeof query.connect === "function") query.connect(approvals);
	});
	pi.on("tool_result", (event, ctx) => { approvals.forget(JSON.stringify([ctx.sessionManager.getSessionId(), event.toolCallId])); });
	pi.on("turn_end", async (event, ctx) => {
		approvals.clear();
		try {
			await liveInputs.boundary(event.context?.pendingMessages ?? [], async (update, id) => {
				if (!runtimeActive || !runningAsSubagent || ctx.signal?.aborted) throw new Error("Child stopped before live configuration boundary");
				if ((pi.getSettings?.().steeringMode ?? "one-at-a-time") !== "one-at-a-time") throw new Error("Live switching requires one-at-a-time steering");
				const switched = currentAgent()?.id !== update.agent.id;
				const requested = update.model ?? (switched ? update.agent.model : undefined);
				const selected = requested ? resolveLiveModel(requested, update.thinkingLevel ?? (switched && !update.model ? update.agent.thinkingLevel ?? update.agent.variant : undefined), ctx) : undefined;
				if (selected && !await pi.setModel(selected.model)) throw new Error("The child model no longer has configured authentication");
				if (!runtimeActive || ctx.signal?.aborted) throw new Error("Child stopped during live configuration boundary");
				if (selected?.thinkingLevel) pi.setThinkingLevel(selected.thinkingLevel);
				liveAgent = update.agent; runningAsSubagent = update.agent.id; activePrimary = update.agent.id;
				missingDispatchedAgent = false; steps.reset(); steps.setLimit(update.agent.steps); pendingStepReset = false;
				applyToolPolicy();
				pi.appendEntry(LIVE_APPLIED, { sessionID: ctx.sessionManager.getSessionId(), id, agent: update.agent.id });
			});
		} catch (error) {
			missingDispatchedAgent = true; applyToolPolicy(); ctx.abort();
			pi.appendEntry(LIVE_FAILED, { sessionID: ctx.sessionManager.getSessionId(), error: error instanceof Error ? error.message : String(error) });
		}
		applyToolPolicy();
	});
	pi.on("message_end", (event, ctx) => {
		try { const message = liveInputs.consume(event.message); if (message) return { message }; }
		catch { missingDispatchedAgent = true; applyToolPolicy(); ctx.abort(); }
	});
	const callChildIDs = new Map<string, string>();
	const callBackgroundIDs = new Set<string>();
	const backgroundForegroundWork = (): number => {
		let count = 0;
		for (const controller of foregroundBackgrounders.values()) {
			if (!controller.signal.aborted) { controller.abort(); count++; }
		}
		return count;
	};
	/** Original session tools, restored when switching from Plan back to Build. */
	let unrestrictedTools: string[] | undefined;
	let restrictedTools: string[] | undefined;
	let toolsRestricted = false;

	/** Background jobs are per-workspace, like OpenCode's per-project state. */
	let jobs = new JobRegistry(cwd);
	let childInterrupts = new ChildInterrupts();
	let composerWork: Promise<void> | undefined;
	let composerDirty = false;
	const refreshComposer = (ctx: ExtensionContext, generation: number): Promise<void> => {
		if (ctx.mode !== "tui" || !runtimeActive || sessionGeneration !== generation) return Promise.resolve();
		composerDirty = true;
		if (composerWork) return composerWork;
		const work = (async () => {
			do {
				composerDirty = false;
				const refresh = ++composerRefresh;
				const { entries } = await composerFamily(ctx, jobs);
				if (generation !== sessionGeneration || !runtimeActive || refresh !== composerRefresh) return;
				uiChildren = entries;
				composerEditor?.update(entries, shellRuns.list().filter((shell) => shell.status === "running"));
				pi.events?.emit(AGENTS_UI_STATE, { sessionID: ctx.sessionManager.getSessionId(), children: entries });
			} while (composerDirty && runtimeActive && generation === sessionGeneration);
		})().catch(() => { /* A session switch can invalidate this asynchronous refresh. */ })
			.finally(() => { if (composerWork === work) composerWork = undefined; });
		return composerWork = work;
	};

	const interruptChild = async (ctx: ExtensionContext, id: string): Promise<string> => {
		const registry = jobs;
		const generation = sessionGeneration;
		const child = (await ownedFamily(ctx)).find((entry) => entry.id === id);
		if (generation !== sessionGeneration || !runtimeActive) return "Session changed";
		if (!child) return "Not a child of this conversation";
		if (child.depth > 1) return requestChildInterrupt(child.owner, id);
		const aborter = foregroundAborters.get(id);
		if (aborter) {
			aborter.abort();
			return `Interrupted ${id}`;
		}
		const result = await registry.cancel(id);
		if (result.cancelled) await setChildStatus(child.owner, id, "cancelled").catch(() => {});
		void refreshComposer(ctx, generation);
		return result.cancelled ? `Stopped ${id}` : result.reason ?? "Cannot interrupt this child";
	};

	/**
	 * Deliver completion notifications for background subagents.
	 *
	 * OpenCode's `SubagentCompletion.deliver` sends a `<subagent>` message into
	 * the parent session. Background runs are file-backed, so their outcome is read
	 * from disk between successful turns and periodically while idle. No completion
	 * is injected at session start or used to resume an aborted/failed run.
	 *
	 * A failure to deliver must not disable the feature for the rest of the
	 * session, so the record is left on disk and retried on the next trigger.
	 * Only a genuinely stale runtime stops further attempts.
	 */
	const collectCompletions = async (generation: number, deliverAs: "steer" | "followUp"): Promise<void> => {
		const signal = deliverySignal;
		const eligible = () => runtimeActive && hasFinishedTurn && sessionGeneration === generation &&
			signal === deliverySignal && !signal?.aborted;
		if (!eligible()) return;
		const registry = jobs;
		const owner = parentSessionID;
		try {
			const outcomes: JobOutcome[] = await registry.collect(owner);
			for (const outcome of outcomes) {
				// A session switch can happen during disk I/O. Never inject a child's
				// result into the new session or mark it delivered in the old one.
				if (!eligible()) return;
				const { record } = outcome;
				for (const [key, receipt] of receiptRuns) {
					if (receipt.id !== record.id || receipt.owner.parentID !== owner) continue;
					await agentMetadata.get(key)?.catch(() => {});
					record.agent = receipt.child.agent ?? record.agent;
				}
				if (!eligible()) return;
				// Pi's sendMessage API returns void; only the custom message_end event
				// proves that the completion was appended to the parent session.
				if (acknowledgedChildren.has(record.id)) {
					await registry.release(record.id);
					continue;
				}
				if (pendingNotices.has(record.id)) continue;
				const timer = setTimeout(() => {
					pendingNotices.delete(record.id); // retry a failed asynchronous send
				}, 30_000);
				timer.unref();
				pendingNotices.set(record.id, { registry, generation, timer });
				try {
					pi.sendMessage(
						{
							customType: "subagent-completion",
							content: subagentEnvelope({
								sessionID: record.id,
								state: outcome.status,
								output: withWorktreeReport(outcome.status === "completed" ? outcome.output : (outcome.error ?? "Subagent failed"), record.workspace),
								description: record.description,
							}),
							display: true,
							details: {
								source: "subagent",
								childID: record.id,
								agent: record.agent,
								state: outcome.status,
								description: record.description,
								usage: outcome.usage,
					model: outcome.model,
								...(record.workspace ? { workspace: record.workspace } : {}),
							},
						},
						{ triggerTurn: true, deliverAs },
					);
				} catch (error) {
					clearTimeout(timer);
					pendingNotices.delete(record.id);
					// Keep the record for a later attempt on a transient failure.
					if (isStaleRuntimeError(error)) runtimeActive = false;
					return;
				}
			}
		} catch {
			// I/O errors must not break the command surface; retry on the next tick.
		}
	};

	const deliverCompletions = async (generation: number, deliverAs: "steer" | "followUp" = "followUp"): Promise<void> => {
		const signal = deliverySignal;
		while (deliveryInFlight) {
			if (deliverAs !== "steer") return;
			// A boundary must finish collecting before the next provider request.
			await deliveryInFlight;
		}
		if (signal !== deliverySignal) return;
		const work = collectCompletions(generation, deliverAs);
		deliveryInFlight = work;
		try { await work; }
		finally { deliveryInFlight = undefined; }
	};

	const reloadAgents = (context: ExtensionContext): void => {
		const dispatched = pi.getFlag("agent") || process.env.PI_AGENT_ID;
		const scope = dispatched ? (process.env.PI_AGENT_SCOPE ?? pi.getFlag("agent-scope")) : pi.getFlag("agent-scope");
		const result = discoverAgents({
			cwd: dispatched && process.env.PI_AGENT_CONFIG_CWD || context.cwd,
			agentScope: (scope === "project" || scope === "both" ? scope : "user") as "user" | "project" | "both",
			experimental: experimentalEnabled(pi),
		});
		agents = result.agents;

		// Detect whether this process runs as a dispatched subagent. The parent
		// passes the id on `--agent` and in the environment; the flag is the
		// primary channel and the env var is the fallback for a hand-spawned child.
		const flagged = pi.getFlag("agent");
		const requested = typeof flagged === "string" && flagged ? flagged : process.env.PI_AGENT_ID;
		missingDispatchedAgent = !!requested && !agents.some((agent) => agent.id === requested);
		if (requested) {
			runningAsSubagent = requested;
			activePrimary = requested;
		} else {
			runningAsSubagent = undefined;
			if (!agents.some((agent) => agent.id === activePrimary && agent.mode !== "subagent" && !agent.hidden)) activePrimary = restorePrimaryAgent([], agents).id;
		}
	};

	const currentAgent = (): AgentDefinition | undefined => liveAgent ?? agents.find((agent) => agent.id === activePrimary);

	function resolveLiveModel(input: string, level: string | undefined, ctx: ExtensionContext) {
		let ref;
		try { ref = parseModelRef(input); } catch { throw new Error(invalidModelMessage(input)); }
		const model = ctx.modelRegistry.getAvailable().find((item) => item.provider === ref.providerID && item.id === ref.id);
		if (!model) throw new Error(unavailableModelMessage(ref));
		const variants = supportedPiVariants(model), requested = level ?? ref.variant;
		if (requested && !variants.includes(requested)) throw new Error(unavailableVariantMessage({ ...ref, variant: requested }, variants));
		return { model, thinkingLevel: requested as Parameters<ExtensionAPI["setThinkingLevel"]>[0] | undefined };
	}


	function applyToolPolicy(): void {
		const active = pi.getActiveTools();
		if (!toolsRestricted || !unrestrictedTools) unrestrictedTools = [...active];
		else if (restrictedTools) {
			// Respect user/other-extension selection changes, not just the startup list.
			const baseline = new Set(unrestrictedTools);
			for (const name of restrictedTools) if (!active.includes(name)) baseline.delete(name);
			for (const name of active) if (!restrictedTools.includes(name)) baseline.add(name);
			unrestrictedTools = [...baseline];
		}
		const agent = currentAgent();
		const cap = agent && !agent.toolsFromPermissions && agent.tools
			? new Set([...agent.tools, "subagent"]) : undefined;
		const candidates = unrestrictedTools.filter((name) => !cap || cap.has(name));
		const selected = filterToolNames(activeRules(), candidates).filter((name) =>
			!runningAsSubagent || !strictShellEnabled() || !["bash", "powershell"].includes(name));
		if (selected.length !== active.length || selected.some((name) => !active.includes(name))) pi.setActiveTools(selected);
		toolsRestricted = selected.length !== unrestrictedTools.length;
		restrictedTools = toolsRestricted ? selected : undefined;
	}

	pi.registerFlag("agent-scope", {
		description: 'Agent directories to load: "user" (default), "project", or "both"',
		type: "string",
		default: "user",
	});

	pi.registerFlag("agent-runner", {
		description: "Child runner: process (default) or experimental shared SDK foreground leaf sessions",
		type: "string",
	});
	pi.registerFlag("agent-run-depth", { description: "Current child depth (internal SDK session state)", type: "string" });
	pi.registerFlag("agent-forms-route", { description: "Root form route (internal SDK session state)", type: "string" });

	pi.registerFlag("agent-depth", {
		description: "Maximum nested subagent depth (default 1)",
		type: "string",
	});

	pi.registerFlag("agent-experimental", {
		description: "Enable experimental agents such as Scout",
		type: "boolean",
	});

	pi.registerFlag("agent-strict-shell", {
		description: "Disable Bash and PowerShell in dispatched child agents",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("agent", {
		description: "Run as the named agent (used internally when dispatching a subagent)",
		type: "string",
	});

	pi.registerFlag("agent-permissions", {
		description: "Base64 JSON permission ruleset for this agent (used internally when dispatching)",
		type: "string",
	});

	pi.registerFlag("agent-options", {
		description: "Base64 JSON provider options (temperature, top_p) for this agent",
		type: "string",
	});

	pi.registerFlag("agent-worktree", { description: "Internal isolated workspace metadata", type: "string" });
	pi.registerFlag("agent-live-backend", { description: "Internal live child transport", type: "string" });
	if (process.env.PI_AGENT_ID || process.env.PI_AGENT_SDK_WORKER === "1") {
		pi.registerCommand(LIVE_PREPARE, {
			description: "Internal owned-child configuration preparation (does not switch immediately)",
			handler: async (args, ctx) => {
				const space = args.indexOf(" "), id = args.slice(0, space), encoded = args.slice(space + 1);
				try {
					if (!runningAsSubagent || !runtimeActive || ctx.isIdle() || ctx.signal?.aborted) throw new Error("This child no longer accepts live configuration");
					if ((pi.getSettings?.().steeringMode ?? "one-at-a-time") !== "one-at-a-time") throw new Error("Live switching requires one-at-a-time steering");
					const input = decodeLiveInput(encoded, ctx.sessionManager.getSessionId());
					if (space < 0 || id !== input.id) throw new Error("Live input transaction identity mismatch");
					if (!agents.some((agent) => agent.id === input.update.agent.id && agent.mode !== "primary")) throw new Error("Live target agent is unavailable in this child");
					if (pi.getFlag("agent-live-backend") === "sdk" && !leafPolicy(input.update.agent.permissions)) throw new Error("An SDK live switch cannot enable nested delegation; settle and continue using the process runner");
					const requested = input.update.model ?? input.update.agent.model;
					if (requested) resolveLiveModel(requested, input.update.thinkingLevel ?? (!input.update.model ? input.update.agent.thinkingLevel ?? input.update.agent.variant : undefined), ctx);
					liveInputs.prepare(input);
					pi.appendEntry(LIVE_PREPARED, { sessionID: ctx.sessionManager.getSessionId(), id, ok: true });
				} catch (error) {
					// Pi consumes command exceptions and still reports "handled". An
					// explicit private receipt is required before queueing any task.
					pi.appendEntry(LIVE_PREPARED, { sessionID: ctx.sessionManager.getSessionId(), id, ok: false, error: error instanceof Error ? error.message : String(error) });
				}
			},
		});
		pi.registerCommand(LIVE_CANCEL, { description: "Internal unused live-input preparation cleanup", handler: async (id) => { liveInputs.cancel(id.trim()); } });
	}

	/* -------------------------------------------------------------- */
	/* Lifecycle                                                      */
	/* -------------------------------------------------------------- */

	pi.on("session_start", (_event, ctx) => {
		liveInputs.clear(); liveAgent = undefined;
		closeModelPicker?.(); closeModelPicker = undefined; modelPickerOpen = false;
		modelUpdateWork = Promise.resolve();
		subagentModels = restoreSubagentModels(ctx.sessionManager.getEntries?.() ?? []);
		closeChildPage?.();
		closeChildPage = undefined;
		childPageOpen = false;
		forgetDetachedResult();
		void shellRuns.dispose().catch(() => {});
		shellRuns = newShellRuns();
		shellSettings = undefined;
		closeForms();
		approvals.clear();
		sessionAborter = new AbortController();
		interactions.begin();
		if (deliveryTimer) clearInterval(deliveryTimer);
		clearPendingNotices();
		void childInterrupts.dispose().catch(() => {});
		childInterrupts = new ChildInterrupts();
		sessionGeneration++;
		acknowledgedChildren = new Set(ctx.sessionManager.getEntries?.()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "subagent-completion")
			.map((entry) => ("details" in entry ? entry.details as { childID?: unknown } : undefined)?.childID)
			.filter((id): id is string => typeof id === "string") ?? []);
		runtimeActive = true;
		hasFinishedTurn = false;
		deliverySignal = undefined;
		parentSessionID = ctx.sessionManager.getSessionId();
		tuiContext = ctx.mode === "tui" ? ctx : undefined;
		uiController = undefined;
		uiChildren = [];
		composerRefresh++;
		composerWork = undefined;
		composerDirty = false;
		callChildIDs.clear();
		callBackgroundIDs.clear();
		for (const entry of ctx.sessionManager.getEntries?.() ?? []) {
			if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
			const details = entry.message.details as { sessionID?: unknown; background?: boolean } | undefined;
			if (typeof details?.sessionID === "string") callChildIDs.set(entry.message.toolCallId, details.sessionID);
			if (details?.background) callBackgroundIDs.add(entry.message.toolCallId);
		}
		cwd = ctx.cwd;
		jobs = new JobRegistry(cwd);
		if (ctx.mode === "tui") ctx.ui.setWidget("opencode-subagents", undefined);
		// Pi may keep this extension instance across a session switch. If the
		// previous Plan loadout is still active, restore the old baseline before
		// capturing the new session's tool selection.
		const startingTools = pi.getActiveTools();
		if (toolsRestricted && unrestrictedTools && restrictedTools &&
			startingTools.length === restrictedTools.length &&
			startingTools.every((tool) => restrictedTools!.includes(tool))) {
			pi.setActiveTools(unrestrictedTools);
		}
		unrestrictedTools = pi.getActiveTools();
		restrictedTools = undefined;
		toolsRestricted = false;
		reloadAgents(ctx);
		if (!runningAsSubagent) {
			const restored = restorePrimaryAgent(ctx.sessionManager.getBranch?.() ?? [], agents);
			activePrimary = restored.id;
			pendingLeavePlan = restored.needsLeaveReminder;
		} else pendingLeavePlan = false;
		applyToolPolicy();
		steps.reset();
		pendingStepReset = false;
		steps.setLimit(currentAgent()?.steps);
		// Offer subagents in the editor's autocomplete, matching OpenCode's
		// `@` mention menu.
		if (ctx.hasUI) {
			ctx.ui.addAutocompleteProvider((current) => createAgentAutocompleteProvider(current, () => agents));
		}
		if (ctx.mode === "tui" && !runningAsSubagent) {
			previousEditorFactory = ctx.ui.getEditorComponent();
			const generation = sessionGeneration;
			composerFactory = (tui, theme, keys) => {
				composerEditor = new OpenCodeComposerEditor(tui, theme, keys, () => ctx.ui.theme, {
					viewChild: (id) => { void showChildSession(ctx, id).catch(() => {}); },
					backgroundWork: () => { if (generation === sessionGeneration) backgroundForegroundWork(); },
					interruptChild: (id) => generation === sessionGeneration ? interruptChild(ctx, id) : Promise.resolve("Session changed"),
					interruptShell: (id) => generation === sessionGeneration ? cancelShellRun(ownerContext(ctx), id) : Promise.resolve("Session changed"),
					viewShell: (id) => {
						const shell = shellRuns.list().find((entry) => entry.id === id);
						if (!shell || childPageOpen || formHost?.isShowing || generation !== sessionGeneration) return;
						childPageOpen = true;
						void ctx.ui.custom<void>((pageTui, palette, _keys, done) => {
							closeChildPage = done;
							return new ChildTranscriptView(pageTui, palette, "Shell", [shell.command, "", ...shellOutput(shell)], done,
								{ fullPage: true, title: "Shell output", status: () => shellStatusLabel(shell), load: async () => [shell.command, "", ...shellOutput(shell)] });
						}, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } })
							.finally(() => { childPageOpen = false; closeChildPage = undefined; }).catch(() => {});
					},
				});
				void refreshComposer(ctx, generation);
				return composerEditor;
			};
			ctx.ui.setEditorComponent(composerFactory);
			const createComposer = composerFactory;
			uiController = {
				sessionID: ctx.sessionManager.getSessionId(),
				createComposer: (tui, theme, keys) => createComposer(tui, theme, keys) as OpenCodeComposerEditor,
				viewChild: (id) => { void showChildSession(ctx, id).catch((error) => {
					if (generation === sessionGeneration && runtimeActive) ctx.ui.notify(`Unable to open subagent: ${error instanceof Error ? error.message : String(error)}`, "warning");
				}); },
				openSubagentModels: () => { if (generation === sessionGeneration) void showSubagentModels(ctx).catch((error) => {
					if (generation === sessionGeneration && runtimeActive) ctx.ui.notify(`Unable to open subagent models: ${error instanceof Error ? error.message : String(error)}`, "warning");
				}); },
			};
			pi.events?.emit(AGENTS_UI_CONNECT, uiController);
			removeComposerInputListener = ctx.ui.onTerminalInput((data) => {
				if (matchesKey(data, "ctrl+b") && foregroundBackgrounders.size) {
					backgroundForegroundWork();
					return { consume: true };
				}
				if (!childPageOpen && composerEditor?.isPanelOpen && (matchesKey(data, "pageUp") || matchesKey(data, "pageDown"))) {
					composerEditor.handleInput(data);
					return { consume: true };
				}
			});
		}
		// Wait for a successful user turn before delivering old completions: a
		// startup message can preempt the first prompt. Poll while idle for jobs
		// that finish after the parent's last turn boundary.
		deliveryTimer = setInterval(() => {
			if (ctx.isIdle()) void deliverCompletions(sessionGeneration);
			void refreshComposer(ctx, sessionGeneration);
			if (ctx.hasUI) ctx.ui.setStatus("agent-forms", formHost?.pendingCount ? `${formHost.pendingCount} form(s) waiting at root` : undefined);
		}, 2000);
		deliveryTimer.unref();
		// Build is the default primary; only surface non-default agents in the footer.
		if (ctx.hasUI) ctx.ui.setStatus("agent", activePrimary === "build" ? undefined : `agent: ${activePrimary}`);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		runtimeActive = false; liveInputs.clear();
		closeModelPicker?.(); closeModelPicker = undefined; modelPickerOpen = false;
		forgetDetachedResult();
		closeForms();
		approvals.clear();
		void childInterrupts.dispose().catch(() => {});
		for (const controller of foregroundAborters.values()) controller.abort();
		stopChildProcesses();
		tuiContext = undefined;
		uiController = undefined;
		uiChildren = [];
		composerRefresh++;
		closeChildPage?.();
		closeChildPage = undefined;
		childPageOpen = false;
		sessionGeneration++;
		clearPendingNotices();
		if (deliveryTimer) clearInterval(deliveryTimer);
		deliveryTimer = undefined;
		if (ctx.mode === "tui") {
			removeComposerInputListener?.();
			removeComposerInputListener = undefined;
			if (composerFactory && ctx.ui.getEditorComponent() === composerFactory) ctx.ui.setEditorComponent(previousEditorFactory);
			composerEditor = undefined;
			composerFactory = undefined;
			ctx.ui.setWidget("opencode-subagents", undefined);
		}
		if (ctx.hasUI) ctx.ui.setStatus("agent", undefined);
		if (ctx.hasUI) ctx.ui.setStatus("agent-forms", undefined);
		await shellRuns.dispose();
	});

	// Steering enters after this assistant/tool batch, before the next request.
	pi.on("turn_end", async (event, ctx) => {
		hasFinishedTurn = event.outcome === "completed";
		deliverySignal = ctx.signal;
		await deliverCompletions(sessionGeneration, "steer");
	});
	// Catch results finishing after the last turn; aborted/failed runs stay paused.
	pi.on("agent_settled", () => {
		void deliverCompletions(sessionGeneration);
	});

	/* -------------------------------------------------------------- */
	/* System prompt                                                  */
	/* -------------------------------------------------------------- */

	pi.on("before_agent_start", (_event, ctx) => {
		hasFinishedTurn = false;
		deliverySignal = ctx.signal;
		interactions.begin();
		if (agents.length === 0) reloadAgents(ctx);
		applyToolPolicy();
		const agent = currentAgent();
		if (!agent) return undefined;

		const result: {
			message?: { customType: string; content: string; display: boolean };
			systemPrompt?: string;
		} = {};

		// OpenCode replaces the entire system prompt when `agent.system` is set
		// (`session/model-request.ts`): `agent.system ? agent.system : default`.
		// CLI/SDK already install the parent's authoritative child prompt (with
		// cwd). A forced per-run prompt would override context_with_system even
		// after a boundary switch, pinning the child to its original instructions.
		if (!runningAsSubagent && agent.systemPrompt.trim()) result.systemPrompt = agent.systemPrompt;

		// Plan mode injects a reminder instead of a system prompt, exactly as
		// OpenCode's plan plugin does through its session context hook.
		if (agent.id === "plan") {
			result.message = {
				customType: "plan-mode-reminder",
				content: [PLAN_REMINDER(planDirectory()), steps.reached ? MAX_STEPS_PROMPT : undefined]
					.filter(Boolean).join("\n\n"),
				display: false,
			};
			return result;
		}

		// Subagents get OpenCode's dispatch preamble.
		if (runningAsSubagent) {
			result.message = {
				customType: "subagent-preamble",
				content: "You are a subagent spawned by another session.",
				display: false,
			};
		}

		// OpenCode rewrites the subagent tool description before each request
		// with the agents this parent may dispatch. Pi cannot mutate a tool
		// description, so the same listing is injected as context instead.
		const listing = subagentListing(agents, agent);
		if (listing) {
			result.message = {
				customType: "subagent-listing",
				content: listing,
				display: false,
			};
		}

		// Once the step budget is spent, OpenCode appends MAX_STEPS_PROMPT and
		// disables tools. The prompt is injected here; the block happens in
		// tool_call below.
		if (steps.reached) {
			result.message = {
				customType: MAX_STEPS_CUSTOM_TYPE,
				content: MAX_STEPS_PROMPT,
				display: false,
			};
		}
		if (pendingLeavePlan) {
			pendingLeavePlan = false;
			result.message = {
				customType: "plan-mode-leave",
				content: [PLAN_LEAVE_REMINDER, result.message?.content].filter(Boolean).join("\n\n"),
				display: false,
			};
		}
		return result;
	});

	// Pi has no mid-run prompt setter. Own request-local prompt state after a
	// live switch, while retaining every tool declaration transition verbatim.
	pi.on("context_with_system", (event) => {
		if (!runningAsSubagent || !liveAgent) return undefined;
		const encoded = pi.getFlag("agent-worktree");
		const workspace: unknown = typeof encoded === "string" ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) : undefined;
		if (workspace !== undefined && (!validWorktree(workspace) || workspace.cwd !== path.resolve(cwd))) throw new Error("Invalid child worktree context");
		const prompt = childSystemPrompt(liveAgent, cwd, workspace as WorktreeWorkspace | undefined);
		let first = true;
		return { messages: event.messages.map((message) => {
			if (message.role !== "system") return message;
			const content = first ? prompt : ""; first = false;
			return { ...message, content, sections: undefined };
		}) };
	});

	/* -------------------------------------------------------------- */
	/* Provider options                                                */
	/* -------------------------------------------------------------- */

	// OpenCode passes an agent's `temperature` and `top_p` straight through to
	// the provider. Pi exposes the outgoing payload here, so the values are
	// applied per request. A child receives them from the parent.
	pi.on("before_provider_request", (event) => {
		const options = runningAsSubagent
			? liveAgent ? providerOptions(liveAgent) : decodeProviderOptions(pi.getFlag("agent-options"))
			: providerOptions(currentAgent());
		if (!hasProviderOptions(options)) return undefined;
		return applyProviderOptions(event.payload, options);
	});

	/* -------------------------------------------------------------- */
	/* Step budget (OpenCode's `steps`)                                */
	/* -------------------------------------------------------------- */

	// OpenCode increments `step` once per provider request, which is one
	// assistant message. Counting on `message_end` matches that unit and avoids
	// the `turn_end` boundary machinery, which requires a persisted entry id.
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") steps.increment();
	});

	pi.on("turn_start", () => {
		if (pendingStepReset) {
			steps.reset();
			pendingStepReset = false;
		}
	});

	// Publish only this child's actual loadout through its sole session writer.
	// The viewer never borrows the root's tool/resource counts.
	pi.on("turn_start", (_event, ctx) => {
		if (runningAsSubagent) pi.appendEntry("subagent-ui-state", { tools: pi.getActiveTools(), model: ctx.model ? {
			provider: ctx.model.provider, id: ctx.model.id, contextWindow: ctx.model.contextWindow,
		} : undefined });
	});

	pi.on("message_start", (event) => {
		if (event.message.role === "custom" && event.message.customType === "subagent-completion") steps.reset();
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "custom" || event.message.customType !== "subagent-completion") return;
		const id = (event.message.details as { childID?: unknown } | undefined)?.childID;
		if (typeof id !== "string") return;
		acknowledgedChildren.add(id);
		const pending = pendingNotices.get(id);
		if (!pending || pending.generation !== sessionGeneration) return;
		void pending.registry.release(id).then(() => {
			clearTimeout(pending.timer);
			pendingNotices.delete(id);
		}).catch(() => {
			clearTimeout(pending.timer);
			pendingNotices.delete(id); // retry the persisted acknowledgement next tick
		});
	});

	// OpenCode sends `toolChoice: "none"` and rejects any tool that still runs
	// with this exact message (`session/runner/step.ts`). Pi has no toolChoice
	// override, so every call is blocked once the budget is spent.
	pi.on("tool_call", (event, ctx) => approvals.guard(event, ctx));

	registerTool({
		name: "questionnaire", label: "Questions",
		description: "Ask clarification or choice questions. A custom answer is added automatically; subagent questions are answered in the root session.",
		parameters: Type.Object({ questions: Type.Array(Type.Object({
			question: Type.String(), header: Type.String(),
			options: Type.Array(Type.Object({ label: Type.String(), description: Type.String() })),
			multiple: Type.Optional(Type.Boolean()),
		}), { minItems: 1 }) }),
		async execute(_id, params, signal, _update, ctx) {
			const rules = blockedByRules(activeRules(), { toolName: "questionnaire", input: params }, { cwd: ctx.cwd, enforceExternal: !!runningAsSubagent });
			if (rules && !requiresApproval(rules)) return failure(rules);
			if (steps.reached) return failure(TOOLS_DISABLED_MESSAGE);
			const interactionID = interactions.id;
			const aborted = AbortSignal.any([sessionAborter.signal, interactions.signal, ...(signal ? [signal] : [])]);
			const response = await requestForm(await formsRoute(ctx), ctx.sessionManager.getSessionId(), { kind: "question", questions: params.questions }, aborted, interactionID);
			if (response.reply === "reject" || !response.answers || aborted.aborted) {
				if (response.reason === "declined") interactions.decline(ctx, interactionID, "question", aborted);
				return failure(response.reason === "declined" ? "The user dismissed this question" : "Questions cancelled or root UI unavailable");
			}
			if (steps.reached) return failure(TOOLS_DISABLED_MESSAGE);
			const changed = blockedByRules(activeRules(), { toolName: "questionnaire", input: params }, { cwd: ctx.cwd, enforceExternal: !!runningAsSubagent });
			if (changed && !requiresApproval(changed)) return failure(changed);
			return { content: [{ type: "text", text: "User has answered your questions: " + params.questions.map((question, index) =>
				`${JSON.stringify(question.question)}=${JSON.stringify(response.answers![index].join(", "))}`).join(", ") }], details: { answers: response.answers } };
		},
	});

	for (const create of [createBashToolDefinition, createPowerShellToolDefinition]) {
		const native = create(process.cwd());
		registerTool({ ...native, ...shellFrameRenderers(native.name as "bash" | "powershell"), async execute(id, params, signal, update, ctx) {
			let execute = native.execute;
			if (native.name === "bash") {
				if (!shellSettings) {
					// Pi 1.0 exposes merged runtime settings, including project trust and overrides.
					const effective = (pi as ExtensionAPI & { getSettings?(): Parameters<typeof SettingsManager.inMemory>[0] }).getSettings?.();
					if (effective) shellSettings = SettingsManager.inMemory(effective);
					else {
						const files = SettingsManager.create(ctx.cwd, getAgentDir());
						const project = files.getProjectSettings();
						if (project.shellPath !== undefined || project.shellCommandPrefix !== undefined) {
							throw new Error("Project Bash settings require Pi 1.0 or newer for safe independent shell cancellation");
						}
						shellSettings = SettingsManager.inMemory(files.getGlobalSettings());
					}
				}
				execute = createBashToolDefinition(ctx.cwd, { shellPath: shellSettings.getShellPath(), commandPrefix: shellSettings.getShellCommandPrefix() }).execute;
			}
			return shellRuns.execute(ownerContext(ctx), id, native.name, params.command, signal,
				(inner, partial) => execute(id, params, inner, partial, ctx), update);
		} });
	}

	/* -------------------------------------------------------------- */
	/* @ mentions                                                     */
	/* -------------------------------------------------------------- */

	// OpenCode invokes a subagent by name with `@name`. Pi expands `@file`
	// arguments only when they arrive on the command line (`parseArgs` ->
	// `processFileArguments`); a prompt typed in the editor or sent over RPC
	// reaches this event with the `@` intact, so the mention works there.
	pi.on("input", (event) => {
		if (event.source !== "interactive" && event.source !== "rpc") return undefined;
		// OpenCode starts a fresh step budget when new user input is admitted.
		// A steering message is queued, so reset on its next turn instead of
		// lifting the guard during the currently running tool batch.
		if (event.streamingBehavior) pendingStepReset = true;
		else steps.reset();
		if (agents.length === 0) return undefined;

		// `@name rest...` matches OpenCode. `::name` is kept as an alias because
		// the CLI argument path does resolve `@name` as a file.
		const match = /^(?:@|::)([a-zA-Z0-9_-]+)\s+([\s\S]+)$/.exec(event.text.trim());
		if (!match) return undefined;

		const [, id, rest] = match;
		const agent = agents.find((candidate) => candidate.id === id && candidate.mode !== "primary");
		if (!agent) return undefined;

		return {
			action: "transform" as const,
			text: `Use the subagent tool with agent="${agent.id}" and prompt: ${rest}`,
		};
	});

	/* -------------------------------------------------------------- */
	/* The subagent tool                                              */
	/* -------------------------------------------------------------- */

	registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate a task with fresh context; include necessary instructions.",
			"Foreground (default) waits for the answer; use when your next step depends on it.",
			"background=true returns immediately and notifies on completion; use alongside independent work.",
			"sessionID continues the child conversation.",
		].join("\n"),
		promptSnippet: "Delegate a task to a specialized subagent",
		promptGuidelines: [
			"Use foreground when your next step depends on delegated findings; use background only for specific non-overlapping work.",
			"Do not repeat delegated exploration; use its result, then read only what implementation or verification requires.",
			"Do not poll or sleep while a background subagent runs; you are notified when it finishes.",
			"Use isolation=worktree for independent writing tasks that do not need uncommitted parent edits. Review results; never merge or delete a worktree without explicit user approval.",
		],
		parameters: Type.Object({
			agent: Type.String({
				description: "Agent from Available subagents. If not listed, treat the name as a model: choose a suitable agent and use model.",
			}),
			description: Type.String({ description: "3-5 word task label shown to the user" }),
			prompt: Type.String({ description: "Child task and necessary context/instructions" }),
			model: Type.Optional(
				Type.String({
					description: "Only set when the user explicitly requests a model/variant. Use providerID/modelID or providerID/modelID#variant; never guess IDs.",
				}),
			),
			sessionID: Type.Optional(
				Type.String({
					description: "Continue this child; omit for a new conversation.",
				}),
			),
			background: Type.Optional(
				Type.Boolean({
					description: "Default false (foreground). true returns immediately; completion is announced. Do not sleep, poll, or proactively check progress.",
				}),
			),
			isolation: Type.Optional(Type.Union([Type.Literal("shared"), Type.Literal("worktree")], {
				description: "Default shared; worktree uses committed HEAD. Continuations keep their workspace.",
			})),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const registry = jobs; // retain the originating workspace if sessions switch
			const interrupts = childInterrupts;
			const generation = sessionGeneration;
			const input = normalizeInput(params);
			if (!input.agent) return failure("Missing required parameter: agent");
			if (!input.prompt) return failure("Missing required parameter: prompt");
			if (input.isolation !== undefined && !["shared", "worktree"].includes(input.isolation)) return failure("Invalid isolation: use shared or worktree");

			if (agents.length === 0) reloadAgents(ctx);
			if (missingDispatchedAgent) return failure(`Dispatched agent ${runningAsSubagent} is not available in this child`);

			// Depth guard, mirroring OpenCode's experimental.subagent_depth.
			const depth = Number(pi.getFlag("agent-run-depth") ?? process.env.PI_AGENT_DEPTH ?? "0");
			const limit = subagentDepth(pi);
			const agentScope = (runningAsSubagent ? process.env.PI_AGENT_SCOPE : undefined) ??
				(pi.getFlag("agent-scope") as string | undefined) ?? "user";
			const strictShell = strictShellEnabled();
			if (depth >= limit) {
				return failure(
					`Subagent depth limit reached (${limit}). Increase --agent-depth to allow nested subagents.`,
				);
			}

			const agent = agents.find((candidate) => candidate.id === input.agent);
			if (!agent) {
				const available = subagents(agents)
					.map((candidate) => candidate.id)
					.join(", ");
				return failure(`Unknown agent: ${input.agent}. Available subagents: ${available || "none"}.`);
			}
			if (agent.mode === "primary") {
				return failure(`Agent ${input.agent} cannot run as a subagent`);
			}

			// OpenCode checks the parent's `subagent` permission before dispatch.
			const parent = currentAgent();
			if (parent && !canDispatch(parent.permissions, agent.id)) {
				return failure(`Subagent denied: ${agent.id}`);
			}

			const parentDir = ctx.sessionManager.getSessionDir();
			const owner = ownerContext(ctx);
			const continuation = input.sessionID !== undefined;
			const sessionID = continuation ? input.sessionID! : createChildId(agent.id);
			// Existing children created by older versions still live beside the
			// parent; continue them without ever adopting an unclaimed session.
			const legacyOwner = { ...owner, sessionDir: parentDir };
			const modernOwned = continuation ? await findOwnedChild(owner, sessionID) : undefined;
			const legacyOwned = continuation && !modernOwned ? await findOwnedChild(legacyOwner, sessionID) : undefined;
			const owned = modernOwned ?? legacyOwned;
			const childOwner = legacyOwned ? legacyOwner : owner;
			if (continuation && !owned) {
				return failure(`Subagent session ${sessionID} not found or not a child of the current session`);
			}
			let workspace = owned?.workspace;
			let childCwd = owned?.cwd ?? ctx.cwd;
			if (continuation && input.isolation !== undefined && input.isolation !== (workspace ? "worktree" : "shared")) {
				return failure("Cannot change isolation on an existing child; start a new session instead");
			}
			// Validate explicit selections before either live or settled admission.
			let explicitModel: string | undefined;
			let explicitThinking: string | undefined;
			const assignedModel = input.model ?? assignedSubagentModel(agent, ctx);
			if (assignedModel) {
				let ref;
				try { ref = parseModelRef(assignedModel); } catch { return failure(invalidModelMessage(assignedModel)); }
				const available = ctx.modelRegistry.getAvailable().find((item) => item.provider === ref.providerID && item.id === ref.id);
				if (!available) return failure(unavailableModelMessage(ref));
				if (ref.variant && !supportedPiVariants(available).includes(ref.variant)) return failure(unavailableVariantMessage(ref, supportedPiVariants(available)));
				const translated = toPiModelArgument(ref);
				explicitModel = translated.model; explicitThinking = translated.thinkingLevel;
			}
			if (workspace) {
				try { await verifyWorktree(workspace, signal); }
				catch (error) { return failure(withWorktreeReport(`Cannot continue isolated child: ${error instanceof Error ? error.message : String(error)}`, workspace)); }
			}
			if (continuation && (foregroundRuns.has(sessionID) || registry.getLive(sessionID))) {
			if (!runtimeActive || generation !== sessionGeneration || signal?.aborted) return failure("Session changed or child input cancelled");
			const foreground = foregroundRuns.get(sessionID), child = foreground?.run.child ?? registry.getLive(sessionID)!;
			if (!child.supportsLiveUpdates && (owned?.agent !== agent.id || assignedModel)) return failure(`This live child runtime does not support agent/model switching (sessionID: ${sessionID})`);
			if (!child.steer) return failure(`Live child input is unavailable (sessionID: ${sessionID})`);
			observeLiveAgent(child, childOwner, sessionID);
			const description = input.description ?? `${agent.id} task`;
			callChildIDs.set(toolCallId, sessionID);
			const details: SubagentToolDetails = { sessionID, status: "running", agent: agent.id, description, ...(workspace ? { workspace } : {}) };
			onUpdate?.({ content: [{ type: "text", text: `(${agent.id} accepting input...)` }], details });
			let joined: DetachedRun | undefined;
			let joinAborter: AbortController | undefined, joinBackgrounder: AbortController | undefined;
			const cancelShared = () => child.kill("SIGTERM");
			try {
				if (!input.background && !foreground) joined = await registry.join(sessionID, child);
				const disposition = await child.steer(input.prompt, signal, child.supportsLiveUpdates ? { agent, model: explicitModel, thinkingLevel: explicitThinking } : undefined);
				onUpdate?.({ content: [{ type: "text", text: `(${agent.id} input ${disposition}; joining existing run...)` }], details: { ...details, inputDisposition: disposition } });
				if (input.background === true) {
					foregroundBackgrounders.get(sessionID)?.abort(); // release an existing foreground wait, not the child
					callBackgroundIDs.add(toolCallId);
					return { content: [{ type: "text", text: withWorktreeReport(backgroundNotice(sessionID), workspace) }], details: { ...details, background: true, inputDisposition: disposition } };
				}
				let result: RunResult;
				if (foreground) {
					signal?.addEventListener("abort", cancelShared, { once: true });
					if (signal?.aborted) cancelShared();
					result = await foreground.result; // one observer/result, not another runtime or file writer
				} else {
					joinAborter = new AbortController(); joinBackgrounder = new AbortController();
					foregroundAborters.set(sessionID, joinAborter); foregroundBackgrounders.set(sessionID, joinBackgrounder);
					result = await awaitForeground(joined!, { agent, task: input.prompt, cwd: childCwd, workspace, sessionID,
						signal: signal ? AbortSignal.any([signal, joinAborter.signal]) : joinAborter.signal, backgroundSignal: joinBackgrounder.signal,
					}, readDetachedResult);
					if (result.status !== "running") await registry.release(sessionID);
				}
				if (result.status === "running") {
					callBackgroundIDs.add(toolCallId);
					return { content: [{ type: "text", text: withWorktreeReport(backgroundNotice(sessionID), workspace) }], details: { ...details, background: true, inputDisposition: disposition } };
				}
				await setChildStatus(childOwner, sessionID, result.status).catch(() => {});
				if (result.status === "cancelled") return failure(withWorktreeReport(`Subagent cancelled (sessionID: ${sessionID})`, workspace));
				if (result.status === "error") return failure(withWorktreeReport(`Subagent failed (sessionID: ${sessionID}): ${result.error ?? "unknown error"}`, workspace));
				await agentMetadata.get(path.resolve(childOwner.sessionDir, sessionID))?.catch(() => {});
				return completedSubagentResult(withWorktreeReport(result.output, workspace), { ...details, agent: child.agent ?? details.agent, usage: result.usage, model: result.model, inputDisposition: disposition });
			} catch (error) { return failure(withWorktreeReport(`Cannot admit live child input (sessionID: ${sessionID}): ${error instanceof Error ? error.message : String(error)}`, workspace)); }
			finally {
				signal?.removeEventListener("abort", cancelShared);
				if (joined) registry.unjoin(sessionID, child);
				if (joinAborter && foregroundAborters.get(sessionID) === joinAborter) foregroundAborters.delete(sessionID);
				if (joinBackgrounder && foregroundBackgrounders.get(sessionID) === joinBackgrounder) foregroundBackgrounders.delete(sessionID);
				void refreshComposer(ctx, generation);
			}
		}
		if (continuation && await registry.pending(sessionID)) {
				return failure(`Subagent session ${sessionID} has a pending background result. Wait for its completion before continuing it.`);
			}

			const switched = continuation && owned?.agent !== agent.id;
			const { model, thinkingLevel } = selectChildModel({
				agent,
				parentModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				parentThinking: ctx.thinkingLevel,
				explicitModel,
				explicitThinking,
				previousAgent: owned?.agent,
			});
			const description = input.description ?? `${agent.id} task`;
			if (activeChildren.has(sessionID)) return failure(`Subagent session ${sessionID} is already running`);
			activeChildren.add(sessionID);
			receiptRuns.delete(path.resolve(childOwner.sessionDir, sessionID)); // revoke the previous generation before any new dispatch
			try {
				if (!continuation) {
					if (input.isolation === "worktree") {
						workspace = await prepareWorktree(owner, sessionID, signal);
						childCwd = workspace.cwd;
					}
					if (!runtimeActive || generation !== sessionGeneration || signal?.aborted) throw new Error("Session changed or dispatch cancelled");
					try {
						await claimChild(owner, sessionID, agent.id, description, workspace);
					} catch (error) {
						return failure(`Cannot create subagent session: ${error instanceof Error ? error.message : String(error)}`);
					}
					if (workspace) {
						if (workspace.parentDirty && ctx.hasUI) ctx.ui.notify("Isolated child starts from committed HEAD; parent uncommitted changes are not included", "warning");
						await createWorktree(workspace, signal);
					}
				} else await setChildStatus(childOwner, sessionID, "running");
				const registerInterrupt = () => {
					const aborter = foregroundAborters.get(sessionID), child = registry.getLive(sessionID);
					return interrupts.register(childOwner, sessionID,
						() => generation === sessionGeneration && runtimeActive && (aborter ? foregroundAborters.get(sessionID) === aborter : !!child && registry.getLive(sessionID) === child),
						async () => {
							if (aborter) { aborter.abort(); return `Interrupted ${sessionID}`; }
							const result = await registry.cancel(sessionID, child);
							if (result.cancelled) await setChildStatus(childOwner, sessionID, "cancelled");
							return result.cancelled ? `Stopped ${sessionID}` : result.reason ?? "Cannot interrupt this child";
						});
				};

				callChildIDs.set(toolCallId, sessionID);
				const formRoute = await formsRoute(ctx);
				if (!runtimeActive || generation !== sessionGeneration || signal?.aborted) throw new Error("Session changed or dispatch cancelled");
				// Background mode releases the parent turn, not process ownership.
				if (input.background === true) {
					const record = await registry.startBackground({
						sessionID,
						agent,
						task: input.prompt,
						cwd: childCwd,
						workspace,
						model,
						thinkingLevel,
						sessionDir: childOwner.sessionDir,
						continuationFile: owned?.file,
						agentScope,
						strictShell,
						depthLimit: limit,
						parentSessionID: owner.parentID,
						description,
						formRoute,
					});
					if (switched) await switchChildAgent(childOwner, sessionID, agent.id);
					const live = registry.getLive(sessionID); if (live) observeLiveAgent(live, childOwner, sessionID);
					await registerInterrupt();
					callBackgroundIDs.add(toolCallId);
					void refreshComposer(ctx, sessionGeneration);
					const notice = withWorktreeReport(registry.notice(record.id), workspace);
					const details: SubagentToolDetails = {
						sessionID: record.id, status: "running", agent: agent.id, description, background: true,
						...(workspace ? { workspace } : {}),
					};
					onUpdate?.({ content: [{ type: "text", text: notice }], details });
					return { content: [{ type: "text", text: notice }], details };
				}

				// Stream meaningful child boundaries into the parent tool's TUI view.
				// Token deltas are deliberately ignored to avoid a constantly redrawn UI.
				const progress = new ChildProgress();
				const aborter = new AbortController();
				const backgrounder = new AbortController();
				foregroundBackgrounders.set(sessionID, backgrounder);
				foregroundAborters.set(sessionID, aborter);
				await registerInterrupt();
				void refreshComposer(ctx, sessionGeneration);
				const updateProgress = () => onUpdate?.({
					content: [{ type: "text", text: `(${agent.id} running${progress.items.length ? `: ${progress.items.at(-1)}` : ""}...)` }],
					details: { sessionID, status: "running", agent: agent.id, description, progress: [...progress.items], model: progress.model, ...(workspace ? { workspace } : {}) } satisfies SubagentToolDetails,
				});
				updateProgress();

				const running = runAgent({
					backend: !workspace && (pi.getFlag("agent-runner") ?? process.env.PI_AGENT_RUNNER) === "sdk" ? "sdk" : "process",
					projectTrusted: typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted(),
					onBackendFallback: (reason) => ctx.ui.notify(`SDK runner unavailable; using subprocess: ${reason}`, "warning"),
					agent,
					task: input.prompt,
					cwd: childCwd,
					jobCwd: ctx.cwd,
					workspace,
					model,
					thinkingLevel,
					sessionDir: childOwner.sessionDir,
					continuationFile: owned?.file,
					sessionID,
					continuing: continuation,
					signal: signal ? AbortSignal.any([signal, aborter.signal]) : aborter.signal,
					backgroundSignal: backgrounder.signal,
					onStarted: (run) => { foregroundRuns.set(sessionID, { run, result: running }); observeLiveAgent(run.child, childOwner, sessionID); },
					onEvent: (event) => { if (progress.add(event)) updateProgress(); },
					env: { ...subagentEnvironment(agent, depth + 1, agentScope, limit, strictShell), PI_AGENT_FORMS: formRoute ?? "",
						...(workspace ? { PI_AGENT_CONFIG_CWD: process.env.PI_AGENT_CONFIG_CWD || workspace.sourceCwd } : {}) },
					strictShell,
					firstMessagePrefix: "You are a subagent spawned by another session.",
				});
				const result = await running;
				await agentMetadata.get(path.resolve(childOwner.sessionDir, sessionID))?.catch(() => {});
				const finalAgent = foregroundRuns.get(sessionID)?.run.child.agent ?? agent.id;

				if (switched) await switchChildAgent(childOwner, sessionID, finalAgent);
				if (result.status === "running" && result.detached) {
					await registry.adopt({ run: result.detached, sessionID, agent: result.detached.child.agent ?? agent.id, description, parentSessionID: owner.parentID, workspace });
					foregroundAborters.delete(sessionID);
					await registerInterrupt();
					callBackgroundIDs.add(toolCallId);
					const notice = withWorktreeReport(registry.notice(sessionID), workspace);
					return { content: [{ type: "text" as const, text: notice }],
						details: { sessionID, status: "running" as const, agent: agent.id, description, background: true, ...(workspace ? { workspace } : {}) } };
				}
				await setChildStatus(childOwner, sessionID, result.status).catch(() => {});
				if (result.status === "cancelled") {
					return failure(withWorktreeReport(`Subagent cancelled (sessionID: ${sessionID})`, workspace));
				}
				if (result.status === "error") {
					// Keep the sessionID visible so the model can continue the child.
					return failure(withWorktreeReport(`Subagent failed (sessionID: ${sessionID}): ${result.error ?? "unknown error"}`, workspace));
				}

				return completedSubagentResult(withWorktreeReport(result.output, workspace), {
					sessionID,
					status: "completed",
					agent: finalAgent,
					description,
					usage: result.usage,
					progress: [...progress.items],
					model: result.model,
					...(workspace ? { workspace } : {}),
				});
			} catch (error) {
				if (!workspace && input.isolation !== "worktree") throw error;
				await setChildStatus(childOwner, sessionID, signal?.aborted ? "cancelled" : "error").catch(() => {});
				return failure(withWorktreeReport(`Subagent dispatch failed (sessionID: ${sessionID}): ${error instanceof Error ? error.message : String(error)}`, workspace));
			} finally {
				foregroundRuns.delete(sessionID);
				foregroundAborters.delete(sessionID);
				foregroundBackgrounders.delete(sessionID);
				activeChildren.delete(sessionID);
				void refreshComposer(ctx, sessionGeneration);
			}
		},

		renderCall(args, theme, context) {
			const name = agents.find((agent) => agent.id === args.agent)?.name ?? args.agent ?? "General";
			const description = args.description ?? "Delegating…";
			const title = args.sessionID ? "Continue subagent" : `${name} Subagent`;
			let modelLabel = args.model;
			if (args.model) {
				try {
					const ref = parseModelRef(args.model);
					modelLabel = (tuiContext?.modelRegistry?.find?.(ref.providerID, ref.id)?.name ?? `${ref.providerID}/${ref.id}`) +
						(ref.variant ? ` (${ref.variant})` : "");
				} catch { /* partial model reference while arguments stream */ }
			}
			const text = new Text(theme.fg("muted", stripTerminalSequences(`${title} — ${description}${modelLabel ? ` · ${modelLabel}` : ""}${args.background || context?.toolCallId && callBackgroundIDs.has(context.toolCallId) ? "  Background" : ""}`)), 0, 0);
			return new MouseRegion(text, (event) => {
				const id = context?.toolCallId ? callChildIDs.get(context.toolCallId) : args.sessionID;
				if (event.type !== "click" || !id || !tuiContext) return undefined;
				void showChildSession(tuiContext, id).catch(() => {});
				return { handled: true };
			});
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentToolDetails | undefined;
			const first = result.content[0];
			if (!details) return new Text(first?.type === "text" ? first.text : "(no result)", 0, 0);
			// Normal OpenCode shows one inline delegation row, not a duplicate
			// result card. Expanded Pi output is still available for diagnostics.
			if (!expanded) return new Text("", 0, 0);
			const container = new Container();
			const icon = details.status === "error" ? theme.fg("error", "✗") :
				details.status === "completed" ? theme.fg("success", "✓") : theme.fg("warning", "⏳");
			container.addChild(new Text(
				`${icon} ${theme.fg("accent", details.agent)} ${theme.fg("dim", details.description)}\n` +
				`  ${theme.fg("muted", details.sessionID)}${details.background ? "  (background)" : ""}`,
				0, 0,
			));
			const events = details.progress ?? [];
			const shown = expanded ? events : events.slice(-6);
			if (!expanded && events.length > shown.length) {
				container.addChild(new Text(theme.fg("dim", `  … ${events.length - shown.length} earlier events (Ctrl+O)`), 0, 0));
			}
			for (const event of shown) container.addChild(new Text(`  ${theme.fg("toolOutput", event)}`, 0, 0));
			if (details.status === "running" && !events.length) {
				container.addChild(new Text(theme.fg("dim", details.background
					? `  Use /agents view ${details.sessionID} to inspect this child`
					: "  Waiting for child output…"), 0, 0));
			}
			if (details.usage) {
				const usage = details.usage;
				container.addChild(new Text(theme.fg("dim",
					`  ${usage.turns} turns  ↑${usage.input} ↓${usage.output}  $${usage.cost.toFixed(4)}${details.model ? `  ${details.model}` : ""}`), 0, 0));
			}
			const output = subagentResultOutput(result);
			if (output) container.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
			return new MouseRegion(container, (event) => {
				if (event.type !== "click" || !tuiContext) return undefined;
				void showChildSession(tuiContext, details.sessionID).catch(() => {});
				return { handled: true };
			});
		},
	});

	/* -------------------------------------------------------------- */
	/* Commands                                                       */
	/* -------------------------------------------------------------- */

	const ownedFamily = (ctx: ExtensionContext) => listSessionFamily(ownerContext(ctx), ctx.sessionManager.getSessionDir());

	async function composerFamily(ctx: ExtensionContext, registry: JobRegistry, currentID?: string): Promise<{ children: FamilyChild[]; entries: ComposerChild[] }> {
		const children = await ownedFamily(ctx);
		const stores = [registry, ...[...new Set(children.map((child) => child.owner.cwd))]
			.filter((directory) => path.resolve(directory) !== path.resolve(ctx.cwd)).map((directory) => new JobRegistry(directory))];
		const snapshots = await Promise.all(stores.map(async (store) => {
			const records = await store.list();
			return { records, running: await store.running(records) };
		}));
		const recordByID = new Map(snapshots.flatMap((snapshot) => snapshot.records).map((record) => [record.id, record]));
		const running = new Map(snapshots.flatMap((snapshot) => snapshot.running).map((job) => [job.id, job]));
		const active = new Set([ctx.sessionManager.getSessionId()]);
		const entries: ComposerChild[] = [];
		for (const child of children) {
			const job = running.get(child.id);
			const record = recordByID.get(child.id);
			const matchingRecord = record?.parentSessionID === child.owner.parentID ? record : undefined;
			const nestedForeground = child.depth > 1 && child.status === "running" && active.has(child.owner.parentID) &&
				(!matchingRecord || matchingRecord.notified) && existsSync(path.join(child.owner.cwd, ".pi", "agents", "jobs", `${child.id}.jsonl`));
			const isRunning = activeChildren.has(child.id) || job?.parentSessionID === child.owner.parentID || nestedForeground;
			if (isRunning) active.add(child.id);
			entries.push({
				id: child.id, parentID: child.owner.parentID, agent: agents.find((agent) => agent.id === child.agent)?.name ?? child.agent,
				title: child.description ?? child.id, prefix: child.prefix, current: child.id === currentID,
				background: !foregroundBackgrounders.has(child.id),
				status: isRunning ? "running" : child.status && child.status !== "running" ? child.status :
					matchingRecord ? "completed" : child.status === "running" ? "cancelled" : child.file ? "completed" : "error",
			});
		}
		return { children, entries };
	}

	function agentModelEntry(agent: AgentDefinition, ctx: ExtensionContext): SubagentModelEntry {
		const override = subagentModels.get(agent.id);
		const selection = override ? toPiModelArgument(parseModelRef(override)) : selectChildModel({ agent,
			parentModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, parentThinking: ctx.thinkingLevel });
		let model: SubagentModelEntry["model"];
		if (selection.model) {
			try {
				const ref = parseModelRef(selection.model);
				model = ctx.modelRegistry.find(ref.providerID, ref.id);
			} catch { /* an unavailable configured default can still be replaced in the picker */ }
		}
		const thinking = selection.thinkingLevel ?? ctx.thinkingLevel ?? "off";
		return { id: agent.id, name: agent.name, reference: selection.model ?? "Inherit parent model", model,
			thinkingLevel: model ? clampPiVariant(model, thinking) : thinking, overridden: typeof override === "string" };
	}

	function assignedSubagentModel(agent: AgentDefinition, ctx: ExtensionContext): string | undefined {
		const override = subagentModels.get(agent.id);
		if (override === undefined) return undefined;
		// Saved preferences use the same catalog clamping shown in the picker;
		// an explicit reset follows current defaults, even on settled continuation.
		const entry = agentModelEntry(agent, ctx);
		return entry.model ? `${entry.model.provider}/${entry.model.id}#${entry.thinkingLevel}` : override ?? agent.model;
	}

	function updateSubagentModel(ctx: ExtensionContext, generation: number, id: string, reference: string | null): Promise<string | undefined> {
		const current = () => runtimeActive && generation === sessionGeneration && parentSessionID === ctx.sessionManager.getSessionId();
		const work = modelUpdateWork.catch(() => {}).then(async () => {
			if (!current()) throw new Error("Parent session changed");
			const agent = availableSubagents(agents, currentAgent()).find((agent) => agent.id === id);
			if (!agent) throw new Error(`Subagent ${id} is no longer available`);
			if (reference !== null) {
				const ref = parseModelRef(reference);
				const model = ctx.modelRegistry.getAvailable().find((model) => model.provider === ref.providerID && model.id === ref.id);
				if (!model) throw new Error(unavailableModelMessage(ref));
				if (ref.variant && !supportedPiVariants(model).includes(ref.variant)) throw new Error(unavailableVariantMessage(ref, supportedPiVariants(model)));
			}
			pi.appendEntry(SUBAGENT_MODELS_TYPE, { agent: id, model: reference });
			subagentModels.set(id, reference);
			const selection = agentModelEntry(agent, ctx);
			const children = await ownedFamily(ctx);
			if (!current()) throw new Error("Parent session changed");
			const live = children.filter((child) => child.owner.parentID === parentSessionID).flatMap((child) => {
				const handle = foregroundRuns.get(child.id)?.run.child ?? jobs.getLive(child.id);
				return handle && !handle.killed && handle.exitCode === null && handle.signalCode === null && (handle.agent ?? child.agent) === id ? [{ id: child.id, handle }] : [];
			});
			const results = await Promise.allSettled(live.map(async ({ handle }) => {
				if (!current()) throw new Error("Parent session changed");
				if (!selection.model) throw new Error(`Configured model ${selection.reference} is unavailable`);
				if (!handle.configureModel) throw new Error("This child runtime cannot update its model without another task");
				await handle.configureModel(`${selection.model.provider}/${selection.model.id}`, selection.thinkingLevel);
			}));
			const failures = results.flatMap((result, index) => result.status === "rejected" ? [`${live[index].id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : []);
			if (failures.length && current()) ctx.ui.notify(`Assignment saved, but some running children could not update:\n${failures.join("\n")}`, "warning");
			return failures.length ? `Saved; ${failures.length} running child update(s) failed.` : live.length
				? `Saved; ${live.length} running child(ren) updated for their next request.` : "Saved for this session's starts and continuations.";
		});
		modelUpdateWork = work;
		return work;
	}

	async function showSubagentModels(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") { ctx.ui.notify("Subagent model settings require interactive mode", "warning"); return; }
		if (modelPickerOpen) return;
		if (formHost?.isShowing) { ctx.ui.notify("Answer or dismiss the root form first", "warning"); return; }
		const generation = sessionGeneration;
		modelPickerOpen = true;
		try {
			await ctx.ui.custom<void>((tui, theme, keys, done) => {
				closeModelPicker = done;
				return new SubagentModelPicker(tui, theme, { keys, registry: ctx.modelRegistry, scopedModels: ctx.scopedModels,
					entries: () => availableSubagents(agents, currentAgent()).map((agent) => agentModelEntry(agent, ctx)),
					save: (id, model) => updateSubagentModel(ctx, generation, id, model), close: done });
			}, { overlay: true, overlayOptions: { width: "80%", minWidth: 40, maxHeight: "90%", anchor: "center" } });
		} finally {
			if (generation === sessionGeneration) { modelPickerOpen = false; closeModelPicker = undefined; }
		}
	}

	async function showChildSession(ctx: ExtensionContext, id: string): Promise<void> {
		if (formHost?.isShowing) { ctx.ui.notify("Answer or dismiss the root form before opening a child page", "warning"); return; }
		if (childPageOpen) return;
		// Reserve the viewer before asynchronous discovery: double clicks must
		// never create two full-page overlays or strand the parent's editor.
		const generation = sessionGeneration;
		childPageOpen = true;
		let children: FamilyChild[];
		try { children = await ownedFamily(ctx); }
		catch (error) { if (generation === sessionGeneration) childPageOpen = false; throw error; }
		if (!runtimeActive || generation !== sessionGeneration) return;
		if (!children.some((child) => child.id === id)) {
			childPageOpen = false;
			ctx.ui.notify(`Subagent session ${id} is not a child of this session`, "warning");
			return;
		}
		let selectedID = id;
		const registry = jobs;
		try {
			while (runtimeActive && generation === sessionGeneration) {
				const child = children.find((entry) => entry.id === selectedID);
				if (!child) break;
				let page: ChildSessionPage | undefined;
				let entries: ComposerChild[] = [];
				let shells: ShellRun[] = [];
				const shellOwner: OwnerContext = { cwd: child.cwd, parentID: child.id, parentFile: child.file,
					sessionDir: childSessionDir(child.owner.sessionDir, child.id) };
				const read = ctx.mode === "tui" ? readChildTranscript : readChildTimeline;
				const load = async (): Promise<string[] | ChildTranscript> => {
					if (!runtimeActive || generation !== sessionGeneration) return ["(Parent session changed. Esc to return.)"];
					if (ctx.mode === "tui") {
						const updated = await composerFamily(ctx, registry, child.id);
						if (!runtimeActive || generation !== sessionGeneration) return ["(Parent session changed. Esc to return.)"];
						children = updated.children;
						entries = updated.entries;
						page?.updateChildren(entries);
						shellOwner.parentFile = children.find((entry) => entry.id === child.id)?.file;
						shells = await readShellRuns(shellOwner);
					}
					const outputPath = path.join(child.owner.cwd, ".pi", "agents", "jobs", `${child.id}.jsonl`);
					if (foregroundAborters.has(child.id) || child.depth > 1 && existsSync(outputPath)) return read(outputPath, "events");
					const record = await (child.owner.cwd === ctx.cwd ? registry : new JobRegistry(child.owner.cwd)).get(child.id);
					if (record && !record.notified && record.parentSessionID === child.owner.parentID) return read(record.outputPath, "events");
					const owned = await findOwnedChild(child.owner, child.id);
					return owned ? read(owned.file, "session") : ["(Waiting for child output…)"];
				};
				const lines = await load();
				if (!runtimeActive || generation !== sessionGeneration) break;
				if (ctx.mode !== "tui") { ctx.ui.notify(`Subagent ${child.id}\n${(lines as string[]).slice(-30).join("\n")}`, "info"); break; }
				const name = agents.find((agent) => agent.id === child.agent)?.name ?? child.agent;
				const action = await ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
					const finish = (id?: string) => { page?.dispose(); done(id); };
					closeChildPage = () => finish(); // shutdown closes every overlay, not just one level
					page = new ChildSessionPage(tui, theme, keys, child.id, lines, () => finish(child.owner.parentID), {
						cwd: child.cwd,
						toolDefinitions: childToolDefinitions,
						presentation: captureChildPresentation(tui, childToolDefinitions, pi.getSettings?.()),
						title: `${name}: ${child.description ?? child.id}`,
						load,
						children: entries,
						shells: () => shells,
						interruptShell: async (id) => {
							if (generation !== sessionGeneration || !runtimeActive) return "Session changed";
							const verified = (await ownedFamily(ctx)).find((entry) => entry.id === child.id);
							if (!verified || verified.file !== shellOwner.parentFile || verified.owner.sessionDir !== child.owner.sessionDir) return "Not a child of this conversation";
							return cancelShellRun(shellOwner, id);
						},
						viewChild: (id) => { if (id !== child.id) finish(id); },
						interruptChild: (id) => generation === sessionGeneration ? interruptChild(ctx, id) : Promise.resolve("Session changed"),
						backgroundWork: () => { if (generation === sessionGeneration) backgroundForegroundWork(); },
						pendingForms: () => formHost?.pendingCount ?? 0,
					});
					const presentation: ChildPageDecoration = {
						sessionID: ctx.sessionManager.getSessionId(), childID: child.id,
						title: `${name}: ${child.description ?? child.id}`, cwd: child.cwd,
						...(child.branch ? { branch: child.branch } : {}),
						tui, theme, page, component: page,
						viewChild: (id) => { if (id !== child.id) finish(id); },
					};
					pi.events?.emit(AGENTS_UI_DECORATE, presentation);
					return presentation.component;
				}, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" } });
				if (!action || action === ctx.sessionManager.getSessionId()) break;
				selectedID = action;
			}
		} finally {
			if (generation === sessionGeneration) { childPageOpen = false; closeChildPage = undefined; }
		}
	}

	pi.registerCommand("agents", {
		description: "List agents and inspect, view, or cancel child sessions",
		handler: async (args, ctx) => {
			if (agents.length === 0) reloadAgents(ctx);
			const [subcommand, requestedID] = args.trim().split(/\s+/).filter(Boolean);
			if (subcommand === "models") { await showSubagentModels(ctx); return; }
			if (subcommand === "background") {
				const count = backgroundForegroundWork();
				ctx.ui.notify(count ? `Moving ${count} running subagent(s) to the background` : "No foreground subagents are running", "info");
				return;
			}
			if (ctx.mode === "tui" && !subcommand) {
				await refreshComposer(ctx, sessionGeneration);
				composerEditor?.open();
				return;
			}

			if (subcommand === "migrate") {
				const owner = ownerContext(ctx);
				const legacy = { ...owner, sessionDir: ctx.sessionManager.getSessionDir() };
				const children = await listOwnedChildren(legacy);
				let moved = 0;
				let skipped = 0;
				for (const child of children) {
					if (!child.file || activeChildren.has(child.id) || await jobs.pending(child.id)) { skipped++; continue; }
					try {
						if (await migrateOwnedChild(legacy, owner, child.id)) moved++;
						else skipped++;
					} catch { skipped++; }
				}
				ctx.ui.notify(`Moved ${moved} old child session(s) out of /resume.${skipped ? ` ${skipped} skipped (running, incomplete, or inaccessible).` : ""}`, "info");
				return;
			}

			if (subcommand === "sessions" || subcommand === "view") {
				const children = await ownedFamily(ctx);
				if (subcommand === "sessions") {
					ctx.ui.notify(children.length
						? children.map((child) => `${child.prefix}${child.id} - ${child.agent}${child.file ? "" : " (starting)"}${child.owner.sessionDir === ctx.sessionManager.getSessionDir() ? " (legacy)" : ""}${child.workspace ? `\n  branch: ${child.workspace.branch}\n  worktree: ${child.workspace.path}` : ""}`).join("\n")
						: "No child sessions belong to this conversation", "info");
					return;
				}
				if (!requestedID && ctx.mode === "tui") {
					await refreshComposer(ctx, sessionGeneration);
					composerEditor?.open();
					return;
				}
				if (!requestedID) {
					ctx.ui.notify("Usage: /agents view <sessionID> (or /agents sessions)", "warning");
					return;
				}
				await showChildSession(ctx, requestedID);
				return;
			}

			if (subcommand === "running") {
				const { entries } = await composerFamily(ctx, jobs);
				const running = entries.filter((entry) => entry.status === "running");
				if (running.length === 0) {
					ctx.ui.notify("No subagents are running", "info");
					return;
				}
				ctx.ui.notify(
					running
						.map((child) => `${child.id}\n  ${child.agent}: ${child.title} (${child.background ? "background" : "foreground"})`)
						.join("\n"),
					"info",
				);
				return;
			}

			if (subcommand === "cancel") {
				const id = args.trim().split(/\s+/).filter(Boolean)[1];
				if (!id) {
					ctx.ui.notify("Usage: /agents cancel <sessionID>", "warning");
					return;
				}
				const message = await interruptChild(ctx, id);
				ctx.ui.notify(message, message.startsWith("Stopped ") || message.startsWith("Interrupted ") ? "info" : "warning");
				return;
			}

			const lines: string[] = [];
			lines.push(`Active primary agent: ${activePrimary}`);
			lines.push("");
			lines.push("Primary agents:");
			for (const agent of primaryAgents(agents)) {
				lines.push(`  ${agent.id}${agent.id === activePrimary ? " *" : ""} - ${agent.description || "(no description)"}`);
			}
			lines.push("");
			lines.push("Subagents:");
			for (const agent of subagents(agents)) {
				const tools = agent.tools ? agent.tools.join(",") : "all tools";
				lines.push(`  ${agent.id}${agent.hidden ? " (hidden)" : ""} - ${agent.description || "(no description)"}`);
				lines.push(`      tools: ${tools}`);
			}
			const { children, entries } = await composerFamily(ctx, jobs);
			const running = entries.filter((entry) => entry.status === "running");
			if (running.length > 0) {
				lines.push("");
				lines.push(`Running subagents (${running.length}):`);
				for (const child of running) lines.push(`  ${child.prefix}${child.id} - ${child.agent}: ${child.title}`);
			}
			if (children.length) {
				lines.push("");
				lines.push(`Child sessions (${children.length}):`);
				for (const child of children.slice(-8)) lines.push(`  ${child.prefix}${child.id} - ${child.agent}${child.file ? "" : " (starting)"}${child.owner.sessionDir === ctx.sessionManager.getSessionDir() ? " (legacy)" : ""}`);
			}
			lines.push("");
			lines.push("Commands: /agent <id> | /agents models | /agents sessions | /agents view <id> | /agents migrate | /agents running | /agents cancel <id>");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("agent", {
		description: "Switch the primary agent (usage: /agent <id>)",
		handler: async (args, ctx) => {
			if (agents.length === 0) reloadAgents(ctx);
			const id = args.trim();
			const primaries = primaryAgents(agents);

			if (!id) {
				const names = primaries.map((agent) => agent.id);
				if (!ctx.hasUI || names.length === 0) {
					ctx.ui.notify(`Usage: /agent <${names.join("|") || "id"}>`, "warning");
					return;
				}
				const choice = await ctx.ui.select("Switch primary agent", names);
				if (!choice) return;
				await switchPrimary(choice, ctx);
				return;
			}

			if (!primaries.some((agent) => agent.id === id)) {
				ctx.ui.notify(
					`Unknown primary agent: ${id}. Available: ${primaries.map((agent) => agent.id).join(", ") || "none"}`,
					"warning",
				);
				return;
			}
			await switchPrimary(id, ctx);
		},
	});

	async function switchPrimary(id: string, ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
		if (id !== activePrimary) pi.appendEntry(PRIMARY_SELECTION_TYPE, { id });
		pendingLeavePlan = activePrimary === "plan" && id !== "plan";
		activePrimary = id;
		const agent = currentAgent();
		// OpenCode's step budget belongs to the agent, so a switch resets it.
		steps.reset();
		steps.setLimit(agent?.steps);
		if (ctx.hasUI) ctx.ui.setStatus("agent", id === "build" ? undefined : `agent: ${id}`);

		applyToolPolicy();
		ctx.ui.notify(
			`Switched to ${agent?.name ?? id}${toolsRestricted ? ` (tools: ${pi.getActiveTools().join(", ") || "none"})` : " (selected tools)"}`,
			"info",
		);
	}

	/* -------------------------------------------------------------- */
	/* Completion renderer                                            */
	/* -------------------------------------------------------------- */

	pi.registerMessageRenderer("subagent-completion", (message, options, theme) => {
		const details = message.details as { agent?: string; state?: string; description?: string } | undefined;
		const label = details?.agent ? `${details.agent}` : "subagent";
		const state = details?.state ?? "completed";
		const icon = state === "completed" ? "✓" : state === "error" ? "✗" : "⏳";
		const color = state === "completed" ? "success" : state === "error" ? "error" : "warning";
		const content = typeof message.content === "string" ? message.content : "";
		const body = options.expanded ? content : content.split("\n").slice(0, 8).join("\n");
		return new Text(
			`${theme.fg(color, icon)} ${theme.fg("accent", label)} ${theme.fg("dim", details?.description ?? "")}\n${body}`,
			0, 0,
		);
	});
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function normalizeInput(params: {
	agent?: string;
	description?: string;
	prompt?: string;
	model?: string;
	sessionID?: string;
	background?: boolean;
	isolation?: "shared" | "worktree";
}): { agent?: string; description?: string; prompt?: string; model?: string; sessionID?: string; background?: boolean; isolation?: "shared" | "worktree" } {
	// OpenCode's execute.before hook deletes empty model/sessionID strings that
	// some providers send for omitted optional fields.
	const input = { ...params };
	if (!input.model) delete input.model;
	if (!input.sessionID) delete input.sessionID;
	return input;
}

function experimentalEnabled(pi: ExtensionAPI): boolean {
	const env = process.env.OPENCODE_EXPERIMENTAL_SCOUT;
	if (env === "1" || env === "true") return true;
	if (env === "0" || env === "false") return false;
	return pi.getFlag("agent-experimental") === true;
}

function subagentDepth(pi: ExtensionAPI): number {
	const configured = pi.getFlag("agent-depth") ?? process.env.PI_AGENT_DEPTH_LIMIT;
	const parsed = typeof configured === "string" ? Number.parseInt(configured, 10) : Number.NaN;
	if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	return DEFAULT_SUBAGENT_DEPTH;
}

/** OpenCode writes plan files to `<home>/.opencode/plan`; Pi uses its agent dir. */
function planDirectory(): string {
	return path.join(getAgentDir(), "plan");
}

function ownerContext(ctx: ExtensionContext): OwnerContext {
	const parentID = ctx.sessionManager.getSessionId();
	return {
		cwd: ctx.cwd,
		sessionDir: childSessionDir(ctx.sessionManager.getSessionDir(), parentID),
		parentID,
		parentFile: ctx.sessionManager.getSessionFile(),
	};
}

function createChildId(agentId: string): string {
	const stamp = Date.now().toString(36);
	const random = Math.random().toString(36).slice(2, 8);
	return `sub-${agentId}-${stamp}${random}`;
}

/** Environment that tells a child process which agent and depth it runs at. */
function subagentEnvironment(agent: AgentDefinition, depth: number, scope: string, limit: number, strictShell: boolean): Record<string, string> {
	return {
		PI_AGENT_ID: agent.id,
		PI_AGENT_DEPTH: String(depth),
		PI_AGENT_DEPTH_LIMIT: String(limit),
		PI_AGENT_STRICT_SHELL: strictShell ? "1" : "0",
		// Children load only user-level agents unless the parent opted into project scope.
		PI_AGENT_SCOPE: scope,
	};
}

/**
 * Whether an error means the extension runtime was torn down.
 *
 * Pi throws this specific message once a session is replaced or reloaded, and
 * nothing will make delivery work again in this process. Every other error is
 * treated as transient.
 */
function isStaleRuntimeError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("stale after session replacement or reload");
}

function failure(message: string) {
	return { content: [{ type: "text" as const, text: message }], details: undefined };
}
