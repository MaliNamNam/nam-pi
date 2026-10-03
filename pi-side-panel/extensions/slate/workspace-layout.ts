export const SIDEBAR_DOCK_LINES = 4;
export const FILES_WIDGET_MAX_LINES = 5;
/**
 * Heading plus one line per resource kind (extensions, skills, MCPs, tools).
 * The counts stack vertically, so four facts are needed.
 */
export const RESOURCES_SECTION_LINES = 5;
/**
 * Last Turn's widest case: one line per activity category (inspected, edited,
 * ran, delegated). The budget has to cover all four or the last one is clipped.
 */
export const IMPACT_MAX_LINES = 4;
/**
 * Context's widest case: the heading plus four facts (tokens and percent, cache
 * hit, spend, token rate). The cache hit and the rate are omitted until they
 * have values, so this is a ceiling rather than a fixed height.
 */
export const CONTEXT_SECTION_LINES = 5;
/**
 * Subagents' floor: the heading plus one body row. The section is always on
 * screen, so an empty family still has a row to say it is empty on.
 */
export const SUBAGENTS_SECTION_MIN_LINES = 2;
/**
 * Rows the child list may use. A large family scrolls rather than pushing the
 * sections above it off the panel.
 */
export const SUBAGENTS_WIDGET_MAX_LINES = 5;

export function sidebarRowSlots(
  height: number,
  dockLines = SIDEBAR_DOCK_LINES,
): {
  contentHeight: number;
  dockHeight: number;
} {
  const paneHeight = Math.max(0, Math.floor(height));
  const dockHeight = Math.min(Math.max(0, dockLines), paneHeight);
  return {
    contentHeight: paneHeight - dockHeight,
    dockHeight,
  };
}

export function filesWidgetDesiredHeight(fileCount: number): number {
  if (fileCount <= 0) return 2;
  return Math.min(FILES_WIDGET_MAX_LINES, 1 + fileCount);
}

/**
 * The Summary block's natural height: the top border, the files widget, and
 * Last Turn only when it has facts to report.
 *
 * Sizing to the content rather than to Last Turn's worst case is what keeps the
 * divider below the section from drifting downwards: with no turn activity the
 * block is just its border, files, and a blank row, so the rule lands directly
 * under Files Changed instead of leaving a gap the stats never fill.
 */
export function summaryNaturalHeight(filesDesired: number, impactLines = 0): number {
  const filesWant = Math.max(0, Math.min(FILES_WIDGET_MAX_LINES, Math.floor(filesDesired)));
  const impact = Math.max(0, Math.min(IMPACT_MAX_LINES, Math.floor(impactLines)));
  const base = 2 + filesWant;
  return impact > 0 ? base + 2 + impact : base;
}

/**
 * Rows the Subagents section wants: its heading, plus one row per child, plus a
 * floor of one body row so the section never collapses to a bare heading.
 */
export function subagentsSectionDesiredHeight(childCount: number): number {
  const rows = Math.min(SUBAGENTS_WIDGET_MAX_LINES, Math.max(1, Math.floor(childCount)));
  return 1 + rows;
}

/**
 * Rows the Resources widget wants when open: the heading, one row per item, and
 * the hint line. Zero means the section is closed and wants only its base rows.
 */
export function resourcesWidgetDesiredHeight(itemCount: number): number {
  return 1 + Math.max(0, Math.floor(itemCount)) + 1;
}

