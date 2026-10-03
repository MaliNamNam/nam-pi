import { basename } from "node:path";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import {
  matchesKey, sliceByColumn, truncateToWidth,
  type Component, type EditorTheme, type TUI, type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { Sidebar, type SidebarSubagent } from "./slate/sidebar.ts";
import { ComposerEditor, chromePaint, composerLabels, frameRow, inscribedBorder, inscribedTitle, noteComposerFrameLines, type ComposerSource } from "./slate/composer.ts";
import { modelStatusLabel, workspaceColumnWidth } from "./slate/layout.ts";
import type { FileChange } from "./slate/files-modified.ts";
import type { ResourceCatalog, ResourceItem } from "./slate/resources.ts";

// Structural contracts over pi.events: neither extension needs to import the
// other's installation path, and either can still run independently.
export interface AgentComposer extends Component {
  isPanelOpen: boolean;
  hasJobs: boolean;
  open(): void;
  close(): void;
  handleInput(data: string): void;
  render(width: number, maxHeight?: number): string[];
}
export interface AgentController {
  sessionID: string;
  createComposer(tui: TUI, theme: EditorTheme, keys: KeybindingsManager): AgentComposer;
  viewChild(id: string): void;
}
export interface AgentState { sessionID: string; children: SidebarSubagent[]; }
interface TranscriptEntry {
  type: "message" | "tool";
  message?: Record<string, any>;
  id?: string;
  name?: string;
  args?: { path?: string };
  result?: { isError?: boolean; usage?: { cost?: { total?: number } } };
}
interface Transcript {
  entries: TranscriptEntry[];
  model?: { provider: string; id: string; contextWindow?: number };
  thinking?: string;
  stats?: { spend: number; tokens: number | null; cacheHitRate: number | null; files: string[]; tools?: string[] };
}
interface AgentPage extends Component {
  snapshot: { data: string[] | Transcript; children: SidebarSubagent[] };
  setComposerFrame(frame: (lines: string[], width: number) => string[]): void;
  dispose(): void;
}
export interface ChildDecoration {
  sessionID: string;
  childID: string;
  cwd: string;
  tui: TUI;
  theme: Theme;
  page: AgentPage;
  component: Component;
  viewChild(id: string): void;
}

/** Keep V2's controls/selection, but use the same rounded Pi workspace chrome. */
export function frameAgentComposer(lines: string[], width: number, source: ComposerSource): string[] {
  const paint = chromePaint(source.theme);
  const labels = composerLabels({
    project: source.project, branch: source.branch, model: modelStatusLabel(source.model, source.modelDisplay),
    thinking: source.thinking, version: source.version, footer: source.footer,
  }, source.theme, width);
  return [
    inscribedTitle("", width, paint, "top"),
    ...lines.map((line) => frameRow(sliceByColumn(line, 1, Math.max(0, width - 2)), width, paint)),
    inscribedBorder(labels.left, labels.right, width, paint, "╰", "╯"),
  ];
}

/** The root retains its framed text editor and delegates only the job panel. */
export class AgentWorkspaceEditor extends ComposerEditor {
  private agents?: AgentComposer;
  private readonly workspace: () => ComposerSource;

  constructor(tui: TUI, theme: EditorTheme, keys: KeybindingsManager, source: () => ComposerSource, agents?: AgentComposer) {
    super(tui, theme, keys, source);
    this.workspace = source;
    this.agents = agents;
  }
  connect(agents: AgentComposer): void { this.agents = agents; }
  openSubagents(): void { this.agents?.open(); }
  override handleInput(data: string): void {
    if (this.agents?.isPanelOpen) return this.agents.handleInput(data);
    if (this.agents?.hasJobs && matchesKey(data, "down") && !this.getText().trim() && !this.isShowingAutocomplete()) {
      this.agents.open();
      return;
    }
    super.handleInput(data);
  }
  override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.agents?.isPanelOpen
      ? this.agents.handleMouse?.({ ...event, y: event.y - 1, height: Math.max(0, event.height - 2) })
      : super.handleMouse(event);
  }
  override render(width: number): string[] {
    if (!this.agents?.isPanelOpen) return super.render(width);
    const lines = frameAgentComposer(this.agents.render(width, Math.max(1, this.tui.terminal.rows - 2)), width, this.workspace());
    noteComposerFrameLines(lines.length);
    return lines;
  }
}

/** Child-only facts. Never present the parent's context/spend as the child's. */
export function childFacts(data: string[] | Transcript, ctx: ExtensionContext) {
  const entries = Array.isArray(data) ? [] : data.entries;
  let latest: Record<string, any> | undefined;
  let spend = 0;
  for (const entry of entries) {
    if (entry.type === "tool") {
      spend += entry.result?.usage?.cost?.total ?? 0;
      continue;
    }
    const message = entry.message;
    if (message?.role !== "assistant") continue;
    spend += message.usage?.cost?.total ?? 0;
    if (message.usage && (message.usage.input || message.usage.cacheRead || message.usage.cacheWrite || message.usage.output)) latest = message;
  }
  const ref = !Array.isArray(data) ? data.model : undefined;
  const model = ref ? { ...(ctx.modelRegistry.find(ref.provider, ref.id) ?? {}), ...ref } : undefined;
  const stats = !Array.isArray(data) ? data.stats : undefined;
  const usage = latest?.usage;
  const prompt = usage ? (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) : 0;
  const tokens = stats ? stats.tokens : usage ? prompt + (usage.output ?? 0) : null;
  if (stats) spend = stats.spend;
  const window = model && "contextWindow" in model ? model.contextWindow : undefined;
  return {
    model,
    thinking: Array.isArray(data) ? undefined : data.thinking,
    context: {
      tokens, percent: tokens != null && window ? tokens / window * 100 : null,
      spend, cacheHitRate: stats ? stats.cacheHitRate : prompt > 0 ? (usage.cacheRead ?? 0) / prompt * 100 : null, tokensPerSec: 0,
    },
  };
}

