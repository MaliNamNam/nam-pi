import { type Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  stripTerminalSequences,
  type Component,
  type OverlayHandle,
  type OverlayOptions,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  isSidebarResizeHandle,
  clampSidebarColumns,
  formatCacheHit,
  formatContextUsage,
  formatResourceLines,
  formatSpend,
  formatTokenRate,
  parseSidebarPercent,
  sidebarPercentFromColumns,
  SIDEBAR_EDITOR_RESERVE,
  SIDEBAR_HIDDEN,
  SIDEBAR_MIN_TERMINAL_WIDTH,
  SIDEBAR_MIN_WIDTH,
  sidebarHandleColumn,
  workspaceColumnWidth,
} from "./layout.ts";
import {
  clampFilesOffset,
  fileMark,
  filesPanel,
  formatFileLabel,
  sameFiles,
  type FileChange,
} from "./files-modified.ts";
import { installSidebarSplit } from "./sidebar-split.ts";
import { formatTurnImpact, hasTurnImpact, type TurnImpactSnapshot } from "./turn-impact.ts";
import {
  filesWidgetDesiredHeight,
  resourcesWidgetDesiredHeight,
  SIDEBAR_DOCK_LINES,
  sidebarRowSlots,
  splitSidebarContent,
  subagentsSectionDesiredHeight,
} from "./workspace-layout.ts";
import type { ResourceCatalog, ResourceItem, ResourceKind } from "./resources.ts";
import { COMPOSER_SHELF_LINES, chromePaint, composerFrameLineCount, frameRow, frameRowBody, inscribedTitle } from "./composer.ts";
import { BORDER_LIGHT_TAIL, SPOTLIGHT_FRAME_MS, SpotlightText, WORKING_VERBS, IDLE_VERBS, BorderLight, borderLightGlyph } from "./spotlight.ts";

export type SidebarContextData = {
  tokens: number | null;
  percent: number | null;
  tokensPerSec: number;
  spend: number;
  /** Prompt cache hit rate, 0-100, or null before any request reports usage. */
  cacheHitRate?: number | null;
};

/**
 * What the panel can still ask its host to do.
 *
 * Copying and opening belonged to the file preview, which is gone; only width
 * persistence survives, because the resize handle is still interactive.
 */
export type SidebarSubagent = {
  id: string;
  agent: string;
  title: string;
  status: "running" | "completed" | "error" | "cancelled";
  prefix?: string;
  current?: boolean;
};

export type SidebarActions = {
  persistWidth?(columns: number | undefined): void;
  viewSubagent?(id: string): void;
  openSubagents?(): void;
  /**
   * Persist one resource toggle and return the item in its new state.
   *
   * The write belongs to the extension, not the panel: the sidebar only decides
   * what a row looks like, so keeping the settings and `mcp.json` edits on the
   * host side leaves the render path free of file I/O.
   */
  toggleResource?(item: ResourceItem): ResourceItem | undefined;
};

/** Kinds the Resources widget can list, in the order the rows appear. */
export const RESOURCE_KINDS: ResourceKind[] = ["extensions", "skills", "mcp", "tools"];

export function resourceKindLabel(kind: ResourceKind): string {
  if (kind === "extensions") return "extensions";
  if (kind === "skills") return "skills";
  if (kind === "mcp") return "MCPs";
  return "tools";
}

type ResourceWidget = {
  kind: ResourceKind;
  /** Index into the kind's item list, not into the visible window. */
  index: number;
  /** First visible item, kept in step with `index`. */
  offset: number;
};

/** How many item rows the widget can draw, given the rows it was budgeted. */
export function resourceListRows(resourcesHeight: number): number {
  // Heading, then the hint line when there is room for one, then items.
  if (resourcesHeight < 3) return Math.max(0, resourcesHeight - 1);
  return Math.max(0, resourcesHeight - 2);
}

export class Sidebar implements Component {
  private tui?: TUI;
  private theme?: Theme;
  private handle?: OverlayHandle;
  private overlayOptions?: OverlayOptions;
  private splitDispose?: () => void;
  private guideHandle?: OverlayHandle;
  private guideOptions?: OverlayOptions;
  private resizing = false;
  private resizeStartScreenX = 0;
  private resizeStartWidth = 0;
  private _preferredWidth?: number;
  hidden = false;
  private turnImpact: TurnImpactSnapshot = emptyTurnImpact();
  private contextData: SidebarContextData = { tokens: null, percent: null, tokensPerSec: 0, spend: 0 };
  private lastSlots = { summaryHeight: 0, dividerHeight: 0, filesHeight: 0, filesStart: 0, resourcesHeight: 0 };
  private mcpConnected: number | null = null;
  private skillsLoaded = 0;
  private extensionsLoaded = 0;
  private toolsRegistered = 0;
  private resourceCatalog: ResourceCatalog = { extensions: [], skills: [], mcp: [], tools: [] };
  private resourceWidget?: ResourceWidget;
  private childResources?: { tools?: readonly string[] };
  /** Screen row of each stat row and each listed item, for hit-testing clicks. */
  private resourceRows: { y: number; kind: ResourceKind; index: number }[] = [];
  private files: FileChange[] = [];
  private filesRev = 0;
  private filesOffset = 0;
  private subagents: SidebarSubagent[] = [];
  private subagentsOffset = 0;
  private subagentHeading = -1;
  private subagentRows: { y: number; id: string }[] = [];
  private subagentHeight = 0;
  private contentCached?: { key: string; lines: string[] };
  private dockCached?: { key: string; lines: string[] };
  private working = false;
  private spotlight = new SpotlightText(IDLE_VERBS[0]);
  /** Bright cell riding the box's border; advanced only while working. */
  private borderLight = new BorderLight();
  private verbIndex = 0;
  private idleVerbIndex = 0;
  private idleAnimates = true;
  private spotlightTimer?: ReturnType<typeof setTimeout>;
  private actions?: SidebarActions;
  splitActive = false;

