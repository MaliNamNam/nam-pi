/**
 * Side Panel — a dashboard for Pi's terminal UI, built on pi-slate's Sidebar.
 *
 * The panel docks to the right edge and shows:
 *
 *   Summary    files changed in the work tree, and last-turn activity
 *   Resources  loaded skills and connected MCP servers
 *   Context    tokens, spend, and cache hit rate
 *   Subagents  verified live children; click to inspect
 *
 * `/side-panel` toggles the whole panel, including child workspaces.
 *
 * Usage:
 *   pi -e ./pi-side-panel
 *   /side-panel          toggle the sidebar
 *
 * The sidebar, its split layout, and the framed composer come from
 * pi-slate (MIT, Gagan Devagiri); see LICENSE-pi-slate.
 */

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Sidebar } from "./slate/sidebar.ts";
import { installConversationFrames } from "./slate/conversation-frames.ts";
import { GitStatusPoller } from "./slate/git-status.ts";
import { TurnImpactTracker } from "./slate/turn-impact.ts";
import { resolveContextTokens, sessionSpend } from "./slate/context-usage.ts";
import { loadResourceCatalog, loadToolItems, toggleResourceItem, type ResourceCatalog, type ToolSummary } from "./slate/resources.ts";
import { AgentWorkspaceEditor, ChildWorkspacePage, type AgentController, type AgentState, type ChildDecoration } from "./agents-ui.ts";
import type { FileChange } from "./slate/files-modified.ts";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Columns the sidebar occupies by default; pi-slate's default is 20%. */
const SIDEBAR_PERCENT = 24;

// ---------------------------------------------------------------------------
// Footer — model, thinking level, and git branch
// ---------------------------------------------------------------------------

/**
 * The bottom bar. pi-slate draws this inside the composer frame and leaves its
 * `BranchFooter` empty; here it is a real footer, so the layout is unchanged
 * when the composer is replaced.
 */
function buildFooter() {
	return (
		tui: TUI,
		_theme: unknown,
		footerData: {
			getGitBranch(): string | null;
			onBranchChange(cb: () => void): () => void;
			getExtensionStatuses?(): ReadonlyMap<string, string>;
		},
	) => {
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
		return {
			dispose: unsubscribe,
			invalidate(): void {},
			/**
			 * Deliberately not a status line.
			 *
			 * The composer's bottom border already shows the project, Pi version,
			 * branch, model, and thinking level, so repeating them here would render
			 * the same facts twice. Subagent activity lives in the sidebar. This
			 * footer carries only other extensions' statuses.
			 */
			render(width: number): string[] {
				const theme = tuiTheme();
				const lines: string[] = [];

				// Extension statuses, the same source Pi's built-in footer reads.
				// The `agents` extension publishes the active primary agent here, and
				// any forms waiting at the root.
				const statuses = footerData.getExtensionStatuses?.();
				if (statuses && statuses.size > 0) {
					const text = [...statuses.entries()]
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, value]) => sanitizeStatus(value))
						.filter(Boolean)
						.join(" ");
					if (text) lines.push(truncateToWidth(theme.fg("dim", text), width, ""));
				}

				return lines;
			},
		};
	};
}

/**
 * Status text comes from other extensions, so drop control characters that
 * would move the cursor or erase, and keep it to one line.
 */
function sanitizeStatus(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/[\x00-\x1f\x7f]/g, " ").trim();
}

/** The active theme, refreshed from the extension context on each render. */
let themeSource: (() => ExtensionContext["ui"]["theme"]) | undefined;
function tuiTheme(): ExtensionContext["ui"]["theme"] {
	if (!themeSource) throw new Error("theme requested before a session started");
	return themeSource();
}

/**
 * The prompt cache hit rate for the most recent request, as a percentage.
 *
 * This mirrors Pi's built-in footer: it walks the session in order and keeps
 * the rate from the last assistant message that reported usage, so the figure
 * reflects the latest request rather than a session-wide average. Returns null
 * before any request reports cache usage.
 */