/** Full-page inspection in the existing workspace, not a second Pi terminal. */
export class ChildWorkspacePage implements Component {
  private readonly sidebar = new Sidebar();
  private paneWidth = 0;
  private chatWidth = 0;
  private disposed = false;
  private impactRevision = 0;
  private impactData?: string[] | Transcript;
  private factsData?: string[] | Transcript;
  private facts?: ReturnType<typeof childFacts>;

  constructor(private readonly request: ChildDecoration, private readonly ctx: ExtensionContext, private readonly source: {
    hidden(): boolean;
    width(): number | undefined;
    branch(): string | null;
    files(): FileChange[];
    resources(): ResourceCatalog;
    toggleResource?(item: ResourceItem): ResourceItem | undefined;
    persistWidth(width: number | undefined): void;
    onDispose?(): void;
  }) {
    // Bind only; attach() would install a second root splitter or overlay.
    this.sidebar.bind(request.tui, ctx.ui.theme);
    this.sidebar.setPreferredWidth(source.width());
    this.sidebar.setActions({
      viewSubagent: request.viewChild,
      persistWidth: source.persistWidth,

    });
    request.page.setComposerFrame((lines, width) => frameAgentComposer(lines, width, this.composerSource()));
  }

  private currentFacts(): ReturnType<typeof childFacts> {
    const data = this.request.page.snapshot.data;
    if (!this.facts || data !== this.factsData) {
      this.factsData = data;
      this.facts = childFacts(data, this.ctx);
    }
    return this.facts;
  }
  private composerSource(): ComposerSource {
    const facts = this.currentFacts();
    return {
      project: basename(this.request.cwd), branch: this.source.branch(),
      model: facts.model, thinking: facts.thinking, version: `pi-${VERSION}`,
      footer: "standard", theme: this.ctx.ui.theme,
    };
  }
  /**
   * Claim the widget's keys before the child page sees them, mirroring the
   * root's raw-input listener. Only while a widget is open, so Space and the
   * arrows keep their normal meaning everywhere else.
   */
  handleInput(data: string): void {
    if (this.disposed) return;
    if (this.sidebar.resourceWidgetOpen && this.sidebar.handleResourceKey(data)) return;
    this.request.page.handleInput?.(data);
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.x >= this.chatWidth && this.paneWidth > 0) {
      return this.sidebar.handleMouse({ ...event, x: event.x - this.chatWidth, width: this.paneWidth });
    }
    return this.request.page.handleMouse?.({ ...event, width: this.chatWidth });
  }
  render(width: number): string[] {
    const { page, tui } = this.request;
    const height = Math.max(1, tui.terminal.rows);
    this.paneWidth = this.source.hidden() ? 0 : workspaceColumnWidth(width, this.sidebar.preferredWidth);
    this.chatWidth = Math.max(1, width - this.paneWidth);
    const snapshot = page.snapshot;
    const facts = this.currentFacts();
    this.sidebar.setContext(facts.context);
    this.sidebar.setSubagents(snapshot.children);
    const data = Array.isArray(snapshot.data) ? undefined : snapshot.data;
    const touched = data?.stats?.files ?? (data?.entries ?? []).flatMap((entry) =>
      entry.type === "tool" && ["edit", "write"].includes(entry.name ?? "") && entry.result && !entry.result.isError && typeof entry.args?.path === "string" ? [entry.args.path] : []);
    // These are edits attributed to this child, not the shared worktree's git diff.
    this.sidebar.setFiles([...new Set(touched)].map((path) => ({ path, index: " ", worktree: "M" })));
    this.sidebar.setChildTools(data?.stats?.tools);
    this.sidebar.setWorking(snapshot.children.some((child) => child.id === this.request.childID && child.status === "running") && this.paneWidth > 0);
    // The pane is rendered conditionally, so an off-screen child stops its idle
    // sweep instead of animating a box nobody can see.
    this.sidebar.setIdleAnimating(this.paneWidth > 0);
    if (snapshot.data !== this.impactData) {
      this.impactData = snapshot.data;
      const data = snapshot.data;
      const entries = Array.isArray(data) ? [] : data.entries;
      // Same Last Turn categories, sourced from the viewed child's tool calls.
      let lastUser = -1;
      for (let index = entries.length - 1; index >= 0; index--) {
        if (entries[index].type === "message" && entries[index].message?.role === "user") { lastUser = index; break; }
      }
      const tools = entries.slice(Math.max(0, lastUser)).filter((entry) => entry.type === "tool");
      this.sidebar.setTurnImpact({ revision: ++this.impactRevision, toolsCalled: tools.length, events: tools.map((entry, index) => ({
        id: entry.id ?? String(index), toolName: entry.name ?? "tool", title: entry.name ?? "tool", detail: "",
        isError: entry.result?.isError === true, pending: !entry.result,
      })) });
    }
    const chat = page.render(this.chatWidth);
    const pane = this.paneWidth > 0 ? this.sidebar.render(this.paneWidth, height, 4) : [];
    return Array.from({ length: height }, (_, row) =>
      truncateToWidth(chat[row] ?? "", this.chatWidth, "", true) + (pane[row] ?? ""));
  }
  invalidate(): void {
    this.request.page.invalidate();
    this.sidebar.bind(this.request.tui, this.ctx.ui.theme);
    this.sidebar.invalidate();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sidebar.dispose();
    this.request.page.dispose();
    this.source.onDispose?.();
  }
}