  requireTheme(): Theme {
    if (!this.theme) throw new Error("sidebar is not attached");
    return this.theme;
  }

  /** Bind a pane inside a child workspace without mounting a second overlay/root. */
  bind(tui: TUI, theme: Theme): void {
    this.tui = tui;
    this.theme = theme;
  }

  attach(tui: TUI, theme: Theme): void {
    this.bind(tui, theme);
    if (this.hidden || this.splitDispose || this.handle) return;
    this.splitDispose = installSidebarSplit(tui, this, () => this.hidden ? SIDEBAR_HIDDEN : this._preferredWidth);
    this.splitActive = Boolean(this.splitDispose);
    this.contentCached = undefined;
    this.dockCached = undefined;
    // The box animates in both states, so a mounted panel arms the timer here
    // rather than waiting for the first turn.
    this.syncSpotlightTimer();
    if (this.splitActive) return;
    this.overlayOptions = {
      nonCapturing: true,
      anchor: "top-right",
      width: this.overlayWidth(tui.terminal.columns),
      minWidth: SIDEBAR_MIN_WIDTH,
      maxHeight: "100%",
      margin: { top: 0, right: 0, bottom: SIDEBAR_EDITOR_RESERVE, left: 0 },
      visible: (termWidth) => !this.hidden && termWidth >= SIDEBAR_MIN_TERMINAL_WIDTH,
    };
    this.handle = tui.showOverlay(this, this.overlayOptions);
  }

  get preferredWidth(): number | undefined {
    return this._preferredWidth;
  }

  setPreferredWidth(width: number | undefined): void {
    const next = width === undefined ? undefined : parseSidebarPercent(width);
    if (this._preferredWidth === next) return;
    this._preferredWidth = next;
    this.syncOverlayWidth();
    this.tui?.requestRender();
  }

  setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    const tui = this.tui;
    const theme = this.theme;
    if (!tui || !theme) return;
    this.unmountPane();
    if (!hidden) this.attach(tui, theme);
    // A hidden panel has no box to animate; a shown one arms the timer again.
    this.syncSpotlightTimer();
    tui.requestRender(true);
  }

  setActions(actions: SidebarActions): void {
    this.actions = actions;
  }

  setSubagents(children: SidebarSubagent[]): void {
    if (JSON.stringify(children) === JSON.stringify(this.subagents)) return;
    const anchor = this.subagents[this.subagentsOffset]?.id;
    this.subagents = children.map((child) => ({ ...child }));
    const offset = children.findIndex((child) => child.id === anchor);
    this.subagentsOffset = offset >= 0 ? offset : 0;
    this.contentCached = undefined;
    this.tui?.requestRender();
  }

  setTurnImpact(impact: TurnImpactSnapshot): void {
    if (this.turnImpact.revision === impact.revision) return;
    this.turnImpact = impact;
    this.contentCached = undefined;
    this.tui?.requestRender();
  }

  /**
   * Switch the box between the working and idle vocabularies.
   *
   * While a turn is in flight the spotlight cycles verbs and a bright light
   * rides the box's border; settled, the border goes dark and the idle
   * vocabulary still sweeps, so the box always has something to say. The
   * timer is armed here rather than in the render path, keeping its cost tied
   * to the panel being on screen.
   */
  setWorking(working: boolean): void {
    if (this.working === working) return;
    this.working = working;
    // A fresh lap begins with the turn, so the light starts from the same
    // corner every time rather than continuing wherever it stopped.
    if (working) this.borderLight.reset();
    // Swap vocabularies so a settle visibly changes the label instead of
    // restarting the same sweep, and a new turn does the same in reverse. The
    // first word of each list is used on entry, so a turn always opens on
    // "Working" and a settle always lands on "Idling".
    this.spotlight.restart(working
      ? WORKING_VERBS[this.verbIndex]
      : IDLE_VERBS[this.idleVerbIndex]);
    this.syncSpotlightTimer();
    this.tui?.requestRender();
  }

  /** Whether the idle vocabulary animates when the panel is mounted.
   *
   * The root panel animates whenever it is visible. Child panes render the
   * sidebar conditionally, so they turn this off when the pane is off screen
   * rather than leaving a timer running for a box nobody can see.
   */
  setIdleAnimating(animate: boolean): void {
    if (this.idleAnimates === animate) return;
    this.idleAnimates = animate;
    this.syncSpotlightTimer();
  }

  /**
   * Step the border light without waiting on the frame timer.
   *
   * The timer advances the light in real time, which is right for the TUI and
   * wrong for tests; this exposes the same mutation synchronously.
   */
  borderLightAdvanceForTest(steps = 1): void {
    for (let i = 0; i < steps; i++) this.borderLight.advance();
  }

  private syncSpotlightTimer(): void {
    // The border light is a working-state effect, so a settled panel only has
    // to keep sweeping its idle verb.
    const shouldRun = !this.hidden && (this.working || this.idleAnimates);
    if (!shouldRun) {
      if (this.spotlightTimer) clearTimeout(this.spotlightTimer);
      this.spotlightTimer = undefined;
      return;
    }
    if (this.spotlightTimer) return;
    this.spotlightTimer = setTimeout(() => this.tickSpotlight(), SPOTLIGHT_FRAME_MS);
    this.spotlightTimer.unref?.();
  }

  private tickSpotlight(): void {
    this.spotlightTimer = undefined;
    if (this.hidden) return;
    // The light rides the border only while a turn is in flight; a settled
    // box holds a still frame, so a glance tells busy from idle.
    if (this.working) this.borderLight.advance();
    this.spotlight.advance();
    // One sweep done: move to the next verb and start over, so the box keeps
    // changing what it says instead of looping one word.
    if (this.spotlight.finished) {
      if (this.working) {
        this.verbIndex = (this.verbIndex + 1) % WORKING_VERBS.length;
        this.spotlight.restart(WORKING_VERBS[this.verbIndex]);
      } else {
        this.idleVerbIndex = (this.idleVerbIndex + 1) % IDLE_VERBS.length;
        this.spotlight.restart(IDLE_VERBS[this.idleVerbIndex]);
      }
    }
    this.tui?.requestRender();
    this.spotlightTimer = setTimeout(() => this.tickSpotlight(), SPOTLIGHT_FRAME_MS);
    this.spotlightTimer.unref?.();
  }

  /** A child preview cannot toggle the root runtime or claim its resource counts. */
  setChildTools(tools?: readonly string[]): void {
    if (this.childResources && JSON.stringify(this.childResources.tools) === JSON.stringify(tools)) return;
    this.childResources = { tools };
    this.resourceWidget = undefined;
    this.contentCached = undefined;
    this.tui?.requestRender();
  }

  setContext(data: SidebarContextData): void {
    if (
      this.contextData.tokens === data.tokens &&
      this.contextData.percent === data.percent &&
      this.contextData.spend === data.spend &&
      Math.round(this.contextData.tokensPerSec) === Math.round(data.tokensPerSec) &&
      this.contextData.cacheHitRate === data.cacheHitRate
    ) {
      return;
    }
    this.contextData = data;
    this.dockCached = undefined;
    this.contentCached = undefined;
    this.tui?.requestRender();
  }

  setFiles(files: FileChange[]): void {
    if (sameFiles(this.files, files)) return;
    this.files = files;
    this.filesRev += 1;
    this.filesOffset = clampFilesOffset(
      this.filesOffset,
      files.length,
      Math.max(0, filesWidgetDesiredHeight(files.length) - 1),
    );
    this.contentCached = undefined;
    this.tui?.requestRender();
  }

  setMcpConnected(count: number | null): void {
    if (this.mcpConnected === count) return;
    this.mcpConnected = count;
    // Resources is rendered from the content lines, not the dock, so both
    // caches have to be dropped or the counts go stale.
    this.contentCached = undefined;
    this.dockCached = undefined;
    this.tui?.requestRender();
  }

  setSkillsLoaded(count: number): void {
    const next = Math.max(0, Math.round(count));
    if (this.skillsLoaded === next) return;
    this.skillsLoaded = next;
    this.contentCached = undefined;
    this.dockCached = undefined;
    this.tui?.requestRender();
  }

  /**
   * Replace the toggle widget's list. Called when it opens and after a toggle,
   * so the rows reflect what is actually on disk rather than an optimistic copy.
   *
   * The child pane re-supplies its catalog on every render, so an unchanged
   * list has to be a no-op: invalidating the cache unconditionally would ask for
   * another render from inside this one and never settle.
   */
  setResourceCatalog(catalog: ResourceCatalog): void {
    if (sameCatalog(this.resourceCatalog, catalog)) return;
    // Normalize once here, so every later read can assume all four kinds are
    // present even when the caller supplied a partial catalog.
    this.resourceCatalog = {
      extensions: catalog.extensions ?? [],
      skills: catalog.skills ?? [],
      mcp: catalog.mcp ?? [],
      tools: catalog.tools ?? [],
    };
    this.extensionsLoaded = this.resourceCatalog.extensions.length;
    this.skillsLoaded = this.resourceCatalog.skills.length;
    this.mcpConnected = this.resourceCatalog.mcp.length;
    this.toolsRegistered = this.resourceCatalog.tools.length;
    if (this.resourceWidget) {
      const list = this.resourceList(this.resourceWidget.kind);
      this.resourceWidget.index = Math.min(this.resourceWidget.index, Math.max(0, list.length - 1));
    }
    this.contentCached = undefined;
    this.dockCached = undefined;
    this.tui?.requestRender();
  }

  setExtensionsLoaded(count: number): void {
    const next = Math.max(0, Math.round(count));
    if (this.extensionsLoaded === next) return;
    this.extensionsLoaded = next;
    this.contentCached = undefined;
    this.tui?.requestRender();
  }

  setToolsRegistered(count: number): void {
    const next = Math.max(0, Math.round(count));
    if (this.toolsRegistered === next) return;
    this.toolsRegistered = next;
    this.contentCached = undefined;
    this.tui?.requestRender();
  }

  /** True while a Resources widget is open, so the panel can claim keys. */
  get resourceWidgetOpen(): boolean {
    return this.resourceWidget !== undefined;
  }

  openResourceWidget(kind: ResourceKind): void {
    const list = this.resourceList(kind);
    this.resourceWidget = { kind, index: Math.min(this.resourceWidget?.index ?? 0, Math.max(0, list.length - 1)), offset: 0 };
    this.contentCached = undefined;
    this.tui?.requestRender(true);
  }

  closeResourceWidget(): void {
    if (!this.resourceWidget) return;
    this.resourceWidget = undefined;
    this.contentCached = undefined;
    this.tui?.requestRender(true);
  }

  toggleResourceWidget(): void {
    if (this.resourceWidget) this.closeResourceWidget();
    else this.openResourceWidget("extensions");
  }

  /**
   * Handle a key while the widget is open. Returns true when it was consumed.
   *
   * The panel owns these keys only while a widget is open: Space and the arrows
   * belong to the editor otherwise, so the panel must not swallow them.
   */
  handleResourceKey(data: string): boolean {
    const widget = this.resourceWidget;
    if (!widget) return false;
    if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "return")) {
      this.closeResourceWidget();
      return true;
    }
    if (matchesKey(data, "left") || matchesKey(data, "right")) {
      const at = RESOURCE_KINDS.indexOf(widget.kind);
      const delta = matchesKey(data, "right") ? 1 : -1;
      const next = RESOURCE_KINDS[(at + delta + RESOURCE_KINDS.length) % RESOURCE_KINDS.length]!;
      widget.kind = next;
      widget.index = 0;
      widget.offset = 0;
      this.contentCached = undefined;
      this.tui?.requestRender(true);
      return true;
    }
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      const list = this.resourceList(widget.kind);
      if (list.length === 0) return true;
      const delta = matchesKey(data, "down") ? 1 : -1;
      widget.index = (widget.index + delta + list.length) % list.length;
      this.contentCached = undefined;
      this.tui?.requestRender();
      return true;
    }
    if (matchesKey(data, "space")) {
      this.toggleSelectedResource();
      return true;
    }
    return false;
  }

  /**
   * One kind's rows, tolerating a catalog that omits it.
   *
   * The child pane can supply a partial catalog, and the widget must render
   * something in that case rather than throwing from the render path.
   */
  private resourceList(kind: ResourceKind): ResourceItem[] {
    return this.resourceCatalog[kind] ?? [];
  }

  private toggleSelectedResource(): void {
    const widget = this.resourceWidget;
    if (!widget) return;
    const item = this.resourceList(widget.kind)[widget.index];
    if (!item) return;
    if (!item.toggleable) {
      this.tui?.requestRender();
      return;
    }
    const updated = this.actions?.toggleResource?.(item);
    if (!updated) return;
    const list = this.resourceList(widget.kind);
    list[widget.index] = updated;
    this.contentCached = undefined;
    this.tui?.requestRender();
  }

  handleSplitMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const sidebarWidth = this.displayedWidth(event.width);
    if (sidebarWidth <= 0) return undefined;
    const divider = event.width - sidebarWidth;
    return this.handleResizeMouse(event, event.x >= divider - 1 && event.x <= divider + 1);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const resize = this.handleResizeMouse(event, isSidebarResizeHandle(event));
    if (resize) return resize;

    if (event.type === "click" && event.button === "left") {
      const child = this.subagentRows.find((row) => row.y === event.y);
      if (child && this.actions?.viewSubagent) {
        this.actions.viewSubagent(child.id);
        return { handled: true };
      }
      // Only an occupied section opens the subagents view: with no jobs the
      // composer would open empty, which is what the editor's `hasJobs` gate
      // already prevents for the Down key.
      if (event.y === this.subagentHeading && this.subagents.length > 0 && this.actions?.openSubagents) {
        this.actions.openSubagents();
        return { handled: true };
      }
      const row = this.resourceRows.find((entry) => entry.y === event.y);
      if (row) {
        if (row.index < 0) {
          // A stat row: open (or close) that kind's widget.
          if (this.resourceWidget?.kind === row.kind) this.closeResourceWidget();
          else this.openResourceWidget(row.kind);
        } else {
          // An item row: select it, and toggle when it is already selected so a
          // second click does what Space would.
          const widget = this.resourceWidget;
          if (widget && widget.kind === row.kind && widget.index === row.index) this.toggleSelectedResource();
          else if (widget) {
            widget.index = row.index;
            this.contentCached = undefined;
            this.tui?.requestRender();
          }
        }
        return { handled: true };
      }
    }
    if (event.type === "wheel" && this.subagentRows.some((row) => row.y === event.y)) {
      const max = Math.max(0, this.subagents.length - this.subagentHeight);
      const next = Math.max(0, Math.min(max, this.subagentsOffset + Math.sign(event.wheelDelta ?? 0)));
      if (next !== this.subagentsOffset) {
        this.subagentsOffset = next;
        this.contentCached = undefined;
        this.tui?.requestRender();
      }
      return { handled: true };
    }

    // The Resources widget scrolls like the file list, but moves its selection
    // so the highlighted row stays on screen.
    if (event.type === "wheel" && this.resourceRows.some((row) => row.y === event.y)) {
      const widget = this.resourceWidget;
      const list = widget ? this.resourceList(widget.kind) : [];
      if (!widget || list.length === 0) return { handled: true };
      const delta = Math.sign(event.wheelDelta ?? 0);
      widget.index = Math.max(0, Math.min(list.length - 1, widget.index + delta));
      this.contentCached = undefined;
      this.tui?.requestRender();
      return { handled: true };
    }

    // Last Turn is read-only: its rows report statistics, so there is nothing
    // to expand, copy, or open. The file list keeps its wheel scroll because a
    // list longer than its pane still has to be navigable.
    const { filesStart, filesHeight } = this.lastSlots;
    if (event.type === "wheel" && event.y >= filesStart && event.y < filesStart + filesHeight) {
      if (!this.scrollFiles(-(event.wheelDelta ?? 0))) return undefined;
      return { handled: true };
    }
    return undefined;
  }

  invalidate(): void {
    this.contentCached = undefined;
    this.dockCached = undefined;
  }

  render(width: number, height = Math.max(1, this.tui?.terminal.rows ?? 1), dockWant = this.splitActive ? Math.max(COMPOSER_SHELF_LINES, composerFrameLineCount()) : SIDEBAR_DOCK_LINES): string[] {
    this.syncOverlayWidth();
    const theme = this.theme;
    const { contentHeight, dockHeight } = sidebarRowSlots(height, dockWant);
    // Context now renders in the content block, so its facts belong in that
    // key. The dock tracks its geometry and working animation separately.
    const contentKey = `${width}x${contentHeight}:${this.filesRev}:${this.filesOffset}:${this.turnImpact.revision}:${this.skillsLoaded}:${this.mcpConnected}:${this.extensionsLoaded}:${this.toolsRegistered}:${this.resourceWidget ? `${this.resourceWidget.kind}:${this.resourceWidget.index}:${this.resourceWidget.offset}` : "-"}:${JSON.stringify(this.resourceCatalog)}:${this.contextData.tokens}:${this.contextData.percent}:${this.contextData.spend}:${Math.round(this.contextData.tokensPerSec)}:${this.contextData.cacheHitRate}:${JSON.stringify(this.subagents)}:${this.subagentsOffset}`;
    // The box animates while working — spotlight sweeps plus a light riding
    // the border — so the frame belongs in the key; a settled box only moves
    // through its idle sweep, which the spotlight's own frame already tracks.
    const dockKey = `${width}x${dockHeight}:${this.spotlight.frameIndex}:${this.working ? `w${this.borderLight.step}:${this.verbIndex}` : `i${this.idleVerbIndex}`}`;
    const content = this.contentCached?.key === contentKey
      ? this.contentCached.lines
      : this.contentLines(width, contentHeight, theme);
    const dock = this.dockCached?.key === dockKey
      ? this.dockCached.lines
      : this.dockLines(width, dockHeight, theme);
    this.contentCached = { key: contentKey, lines: content };
    this.dockCached = { key: dockKey, lines: dock };
    return [...content, ...dock].slice(0, height);
  }

  private unmountPane(): void {
    this.splitDispose?.();
    this.splitDispose = undefined;
    this.splitActive = false;
    this.handle?.hide();
    this.handle = undefined;
    this.overlayOptions = undefined;
  }

  dispose(): void {
    this.hideResizeGuide();
    this.resizing = false;
    this.unmountPane();
    this.working = false;
    if (this.spotlightTimer) clearTimeout(this.spotlightTimer);
    this.spotlightTimer = undefined;
    this.files = [];
    this.filesRev = 0;
    this.filesOffset = 0;
    this.subagents = [];
    this.subagentsOffset = 0;
    this.subagentHeading = -1;
    this.subagentRows = [];
    this.contentCached = undefined;
    this.dockCached = undefined;
    this.lastSlots = { summaryHeight: 0, dividerHeight: 0, filesHeight: 0, filesStart: 0, resourcesHeight: 0 };
    this.tui = undefined;
    this.theme = undefined;
  }

  /**
   * The box below the sections.
   *
   * Holds fitted lettering in both states: the working vocabulary while a turn
   * is in flight, and the idle vocabulary once it settles. While working, a
   * bright light rides the border clockwise; settled, the frame is drawn in
   * its ordinary chrome tone and stands still. The frame is drawn either way
   * so the space stays reserved at the bottom of the panel, and the label
   * never goes blank.
   */
  private dockLines(width: number, height: number, theme: Theme | undefined): string[] {
    if (height < 1) return [];
    const paint = this.paint(theme);
    if (height === 1) return [inscribedTitle("", width, paint, "mid")];

    // Fit centred dot-matrix text inside symmetric one-cell margins. Its
    // aspect ratio is preserved, rather than stretching short words across
    // the frame. Measure the interior so neither glyphs nor borders overflow.
    const interior = height - 2;
    const art = this.spotlight.renderBox(Math.max(0, width - 4), interior, theme);

    // The light's position is a counterclockwise offset from the bottom-right
    // corner, so every row can map itself onto the loop without the geometry
    // living in more than one place. There is no head while idle: no light.
    const head = this.working ? this.borderLight.cellFromEnd(borderPerimeter(width, interior)) : 0;
    const lines = [this.frameLine(width, interior, "top", head, paint, theme)];
    for (let row = 0; row < interior; row++) {
      lines.push(this.dockBodyRow(row, width, interior, art, head, paint, theme));
    }
    lines.push(this.frameLine(width, interior, "bottom", head, paint, theme));
    return lines.slice(0, height);
  }

  /**
   * The box's top or bottom rule, with the light applied to the corners and
   * the run between them while it works.
   */
  private frameLine(
    width: number,
    interior: number,
    kind: "top" | "bottom",
    head: number,
    paint: (text: string) => string,
    theme: Theme | undefined,
  ): string {
    if (width <= 0) return "";
    if (width === 1) return paint(kind === "top" ? "╭" : "╰");
    if (width === 2) return paint(kind === "top" ? "╭╮" : "╰╯");
    const perimeter = borderPerimeter(width, interior);
    const at = (cell: number, glyph: string): string => {
      if (!theme || !this.working) return paint(glyph);
      return borderLightGlyph((head - cell + perimeter) % perimeter, theme, glyph);
    };
    // Cells count counterclockwise from the bottom-right corner, so the top
    // rule runs left to right from the top-left corner while the bottom rule
    // runs right to left from the bottom-right one.
    const ruleCell = (col: number): number => (kind === "top" ? width + interior + col : width - 1 - col);
    const openCell = kind === "top" ? width + interior : width - 1;
    const closeCell = kind === "top" ? 2 * width + interior - 1 : 0;
    let run = "";
    for (let col = 1; col <= width - 2; col++) run += at(ruleCell(col), "─");
    return `${at(openCell, kind === "top" ? "╭" : "╰")}${run}${at(closeCell, kind === "top" ? "╮" : "╯")}`;
  }

  /**
   * One body row: the fitted lettering between borders, with the light
   * applied to the side borders while it works.
   */
  private dockBodyRow(
    row: number,
    width: number,
    interior: number,
    art: string[],
    head: number,
    paint: (text: string) => string,
    theme: Theme | undefined,
  ): string {
    if (width <= 0) return "";
    if (width === 1) return paint("│");
    const perimeter = borderPerimeter(width, interior);
    const at = (cell: number): string => {
      if (!theme || !this.working) return paint("│");
      return borderLightGlyph((head - cell + perimeter) % perimeter, theme, "│");
    };
    // The left side runs bottom to top from the bottom-left corner; the right
    // side runs top to bottom from the top-right one.
    const leftCell = width + interior - 1 - row;
    const rightCell = 2 * width + interior + row;
    const body = frameRowBody(art[row] ? ` ${art[row]} ` : "", width);
    return `${at(leftCell)}${body}${at(rightCell)}`;
  }

  private contentLines(width: number, height: number, theme: Theme | undefined): string[] {
    this.subagentHeading = -1;
    this.subagentRows = [];
    this.subagentHeight = 0;
    this.resourceRows = [];
    if (height < 1) {
      this.lastSlots = { summaryHeight: 0, dividerHeight: 0, filesHeight: 0, filesStart: 0, resourcesHeight: 0 };
      return [];
    }
    // One row is reserved for the block's bottom border, so the sections are
    // budgeted against the rest and the border is always drawn.
    const impactLines = hasTurnImpact(this.turnImpact) ? formatTurnImpact(this.turnImpact).length : 0;
    const widgetList = this.resourceWidget ? this.resourceList(this.resourceWidget.kind).length : 0;
    const slots = splitSidebarContent(
      Math.max(0, height - 1),
      filesWidgetDesiredHeight(this.files.length),
      // Always asked for: the section is a permanent part of the panel, and its
      // own floor covers the empty case, so an absent family still renders.
      subagentsSectionDesiredHeight(this.subagents.length),
      impactLines,
      this.resourceWidget ? resourcesWidgetDesiredHeight(widgetList) : 0,
    );
    this.lastSlots = { ...slots, filesStart: 0 };
    const lines: string[] = [...this.summaryLines(width, slots.summaryHeight, slots.filesHeight, theme)];
    this.pushRule(lines, slots.dividerHeight, width, theme);
    // Resources sits below Summary, with its own divider, so the skill and MCP
    // counts read as a separate block.
    lines.push(...this.resourcesLines(width, slots.resourcesHeight, lines.length, theme));
    // Context follows Resources, behind a rule of its own so the stats are not
    // read as part of the resource counts.
    this.pushRule(lines, slots.contextDividerHeight, width, theme);
    lines.push(...this.contextLines(width, slots.contextHeight, theme));
    this.pushRule(lines, slots.subagentsDividerHeight, width, theme);
    if (slots.subagentsHeight > 0) {
      this.subagentHeading = lines.length;
      lines.push(...this.subagentLines(width, slots.subagentsHeight, lines.length, theme));
    }
    // The pane that used to absorb the leftover rows is gone, so they stay blank
    // and this block has to close itself: the bottom border is the last line,
    // sitting directly above the empty dock.
    while (lines.length < height - 1) lines.push(this.decorateLine("", width, theme));
    lines.push(inscribedTitle("", width, this.paint(theme), "bottom"));
    return lines.slice(0, height);
  }

  /**
   * `Context` heading and its per-request facts.
   *
   * Facts are grouped by topic and each group gets its own line, matching Last
   * Turn: the token count and its percentage read together, then the cache hit,
   * then spend. The token rate joins spend on the same line, and both the cache
   * hit and the rate are omitted entirely until they have a value rather than
   * printing a placeholder.
   */
  private contextLines(width: number, height: number, theme: Theme | undefined): string[] {
    if (height < 1) return [];
    const lines: string[] = [this.heading("Context", width, theme)];
    const facts = [
      formatContextUsage(this.contextData.tokens, this.contextData.percent),
      formatCacheHit(this.contextData.cacheHitRate),
      this.spendLine(),
    ].filter((fact): fact is string => Boolean(fact));
    for (const fact of facts) {
      if (lines.length >= height) break;
      lines.push(this.body(`  ${fact}`, width, theme, "dim"));
    }
    return lines.slice(0, height);
  }

  private subagentLines(width: number, height: number, start: number, theme: Theme | undefined): string[] {
    const running = this.subagents.filter((child) => child.status === "running").length;
    const lines = [this.heading(`Subagents · ${running} running`, width, theme)];
    this.subagentHeight = Math.max(0, height - 1);
    this.subagentsOffset = Math.min(this.subagentsOffset, Math.max(0, this.subagents.length - this.subagentHeight));
    // The section is permanent, so the empty case says so rather than leaving a
    // heading with nothing under it. It reads like the file list's own "none".
    if (this.subagents.length === 0) {
      if (lines.length < height) lines.push(this.body("  none", width, theme, "dim"));
      return lines;
    }
    const icons = { running: "●", completed: "✓", error: "✗", cancelled: "■" };
    const tones = { running: "accent", completed: "success", error: "error", cancelled: "dim" } as const;
    for (const child of this.subagents.slice(this.subagentsOffset, this.subagentsOffset + this.subagentHeight)) {
      const clean = (text: string) => stripTerminalSequences(text).replace(/[\x00-\x1f\x7f]/g, " ");
      const icon = theme ? theme.fg(tones[child.status], icons[child.status]) : icons[child.status];
      const label = `${clean(child.prefix ?? "")}${clean(child.agent)}: ${clean(child.title)}`;
      const text = theme ? theme.fg(child.current ? "accent" : "muted", label) : label;
      this.subagentRows.push({ y: start + lines.length, id: child.id });
      lines.push(this.decorateLine(` ${icon} ${text}`, width, theme));
    }
    return lines;
  }

  /** `$0.03 · 1,234 tokens/sec`, or just the spend when no rate is known yet. */
  private spendLine(): string {
    const spend = formatSpend(this.contextData.spend);
    const rate = this.contextData.tokensPerSec > 0 ? formatTokenRate(this.contextData.tokensPerSec) : "";
    return rate ? `${spend} · ${rate}` : spend;
  }

  /**
   * `Resources` heading, the three stat rows, and — while open — the toggle
   * widget for one kind.
   *
   * Each stat row is a click target that opens its kind's widget. The rows are
   * also the only place the counts live, so the widget replaces the counts
   * rather than being drawn beside them: the section keeps one list of rows and
   * never has to fit both.
   */
  private resourcesLines(width: number, height: number, start: number, theme: Theme | undefined): string[] {
    if (height < 1) return [];
    if (this.childResources) {
      const facts = [this.heading("Resources · child", width, theme),
        this.body(`  ${this.childResources.tools ? `${this.childResources.tools.length} tools` : "tools unknown"}`, width, theme, "dim"),
        this.body("  read-only preview", width, theme, "dim")];
      return facts.slice(0, height);
    }
    const widget = this.resourceWidget;
    const heading = widget ? `Resources · ${resourceKindLabel(widget.kind)}` : "Resources";
    const lines: string[] = [this.heading(heading, width, theme)];

    if (!widget) {
      // The counts stack vertically, indented under the heading so they align
      // with the Context and Last Turn facts rather than sitting flush left.
      const counts = formatResourceLines(this.skillsLoaded, this.mcpConnected, this.extensionsLoaded, this.toolsRegistered);
      const kinds: ResourceKind[] = RESOURCE_KINDS;
      counts.forEach((count, index) => {
        if (lines.length >= height) return;
        const kind = kinds[index]!;
        this.resourceRows.push({ y: start + lines.length, kind, index: -1 });
        lines.push(this.body(`  ${count}`, width, theme, "dim"));
      });
      return lines.slice(0, height);
    }

    const list = this.resourceList(widget.kind);
    const rows = resourceListRows(height);
    // Keep the selected row inside the visible window, the same way the file
    // list clamps its offset.
    widget.offset = Math.max(0, Math.min(widget.offset, Math.max(0, list.length - rows)));
    if (widget.index < widget.offset) widget.offset = widget.index;
    if (widget.index >= widget.offset + rows) widget.offset = widget.index - rows + 1;
    const visible = list.slice(widget.offset, widget.offset + rows);
    if (visible.length === 0) {
      lines.push(this.body("  none", width, theme, "dim"));
    }
    for (let i = 0; i < visible.length; i++) {
      if (lines.length >= height) break;
      const item = visible[i]!;
      const index = widget.offset + i;
      this.resourceRows.push({ y: start + lines.length, kind: widget.kind, index });
      lines.push(this.resourceItemLine(item, index === widget.index, width, theme));
    }
    if (lines.length < height) {
      lines.push(this.body("  space toggle · ←→ kind", width, theme, "dim"));
    }
    return lines.slice(0, height);
  }

  /** One `[x] name  origin` row; the selected row is drawn in the accent tone. */
  private resourceItemLine(item: ResourceItem, selected: boolean, width: number, theme: Theme | undefined): string {
    const mark = item.enabled ? "[x]" : "[ ]";
    const suffix = item.lockedReason ? item.lockedReason : item.origin;
    const label = `${mark} ${item.name}`;
    if (!theme) return this.decorateLine(` ${label}  ${suffix}`, width, theme);
    const painted = item.enabled ? theme.fg("success", mark) : theme.fg("dim", mark);
    const name = theme.fg(selected ? "accent" : "muted", item.name);
    const tail = theme.fg("dim", `  ${suffix}`);
    const cursor = selected ? theme.fg("accent", "›") : " ";
    return this.decorateLine(`${cursor} ${painted} ${name}${tail}`, width, theme);
  }

  private summaryLines(width: number, height: number, filesHeight: number, theme: Theme | undefined): string[] {
    if (height < 1) return [];
    const files = this.filesLines(width, filesHeight, theme);
    // Last Turn is a read-only readout now, so it is rendered in one dim tone.
    // The brighter "muted" tone it used to carry was an affordance: it marked
    // rows as clickable, which they no longer are.
    //
    // With no activity the section is omitted entirely rather than shown as a
    // "No tool activity" placeholder, so the rule below lands directly under
    // Files Changed instead of below a heading that reports nothing. The budget
    // in `splitSidebarContent` is sized from the same condition, so the two
    // cannot disagree about how tall this block is.
    const impact = hasTurnImpact(this.turnImpact)
      ? formatTurnImpact(this.turnImpact).map((line) => this.body(`  ${line}`, width, theme, "dim"))
      : [];
    // The title sits mid-rule, level with the panel, instead of flush left.
    const lines = [inscribedTitle(this.titled("Summary", theme), width, this.paint(theme), "top", "", true)];
    if (lines.length < height) lines.push(this.decorateLine("", width, theme));
    this.lastSlots = { ...this.lastSlots, filesStart: lines.length };
    lines.push(...files);
    if (impact.length > 0) {
      if (lines.length < height) lines.push(this.decorateLine("", width, theme));
      if (lines.length < height) lines.push(this.heading("Last Turn", width, theme));
      for (const line of impact) {
        if (lines.length >= height) break;
        lines.push(line);
      }
    }
    return this.padBlock(lines, height, width, theme);
  }

  private filesLines(width: number, maxHeight: number, theme: Theme | undefined): string[] {
    if (maxHeight < 1) return [];
    const panel = filesPanel(this.files, maxHeight, this.filesOffset);
    this.filesOffset = panel.offset;
    return panel.lines.map((line) => {
      if (line.type === "heading") {
        const label = line.count > 0 ? `Files Changed · ${line.count}` : "Files Changed";
        return this.heading(label, width, theme);
      }
      if (line.type === "empty") return this.body("  none", width, theme, "dim");
      const mark = fileMark(line.item);
      const label = formatFileLabel(line.item);
      const text = `  ${mark.mark} ${label}`;
      if (!theme) return this.decorateLine(text, width, theme);
      return this.decorateLine(`  ${theme.fg(mark.tone, mark.mark)} ${theme.fg("muted", label)}`, width, theme);
    });
  }

  private scrollFiles(delta: number): boolean {
    if (delta === 0 || this.files.length === 0) return false;
    const bodyHeight = Math.max(0, this.lastSlots.filesHeight - (this.lastSlots.filesHeight > 1 ? 1 : 0));
    const next = clampFilesOffset(this.filesOffset + delta, this.files.length, bodyHeight);
    if (next === this.filesOffset) return false;
    this.filesOffset = next;
    this.contentCached = undefined;
    this.tui?.requestRender();
    return true;
  }

  private pushRule(lines: string[], height: number, width: number, theme: Theme | undefined): void {
    if (height < 1) return;
    lines.push(theme ? this.rule(width, theme) : frameRow("─".repeat(Math.max(0, width - 2)), width, (text) => text));
  }

  private padBlock(block: string[], height: number, width: number, theme: Theme | undefined): string[] {
    const lines = block.slice(0, height);
    while (lines.length < height) lines.push(this.decorateLine("", width, theme));
    return lines;
  }

  private titled(label: string, theme: Theme | undefined): string {
    return theme ? theme.fg("mdHeading", label) : label;
  }

  private heading(label: string, width: number, theme: Theme | undefined): string {
    return this.decorateLine(this.titled(label, theme), width, theme);
  }

  private body(text: string, width: number, theme: Theme | undefined, color: "muted" | "dim"): string {
    if (!theme) return this.decorateLine(text, width, theme);
    return this.decorateLine(theme.fg(color, text), width, theme);
  }

  private paint(theme: Theme | undefined): (text: string) => string {
    return theme ? chromePaint(theme) : (text) => text;
  }

  private rule(width: number, theme: Theme): string {
    // Section dividers sit quieter than the box chrome: the muted border tone
    // separates the sections without competing with the frame or the titles.
    const paint = theme
      ? (text: string) => theme.fg("borderMuted", text)
      : (text: string) => text;
    return inscribedTitle("", width, paint, "mid");
  }

  private handleResizeMouse(event: TuiMouseEvent, onHandle: boolean): TuiMouseEventResult | undefined {
    if (this.resizing) {
      if (event.type === "drag" || event.type === "move") return this.moveResizeGuide(event.screenX);
      if (event.type === "release") {
        this.commitResize(event.screenX);
        return { handled: true, render: true };
      }
      if (event.type === "click") return { handled: true };
    }
    if (onHandle && event.type === "press" && event.button === "left") {
      this.beginResize(event.screenX);
      return { handled: true, capture: true, render: true };
    }
    if (onHandle && event.type === "click" && event.button === "left") return { handled: true };
    return undefined;
  }

  private displayedWidth(totalWidth = this.tui?.terminal.columns ?? 0): number {
    return workspaceColumnWidth(totalWidth, this.hidden ? SIDEBAR_HIDDEN : this._preferredWidth);
  }

  private overlayWidth(totalWidth: number): OverlayOptions["width"] {
    const width = this.displayedWidth(totalWidth);
    return width || (this.hidden ? 0 : "20%");
  }

  private syncOverlayWidth(): void {
    if (!this.overlayOptions || !this.tui) return;
    const width = this.overlayWidth(this.tui.terminal.columns);
    if (this.overlayOptions.width !== width) this.overlayOptions.width = width;
  }

  private beginResize(screenX: number): void {
    this.resizing = true;
    this.resizeStartScreenX = screenX;
    this.resizeStartWidth = this.displayedWidth();
    this.showResizeGuide(screenX);
  }

  private moveResizeGuide(screenX: number): TuiMouseEventResult {
    if (!this.guideOptions) {
      this.showResizeGuide(screenX);
      return { handled: true, render: true };
    }
    const col = this.guideColumn(screenX);
    if (this.guideOptions.col === col) return { handled: true, render: false };
    this.guideOptions.col = col;
    return { handled: true, render: true };
  }

  private commitResize(screenX: number): void {
    const next = this.widthFromPointer(screenX);
    this.hideResizeGuide();
    this.resizing = false;
    if (next === this.resizeStartWidth || next <= 0) return;
    const percent = sidebarPercentFromColumns(this.tui?.terminal.columns ?? 0, next);
    this.setPreferredWidth(percent);
    this.actions?.persistWidth?.(percent);
  }

  private showResizeGuide(screenX: number): void {
    if (!this.tui) return;
    const col = this.guideColumn(screenX);
    if (this.guideOptions && this.guideHandle) {
      this.guideOptions.col = col;
      return;
    }
    this.guideOptions = {
      nonCapturing: true,
      width: 1,
      minWidth: 1,
      col,
      row: 0,
      maxHeight: "100%",
    };
    this.guideHandle = this.tui.showOverlay(
      new ResizeGuide(() => this.tui?.terminal.rows ?? 1, this.theme),
      this.guideOptions,
    );
  }

  private hideResizeGuide(): void {
    this.guideHandle?.hide();
    this.guideHandle = undefined;
    this.guideOptions = undefined;
  }

  private widthFromPointer(screenX: number): number {
    const total = this.tui?.terminal.columns ?? 0;
    return clampSidebarColumns(
      total,
      this.resizeStartWidth + this.resizeStartScreenX - screenX,
    );
  }

  private guideColumn(screenX: number): number {
    const total = this.tui?.terminal.columns ?? 0;
    return sidebarHandleColumn(total, this.widthFromPointer(screenX));
  }

  private decorateLine(line: string, width: number, theme: Theme | undefined): string {
    const inner = Math.max(0, width - 2);
    const body = line.length === 0 ? "" : truncateToWidth(` ${line}`, inner);
    return frameRow(body, width, this.paint(theme));
  }
}