function latestCacheHitRate(ctx: ExtensionContext): number | null {
	let rate: number | null = null;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = (entry.message as {
			usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
		}).usage;
		if (!usage) continue;
		const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		rate = promptTokens > 0 ? ((usage.cacheRead ?? 0) / promptTokens) * 100 : null;
	}
	return rate;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function sidePanelExtension(pi: ExtensionAPI): void {
	const sidebar = new Sidebar();
	let ctxRef: ExtensionContext | undefined;
	let activeTui: TUI | undefined;
	let uninstallConversationFrames: (() => void) | undefined;
	let panelOpen = true;
	let turnStartedAt = 0;
	let turnStartOutput = 0;
	let totalOutputTokens = 0;
	let tokensPerSecond = 0;
	let gitBranch: string | null = null;

	let agentUI: AgentController | undefined;
	let linkedController: AgentController | undefined;
	let workspaceEditor: AgentWorkspaceEditor | undefined;
	let connectComposer: ((controller: AgentController) => void) | undefined;
	let latestFiles: FileChange[] = [];
	let resourceCatalog: ResourceCatalog = { extensions: [], skills: [], mcp: [], tools: [] };
	/** Removes the raw-input listener that claims keys while a widget is open. */
	let detachResourceKeys: (() => void) | undefined;

	pi.events?.on("pi-agents:ui:connect", (value) => {
		const controller = value as AgentController;
		if (ctxRef && controller.sessionID !== ctxRef.sessionManager.getSessionId()) return;
		agentUI = controller;
		if (linkedController !== controller) connectComposer?.(controller);
	});
	pi.events?.on("pi-agents:ui:state", (value) => {
		const state = value as AgentState;
		if (!ctxRef || state.sessionID !== ctxRef.sessionManager.getSessionId()) return;
		sidebar.setSubagents(state.children);
	});
	pi.events?.on("pi-agents:ui:decorate-child", (value) => {
		const request = value as ChildDecoration;
		if (!ctxRef || request.sessionID !== ctxRef.sessionManager.getSessionId()) return;
		const owner = ctxRef;
		// Remove the root's regular-mode overlay while the full child workspace
		// owns the screen; its stats/widgets must not leak over the child pane.
		sidebar.setHidden(true);
		request.component = new ChildWorkspacePage(request, ctxRef, {
			hidden: () => !panelOpen, width: () => sidebar.preferredWidth,
			branch: () => gitBranch, files: () => latestFiles, resources: () => resourceCatalog,
			// A child pane shares the root's catalog and settings file, so a toggle
			// there has to refresh the root's counts too, or the two panels would
			// disagree until the next reload.
			toggleResource: (item) => {
				if (!ctxRef) return undefined;
				try {
					const updated = toggleResourceItem(item, { cwd: ctxRef.cwd });
					applyToolToggle(updated);
					syncResources();
					return updated;
				} catch {
					return undefined;
				}
			},
			persistWidth: (width) => sidebar.setPreferredWidth(width),
			onDispose: () => { if (ctxRef === owner) sidebar.setHidden(!panelOpen); },
		});
	});

	const requestRender = (force = false) => activeTui?.requestRender(force);
	const getContext = (): ExtensionContext => {
		if (!ctxRef) throw new Error("side-panel has not received a session context");
		return ctxRef;
	};

	// --- Work-tree files -----------------------------------------------------

	const files = new GitStatusPoller((changes) => {
		latestFiles = changes;
		sidebar.setFiles(changes);
		requestRender();
	});

	// --- Turn activity -------------------------------------------------------

	const turnImpact = new TurnImpactTracker();

	// --- Context metrics -----------------------------------------------------

	/** Refresh the Context dock and the composer's context edge. */
	const syncContext = (): void => {
		const ctx = ctxRef;
		if (!ctx) return;
		try {
			const resolved = resolveContextTokens(
				ctx.getContextUsage(),
				ctx.sessionManager.buildContextEntries(),
				ctx.model?.contextWindow,
			);
			sidebar.setContext({
				tokens: resolved.tokens,
				percent: resolved.percent,
				tokensPerSec: tokensPerSecond,
				spend: sessionSpend(ctx.sessionManager.getBranch()),
				cacheHitRate: latestCacheHitRate(ctx),
			});
		} catch {
			/* Context usage is best-effort; leave the last value in place. */
		}
	};

	/**
	 * Refresh the Resources counts from Pi's own resolver.
	 *
	 * Counting through the catalog rather than through the live command and tool
	 * lists keeps the counts and the widget's rows in agreement: both describe
	 * what settings resolve to, including entries that are currently disabled.
	 * Tools are the one kind the resolver does not cover — the session's tool
	 * registry is their only source of truth, so they are read from the live API
	 * and merged in here.
	 */
	const syncResources = (): void => {
		const ctx = ctxRef;
		if (!ctx) return;
		let registeredMcpServers: readonly { name: string }[] = [];
		try {
			registeredMcpServers = pi.getMcpServers();
		} catch {
			/* Older hosts do not expose registered MCP servers. */
		}
		void loadResourceCatalog({ cwd: ctx.cwd, registeredMcpServers })
			.then((catalog) => {
				// A reload or shutdown may have replaced the session while this was
				// resolving; the stale catalog must not land on the new panel.
				if (ctxRef !== ctx) return;
				catalog.tools = loadToolItems(readToolSummaries(), pi.getActiveTools());
				resourceCatalog = catalog;
				sidebar.setResourceCatalog(catalog);
				requestRender();
			})
			.catch(() => {
				/* A missing or malformed settings file leaves the last counts in place. */
			});
	};

	/** The host's tool registry, tolerating hosts that predate `getAllTools`. */
	const readToolSummaries = (): ToolSummary[] => {
		try {
			return (pi.getAllTools() ?? []) as unknown as ToolSummary[];
		} catch {
			return [];
		}
	};

	/**
	 * Make a saved tool toggle take effect without waiting for `/reload`.
	 *
	 * Extensions and MCPs only re-read their settings on reload, but a tool's
	 * active set is live state, so the same names go through
	 * `setActiveTools()` now. Unknown names are ignored, and the saved pattern
	 * keeps the choice across sessions.
	 */
	const applyToolToggle = (updated: ReturnType<typeof toggleResourceItem>): void => {
		if (updated.kind !== "tools" || updated.lockedReason) return;
		try {
			const active = new Set(pi.getActiveTools());
			if (updated.enabled) active.add(updated.name);
			else active.delete(updated.name);
			pi.setActiveTools([...active]);
		} catch {
			/* The saved pattern still applies on the next session. */
		}
	};

	// --- Turn bookkeeping ----------------------------------------------------

	pi.on("turn_start", () => {
		turnStartedAt = Date.now();
		turnStartOutput = totalOutputTokens;
		// The spotlight runs for the whole turn, from the first token to the
		// settle, so the panel reads as busy rather than idle between tool calls.
		sidebar.setWorking(true);
		syncContext();
		requestRender();
	});

	pi.on("turn_end", () => {
		const seconds = Math.max(1, Date.now() - turnStartedAt) / 1000;
		const produced = Math.max(0, totalOutputTokens - turnStartOutput);
		// A turn that finishes in a few milliseconds would report a meaningless
		// rate; show nothing instead of a four-digit number.
		tokensPerSecond = produced > 0 && seconds >= 1 ? produced / seconds : 0;
		syncContext();
		requestRender();
	});

	pi.on("message_end", (event) => {
		const message = event.message as {
			role?: string;
			usage?: { output?: number };

		};
		if (message.role === "assistant" && typeof message.usage?.output === "number") {
			totalOutputTokens += message.usage.output;
		}
		syncContext();
		requestRender();
	});

	pi.on("message_update", () => requestRender());

	pi.on("tool_execution_start", (event) => {
		sidebar.setTurnImpact(
			turnImpact.toolCall({ toolCallId: event.toolCallId, toolName: event.toolName, input: event.args }),
		);
		requestRender();
	});

	pi.on("tool_execution_end", (event) => {
		sidebar.setTurnImpact(
			turnImpact.toolEnd({
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				isError: event.isError,
				result: event.result,
			}),
		);
		requestRender();
	});

	pi.on("agent_settled", () => {
		sidebar.setWorking(false);
		syncContext();
		requestRender();
	});

	// A server registering or unregistering changes the Resources counts, and the
	// catalog is where those counts come from. MCP tools register through the
	// same lifecycle, so the tool rows refresh with the servers.
	pi.on("mcp_servers_change", () => syncResources());

	// --- Lifecycle -----------------------------------------------------------

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctxRef = ctx;
		themeSource = () => getContext().ui.theme;
		uninstallConversationFrames = installConversationFrames(() => getContext().ui.theme);
		if (!uninstallConversationFrames) ctx.ui.notify("side-panel: Pi's message UI changed; conversation frames are unavailable.", "warning");
		workspaceEditor = undefined;
		connectComposer = undefined;
		linkedController = undefined;
		sidebar.setSubagents([]);
		pi.events?.emit("pi-agents:ui:request", undefined);

		sidebar.setPreferredWidth(SIDEBAR_PERCENT);
		sidebar.setHidden(!panelOpen);
		// A resumed session may already be mid-turn; the spotlight is driven by
		// turn events, so start settled and let the next turn_start arm it.
		sidebar.setWorking(false);
		sidebar.setTurnImpact(turnImpact.restore(ctx.sessionManager.getBranch()));
		sidebar.setActions({
			persistWidth: (percent) => {
				sidebar.setPreferredWidth(percent);
			},
			viewSubagent: (id) => agentUI?.viewChild(id),
			openSubagents: () => workspaceEditor?.openSubagents(),
			// The panel decides which row was toggled; the file write happens here
			// so the render path stays free of I/O.
			toggleResource: (item) => {
				try {
					const updated = toggleResourceItem(item, { cwd: ctx.cwd });
					applyToolToggle(updated);
					ctx.ui.notify(
						`${updated.enabled ? "Enabled" : "Disabled"} ${updated.name} — saved; run /reload to apply`,
						"info",
					);
					return updated;
				} catch (error) {
					ctx.ui.notify(
						`Could not save ${item.name}: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return undefined;
				}
			},
		});

		files.start(ctx.cwd);

		ctx.ui.setHeader((tui, _theme) => {
			activeTui = tui;
			// The sidebar mounts here: `attach` installs the split layout, or an
			// overlay when the host has no layout root.
			sidebar.attach(tui, getContext().ui.theme);
			requestRender();
			return {
				render: (width: number) => [truncateToWidth("", width, "")],
				invalidate: () => {},
			};
		});
		ctx.ui.setFooter((tui, theme, footerData) => {
			activeTui = tui;
			// The footer's data provider is the only source of the git branch.
			gitBranch = footerData.getGitBranch();
			return buildFooter()(tui, theme, footerData);
		});

		// Keep our editor chrome while embedding the agents extension's job panel.
		// Its live actions and autocomplete survive instead of being replaced.
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			activeTui = tui;
			const agentComposer = agentUI?.createComposer(tui, theme, keybindings);
			linkedController = agentUI;
			workspaceEditor = new AgentWorkspaceEditor(tui, theme, keybindings, () => ({
				project: sessionLabel(ctx),
				branch: gitBranch,
				model: ctx.model,
				thinking: ctx.thinkingLevel,
				version: `pi-${VERSION}`,
				footer: "standard",
				theme: getContext().ui.theme,
			}), agentComposer);
			connectComposer = (controller) => {
				workspaceEditor?.connect(controller.createComposer(tui, theme, keybindings));
				linkedController = controller;
			};
			return workspaceEditor;
		});
		// The panel's widget needs keys before the editor sees them, so it claims
		// Space and the arrows only while a Resources widget is open. Every other
		// key is passed through untouched, keeping the editor's normal behavior.
		detachResourceKeys?.();
		detachResourceKeys = ctx.ui.onTerminalInput((data) => {
			if (!panelOpen || sidebar.hidden || !sidebar.resourceWidgetOpen) return undefined;
			return sidebar.handleResourceKey(data) ? { consume: true } : undefined;
		});
		syncContext();
		syncResources();
		requestRender(true);
	});

	pi.on("session_shutdown", () => {
		uninstallConversationFrames?.();
		uninstallConversationFrames = undefined;
		detachResourceKeys?.();
		detachResourceKeys = undefined;
		files.dispose();
		sidebar.setWorking(false);
		sidebar.dispose();
		agentUI = undefined;
		linkedController = undefined;
		workspaceEditor = undefined;
		connectComposer = undefined;
		latestFiles = [];
		resourceCatalog = { extensions: [], skills: [], mcp: [], tools: [] };
		activeTui = undefined;
		ctxRef = undefined;
	});

	// --- Command -------------------------------------------------------------

	pi.registerCommand("side-panel", {
		description: "Toggle the side panel, or open its resource toggles",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("The side panel requires interactive mode.", "warning");
				return;
			}
			const kind = args.trim().toLowerCase();
			if (kind === "extensions" || kind === "skills" || kind === "mcps" || kind === "mcp" || kind === "tools") {
				if (!panelOpen) {
					panelOpen = true;
					sidebar.setHidden(false);
				}
				sidebar.openResourceWidget(kind === "mcps" || kind === "mcp" ? "mcp" : kind === "tools" ? "tools" : kind);
				requestRender(true);
				return;
			}
			panelOpen = !panelOpen;
			sidebar.setHidden(!panelOpen);
			requestRender(true);
			ctx.ui.notify(
				panelOpen ? "Side panel shown." : "Side panel hidden.",
				"info",
			);
		},
	});
}

/** The session name when set, else the working directory's folder name. */
function sessionLabel(ctx: ExtensionContext): string {
	return basename(ctx.cwd) || ctx.cwd;
}