export function splitSidebarContent(
  height: number,
  filesDesired: number,
  subagentsDesired = 0,
  impactLines = 0,
  resourcesDesired = 0,
): {
  summaryHeight: number;
  filesHeight: number;
  dividerHeight: number;
  resourcesHeight: number;
  contextDividerHeight: number;
  contextHeight: number;
  subagentsDividerHeight: number;
  subagentsHeight: number;
} {
  const slotHeight = Math.max(0, Math.floor(height));
  const filesWant = Math.max(0, Math.min(FILES_WIDGET_MAX_LINES, Math.floor(filesDesired)));
  const impact = Math.max(0, Math.min(IMPACT_MAX_LINES, Math.floor(impactLines)));
  const empty = {
    summaryHeight: 0,
    filesHeight: 0,
    dividerHeight: 0,
    resourcesHeight: 0,
    contextDividerHeight: 0,
    contextHeight: 0,
    subagentsDividerHeight: 0,
    subagentsHeight: 0,
  };
  if (slotHeight <= 2) return empty;

  // Context is the section worth keeping, so it takes its rows first, along with
  // the rule that separates it from the sections above.
  const contextHeight = Math.min(CONTEXT_SECTION_LINES, Math.max(0, slotHeight - 1));
  const contextDividerHeight = contextHeight > 0 ? 1 : 0;
  const afterContext = Math.max(0, slotHeight - contextHeight - contextDividerHeight);
  // Subagents sits directly below Context and is always on screen, so its floor
  // is reserved the same way Context's is. Only a panel too short to hold the
  // heading and one row drops it, and then Context is all that is left.
  const subagentsHeight = subagentsDesired >= SUBAGENTS_SECTION_MIN_LINES && afterContext >= SUBAGENTS_SECTION_MIN_LINES + 1
    ? Math.min(Math.max(0, Math.floor(subagentsDesired)), afterContext - 1) : 0;
  const subagentsDividerHeight = subagentsHeight > 0 ? 1 : 0;
  const remaining = Math.max(0, afterContext - subagentsHeight - subagentsDividerHeight);

  // Summary takes exactly what its content needs, so the rule under it tracks
  // the last stat instead of a fixed budget. Resources is still reserved its
  // base rows first, or a long Summary would starve the counts.
  const summaryWant = summaryNaturalHeight(filesWant, impact);
  const summaryHeight = Math.min(summaryWant, Math.max(0, remaining - RESOURCES_SECTION_LINES - 1));
  const dividerHeight = summaryHeight > 0 ? 1 : 0;
  // An open Resources widget is what the freed rows are for, so it takes its
  // full list when the other sections left room, and the base rows otherwise.
  const resourcesWant = Math.max(RESOURCES_SECTION_LINES, Math.floor(resourcesDesired));
  const resourcesHeight = Math.min(
    resourcesWant,
    Math.max(0, remaining - summaryHeight - dividerHeight),
  );
  const filesHeight = Math.min(filesWant, Math.max(0, summaryHeight - 2));
  return {
    summaryHeight,
    filesHeight,
    dividerHeight,
    resourcesHeight,
    // A divider with nothing above it would draw a stray rule at the top.
    contextDividerHeight: summaryHeight > 0 || resourcesHeight > 0 ? contextDividerHeight : 0,
    contextHeight,
    subagentsDividerHeight,
    subagentsHeight,
  };
}

export function workspacePaneSlots(height: number): number {
  const paneHeight = Math.max(0, Math.floor(height));
  return paneHeight <= 1 ? paneHeight : paneHeight - 1;
}

export function fitImageCells(
  imageWidthPx: number,
  imageHeightPx: number,
  maxCols: number,
  maxRows: number,
  cellWidthPx = 9,
  cellHeightPx = 18,
): { columns: number; rows: number } {
  const maxWidth = Math.max(0, Math.floor(maxCols));
  const maxHeight = Math.max(0, Math.floor(maxRows));
  if (maxWidth < 1 || maxHeight < 1) return { columns: 0, rows: 0 };
  const widthPx = Math.max(1, imageWidthPx);
  const heightPx = Math.max(1, imageHeightPx);
  const cellW = Math.max(1, cellWidthPx);
  const cellH = Math.max(1, cellHeightPx);
  const scale = Math.min(1, (maxWidth * cellW) / widthPx, (maxHeight * cellH) / heightPx);
  return {
    columns: Math.max(1, Math.min(maxWidth, Math.ceil((widthPx * scale) / cellW))),
    rows: Math.max(1, Math.min(maxHeight, Math.ceil((heightPx * scale) / cellH))),
  };
}

export function placeWorkspaceImage(
  paneHeight: number,
  imageRows: number,
  captionLines: string[],
): { lines: string[]; imageStart: number; imageRows: number; captionStart: number } {
  const pane = Math.max(0, Math.floor(paneHeight));
  const captions = captionLines.slice(0, pane);
  const topPad = pane > 1 ? 1 : 0;
  const usedImageRows = Math.min(Math.max(0, imageRows), Math.max(0, pane - topPad - captions.length));
  const imageStart = topPad;
  const captionStart = imageStart + usedImageRows;
  const lines = Array.from({ length: pane }, () => "");
  for (let i = 0; i < captions.length; i++) {
    lines[captionStart + i] = captions[i] ?? "";
  }
  return { lines, imageStart, imageRows: usedImageRows, captionStart };
}