class ResizeGuide implements Component {
  private readonly rows: () => number;
  private readonly theme?: Theme;

  constructor(rows: () => number, theme?: Theme) {
    this.rows = rows;
    this.theme = theme;
  }

  invalidate(): void {}

  render(_width: number): string[] {
    const mark = this.theme ? this.theme.fg("accent", "│") : "│";
    return Array.from({ length: Math.max(1, this.rows()) }, () => mark);
  }
}

function emptyTurnImpact(): TurnImpactSnapshot {
  return { revision: 0, toolsCalled: 0, events: [] };
}

/**
 * Border cells of a `width × height` box that traverses one cell per frame,
 * corners included. `height` is the box's full row count, so its interior is
 * `height - 2`; the head offset from `BorderLight` wraps at this perimeter.
 */
function borderPerimeter(width: number, interior: number): number {
  return Math.max(4, 2 * width + 2 * interior);
}

/**
 * Structural comparison for the catalog. The child pane hands in a fresh object
 * every render, so identity is never enough to decide whether to invalidate.
 * Missing kinds are tolerated so a caller that supplies a partial catalog does
 * not throw from the render path.
 */
function sameCatalog(left: ResourceCatalog, right: ResourceCatalog): boolean {
  return RESOURCE_KINDS.every((kind) => {
    const a = left[kind] ?? [];
    const b = right[kind] ?? [];
    return a.length === b.length && a.every((item, index) => {
      const other = b[index];
      return other !== undefined
        && item.id === other.id
        && item.enabled === other.enabled
        && item.name === other.name
        && item.origin === other.origin
        && item.toggleable === other.toggleable;
    });
  });
}
