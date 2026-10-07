/**
 * macOS Terminal Frame
 * ----------------------------------------------------------------------------
 * Renders pi's tool calls inside a window that mimics the
 * macOS Terminal.app look: a title bar with red/yellow/green traffic lights and
 * a rounded box-drawing frame around the command and its output.
 *
 * The title bar shows the tool the "terminal" is for (`write`, `grep`, `find`,
 * `ls`) with the target path/pattern right-aligned, and the command is drawn
 * after a shell prompt in the body.
 *
 * read and edit are deliberately NOT re-registered here. pi-hashline-edit-pro
 * registers its own anchored `read`, and pi fails the extension load on
 * duplicate tool names between extensions; re-registering built-in `edit`
 * would also resurrect the fuzzy-match edit tool that hashline disables by
 * design. Tools without a specialized renderer — including hashline's
 * read/replace/insert — are still framed by the generic
 * ToolExecutionComponent hook below. If hashline is ever uninstalled, restore
 * the read/edit registrations from this file's git history.
 *
 * bash and powershell are deliberately absent: the `agents` extension registers
 * those names to wrap their execution, and pi resolves a duplicate tool name
 * first-wins, so a registration here would be ignored. Its `src/mac-frame.ts`
 * supplies the same renderers to those registrations.
 *
 * How it works
 * ------------
 * File/search tools retain their specialised renderers. A guarded, TUI-only
 * ToolExecutionComponent hook frames every other tool at display time, including
 * extension tools registered later and historical calls without a definition.
 * Existing custom renderers keep their state and components; registrations,
 * execution, schemas and tool activation are never changed by the hook.
 * `renderShell: "self"` stops pi drawing its own box, so the tool
 * owns the framing. With "self", pi stacks the call renderer and the result
 * renderer in one plain container, so `renderCall` draws the top half of the
 * window (border + title bar + separator + prompt) and `renderResult` draws the
 * bottom half (output + status + closing border).
 *
 * Usage
 * -----
 *   pi -e ./mac-terminal-frame.ts
 *
 * Or drop it in ~/.pi/agent/extensions/ to load it automatically.
 */

import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createWriteToolDefinition,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	type Color,
	type TerminalColorMode,
	backgroundAnsi,
	foregroundAnsi,
	rgbColor,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Palette (approximates macOS Terminal.app, dark appearance)
// ---------------------------------------------------------------------------

const BODY_BG = rgbColor(28, 28, 30);
const BAR_BG = rgbColor(58, 58, 62);
const BORDER = rgbColor(110, 110, 116);
const TEXT = rgbColor(224, 224, 226);
const MUTED = rgbColor(142, 142, 147);
const RED = rgbColor(255, 95, 86);
const YELLOW = rgbColor(255, 189, 46);
const GREEN = rgbColor(39, 201, 63);
const PROMPT = rgbColor(102, 217, 140);
const ADD = rgbColor(102, 217, 140);
const DEL = rgbColor(255, 95, 86);

/** Rows shown before ctrl+e expands a result. */
const COLLAPSED_ROWS = 20;
/** Hard ceiling when expanded, so huge output cannot stall the render path. */
const EXPANDED_ROWS = 400;

/** Shared with the agents extension's shell frames; stable across /reload. */
const FRAMED = Symbol.for("nam-pi.mac-terminal-frame.framed");
const FRAME_HOOK = Symbol.for("nam-pi.mac-terminal-frame.hook");

// ---------------------------------------------------------------------------
// Text sanitising
// ---------------------------------------------------------------------------

/**
 * Escapes that move the cursor or erase, plus C0 control characters other than
 * tab and newline, and DEL. `visibleWidth()` measures all of these as zero
 * width, but a terminal acts on them.
 *
 * Applied in one pass: a second pass would strip the ESC of an SGR sequence
 * kept by the first, destroying the colour.
 */
const UNSAFE_IN_FRAME =
	/\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * Make raw tool output safe to place inside the frame.
 *
 * `visibleWidth()` counts a carriage return, a backspace and cursor-control
 * escapes as zero width, but a terminal acts on them: the text padded to the
 * frame width is then not the text that gets drawn, so the border drifts and
 * the left edge is overwritten. Windows commands (cmd, PowerShell) emit CRLF,
 * which is the usual trigger; a lone CR rewrites its line as a progress bar
 * does, so only the final version is kept. SGR colour sequences are kept.
 * Tabs become three spaces, matching the width `visibleWidth()` reports and
 * pi's own Text component.
 */
function sanitizeForFrame(text: string): string {
	if (text.length === 0) return text;
	// CRLF first, so the CR does not survive as a control character.
	let out = text.replace(/\r\n/g, "\n");
	if (out.includes("\r")) {
		out = out
			.split("\n")
			.map((line) => {
				const last = line.lastIndexOf("\r");
				return last === -1 ? line : line.slice(last + 1);
			})
			.join("\n");
	}
	// Keep SGR (colour) sequences, drop everything else that moves the cursor.
	out = out.replace(UNSAFE_IN_FRAME, (seq) => (seq.charCodeAt(0) === 0x1b && seq.endsWith("m") ? seq : ""));
	return out.replace(/\t/g, "   ");
}

/**
 * A reset inside a segment clears the window fill and the foreground the
 * segment was opened with. Anything after it — the ellipsis `truncateToWidth()`
 * appends, or the tail of tool output that carries its own ANSI (ls --color,
 * git, npm) — would then be drawn transparent, punching a black cell through
 * the frame. Re-apply the opening sequence and the window fill after each one.
 */
function repairResets(text: string, open: string, bgAnsi: string): string {
	if (!text.includes("\x1b")) return text;
	return text.replace(/\x1b\[[0-9;]*m/g, (seq) => {
		const params = seq.slice(2, -1);
		const parts = params.length === 0 ? ["0"] : params.split(";");
		// 0 resets everything; 39 and 49 reset only the foreground/background.
		const suffix =
			(parts.includes("0") || parts.includes("39") ? open : "") +
			(parts.includes("0") || parts.includes("49") ? bgAnsi : "");
		return suffix ? `${seq}${suffix}` : seq;
	});
}

/** Drop ANSI entirely, used when a row must be measured or clipped. */
function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------------------
// Line composition
// ---------------------------------------------------------------------------

interface Seg {
	t: string;
	fg?: Color;
	bold?: boolean;
	dim?: boolean;
}

const seg = (t: string, o: Omit<Seg, "t"> = {}): Seg => ({ t, ...o });

/** Render one row, using the terminal background when no fill is supplied. */
function renderRow(width: number, segs: Seg[], bg: Color | undefined, mode: TerminalColorMode): string {
	const bgAnsi = bg ? backgroundAnsi(bg, mode) : "\x1b[49m";
	let used = 0;
	let out = bgAnsi;
	for (const s of segs) {
		let open = "";
		if (s.fg) open += foregroundAnsi(s.fg, mode);
		if (s.bold) open += "\x1b[1m";
		if (s.dim) open += "\x1b[2m";
		out += open + repairResets(s.t, open, bgAnsi) + `\x1b[0m${bgAnsi}`;
		used += visibleWidth(s.t);
	}
	if (used < width) out += " ".repeat(width - used);
	return `${out}\x1b[0m`;
}

/** Clip segments to exactly `width` visible columns, padding with spaces. */
function fit(segs: Seg[], width: number): Seg[] {
	const out: Seg[] = [];
	let used = 0;
	for (const s of segs) {
		if (used >= width) break;
		const w = visibleWidth(s.t);
		if (used + w <= width) {
			out.push(s);
			used += w;
			continue;
		}
		const clipped = truncateToWidth(s.t, width - used, "…", false);
		out.push({ ...s, t: clipped });
		used += visibleWidth(clipped);
		break;
	}
	if (used < width) out.push({ t: " ".repeat(width - used) });
	return out;
}

function borderRow(width: number, left: string, right: string, mode: TerminalColorMode): string {
	const fill = Math.max(0, width - 2);
	return renderRow(width, [seg(left + "─".repeat(fill) + right, { fg: BORDER })], undefined, mode);
}

/** Backgrounds fill whole cells, so keep the border cells outside the fill. */
function framedRow(width: number, inner: Seg[], bg: Color, mode: TerminalColorMode): string {
	return renderRow(1, [seg("│", { fg: BORDER })], undefined, mode) +
		renderRow(width - 2, [seg(" "), ...fit(inner, width - 4), seg(" ")], bg, mode) +
		renderRow(1, [seg("│", { fg: BORDER })], undefined, mode);
}

/**
 * Title bar: traffic lights and the tool name, which is what macOS Terminal
 * shows there. The command itself is drawn in the body below, so it is not
 * repeated here.
 */
function titleRow(width: number, name: string, mode: TerminalColorMode): string {
	const inner: Seg[] = [
		seg("●", { fg: RED }),
		seg(" "),
		seg("●", { fg: YELLOW }),
		seg(" "),
		seg("●", { fg: GREEN }),
		seg("  "),
		seg(name, { fg: TEXT, bold: true }),
	];
	return framedRow(width, inner, BAR_BG, mode);
}

function contentRow(width: number, inner: Seg[], mode: TerminalColorMode): string {
	return framedRow(width, inner, BODY_BG, mode);
}

/** Wrap a styled line in the window frame, preserving its ANSI and background. */
function styledContentRow(width: number, ansiText: string, mode: TerminalColorMode): string {
	const innerWidth = Math.max(0, width - 4);
	const clipped = truncateToWidth(ansiText, innerWidth, "…", false);
	const clippedWidth = visibleWidth(clipped);
	const body = clipped + " ".repeat(Math.max(0, innerWidth - clippedWidth));
	return framedRow(width, [seg(body)], BODY_BG, mode);
}

// ---------------------------------------------------------------------------
// Frame component
// ---------------------------------------------------------------------------

type Builder = (width: number) => string[];

class Frame implements Component {
	private builder: Builder = () => [];
	private version = 0;
	private cachedWidth?: number;
	private cachedVersion = -1;
	private cachedLines?: string[];

	set(builder: Builder): void {
		this.builder = builder;
		this.version++;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width && this.cachedVersion === this.version) {
			return this.cachedLines;
		}
		const lines = this.builder(width);
		this.cachedWidth = width;
		this.cachedVersion = this.version;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedLines = undefined;
	}
}

/** Reuse one Frame per render slot instead of allocating on every update. */
function useFrame(context: { state: Record<string, unknown> }, key: string, build: Builder): Frame {
	const existing = context.state[key];
	const frame = existing instanceof Frame ? existing : new Frame();
	context.state[key] = frame;
	frame.set(build);
	return frame;
}

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

interface ContentBlock {
	type: string;
	text?: string;
}

/** Concatenate the text blocks of a tool result. */
function textOf(result: { content: ReadonlyArray<ContentBlock> }): string {
	return sanitizeForFrame(
		result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n"),
	);
}

interface Status {
	segs: Seg[];
	/** Text with the status line and its blank separator removed. */
	text: string;
}

/**
 * Build body rows from plain output text. Lines pi appends for truncation are
 * shown muted so they read as chrome rather than command output.
 */
function bodyFromText(text: string, expanded: boolean): Seg[][] {
	const all = text.length === 0 ? [] : text.split("\n");
	const cap = expanded ? EXPANDED_ROWS : COLLAPSED_ROWS;
	const shown = all.slice(0, cap);
	const rows: Seg[][] = shown.map((line) => {
		if (/^\[Showing /.test(line)) return [seg(line, { fg: MUTED, dim: true })];
		return [seg(line, { fg: TEXT })];
	});
	if (all.length > cap) {
		rows.push([seg(`… ${all.length - cap} more lines (ctrl+e to expand)`, { fg: MUTED, dim: true })]);
	}
	return rows;
}

/** Rows for output that may contain its own ANSI; kept as one pre-styled line. */
function ansiBodyFromText(text: string, expanded: boolean): string[] {
	const all = text.length === 0 ? [] : text.split("\n");
	const cap = expanded ? EXPANDED_ROWS : COLLAPSED_ROWS;
	const shown = all.slice(0, cap);
	if (all.length > cap) {
		shown.push(`… ${all.length - cap} more lines (ctrl+e to expand)`);
	}
	return shown;
}

// ---------------------------------------------------------------------------
// Frame halves
// ---------------------------------------------------------------------------

interface BottomOptions {
	/** Pre-styled rows; when present, ANSI is preserved. */
	ansiRows?: string[];
	rows?: Seg[][];
	status?: Seg[];
	/** While true the frame stays open, signalling the command is still running. */
	running: boolean;
}

function bottomFrame(theme: Theme, options: BottomOptions): Builder {
	return (width) => {
		if (width < 12) {
			const flat = [
				...(options.ansiRows ?? []).map(stripAnsi),
				...(options.rows ?? []).map((r) => stripAnsi(r.map((s) => s.t).join(""))),
			];
			return flat.map((l) => truncateToWidth(l, width, "…", true));
		}

		const mode = theme.getColorMode();
		const lines: string[] = [];

		if (options.ansiRows) {
			for (const row of options.ansiRows) lines.push(styledContentRow(width, row, mode));
		}
		for (const row of options.rows ?? []) lines.push(contentRow(width, row, mode));

		if (options.running) {
			lines.push(contentRow(width, [seg("● ", { fg: YELLOW }), seg("running…", { fg: MUTED, dim: true })], mode));
			return lines;
		}

		if (options.status && options.status.length > 0) lines.push(contentRow(width, options.status, mode));
		lines.push(borderRow(width, "╰", "╯", mode));
		return lines;
	};
}

// ---------------------------------------------------------------------------
// Per-tool renderers
// ---------------------------------------------------------------------------

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Top half of the window: top border, title bar, separator, then the command
 * after a shell prompt.
 */
function callFrame(
	theme: Theme,
	context: { state: Record<string, unknown> },
	name: string,
	command: string,
): Component {
	// A command can span lines; the frame shows its first.
	const first = sanitizeForFrame(command).split("\n")[0];
	return useFrame(context, "call", (width) => {
		const mode = theme.getColorMode();
		if (width < 12) return [truncateToWidth(`$ ${first}`, width, "…", true)];
		return [
			borderRow(width, "╭", "╮", mode),
			titleRow(width, name, mode),
			borderRow(width, "├", "┤", mode),
			contentRow(
				width,
				[
					seg("$ ", { fg: PROMPT, bold: true }),
					seg(first, { fg: TEXT }),
				],
				mode,
			),
		];
	});
}

// ---------------------------------------------------------------------------
// Display-only adapter for extension tools
// ---------------------------------------------------------------------------

type ToolRenderers = Pick<ToolDefinition, "renderCall" | "renderResult" | "renderShell"> & { [FRAMED]?: boolean };

/** Wrap the original component rather than replacing an extension's renderer. */
class FramedComponent implements Component {
	private contentHeight = 0;

	constructor(
		readonly child: Component | undefined,
		private readonly theme: Theme,
		private readonly expanded: boolean,
		private readonly title?: string,
		private readonly running = false,
		private readonly isError = false,
	) {}

	render(width: number): string[] {
		const narrow = width < 12;
		const mode = this.theme.getColorMode();
		const rows = (this.child?.render(narrow ? width : width - 4) ?? [])
			.flatMap((row) => sanitizeForFrame(row).split("\n"));
		const cap = this.expanded ? EXPANDED_ROWS : COLLAPSED_ROWS;
		this.contentHeight = Math.min(rows.length, cap);
		const draw = (row: string) => narrow
			? truncateToWidth(stripAnsi(row), width, "…", true)
			: styledContentRow(width, row, mode);
		const lines = this.title === undefined || narrow ? [] : [
			borderRow(width, "╭", "╮", mode),
			titleRow(width, sanitizeForFrame(this.title), mode),
			borderRow(width, "├", "┤", mode),
		];
		lines.push(...rows.slice(0, cap).map(draw));
		if (rows.length > cap) lines.push(draw(`… ${rows.length - cap} more lines (ctrl+e to expand)`));
		if (this.title === undefined) {
			if (this.running) lines.push(draw("● running…"));
			else {
				if (this.isError) lines.push(draw(`${foregroundAnsi(DEL, mode)}✗ failed`));
				if (!narrow) lines.push(borderRow(width, "╰", "╯", mode));
			}
		}
		return lines;
	}

	invalidate(): void { this.child?.invalidate(); }

	handleInput(data: string): void { this.child?.handleInput?.(data); }

	handleMouse(event: Parameters<NonNullable<Component["handleMouse"]>>[0]): ReturnType<NonNullable<Component["handleMouse"]>> {
		const narrow = event.width < 12;
		const y = event.y - (this.title !== undefined && !narrow ? 3 : 0);
		const x = event.x - (narrow ? 0 : 2);
		const width = narrow ? event.width : event.width - 4;
		if (y < 0 || y >= this.contentHeight || x < 0 || x >= width) return undefined;
		return this.child?.handleMouse?.({ ...event, x, y, width, height: this.contentHeight });
	}
}

interface ToolDisplay {
	toolName: string;
	toolDefinition?: ToolRenderers;
	hasRendererDefinition(): boolean;
	createCallFallback(): Component;
	createResultFallback(): Component | undefined;
}

/** Pi has no public cross-tool renderer hook. Guard this single internal seam. */
function installToolFrames(): (() => void) | undefined {
	const prototype = ToolExecutionComponent.prototype as unknown as ToolDisplay & { [FRAME_HOOK]?: () => void };
	if ([prototype.hasRendererDefinition, prototype.createCallFallback, prototype.createResultFallback]
		.some((method) => typeof method !== "function")) return undefined;

	prototype[FRAME_HOOK]?.();
	const original = prototype.hasRendererDefinition;
	const innerContext = <T extends { lastComponent: Component | undefined }>(context: T): T => ({
		...context,
		lastComponent: context.lastComponent instanceof FramedComponent ? context.lastComponent.child : context.lastComponent,
	});
	const patched = function (this: ToolDisplay): boolean {
		if (!this.toolDefinition?.[FRAMED]) {
			const definition = this.toolDefinition;
			// Clone only this display instance. Never mutate or re-register another tool.
			this.toolDefinition = {
				...definition,
				[FRAMED]: true,
				renderShell: "self",
				renderCall: (args, theme, context) => {
					let child: Component;
					try { child = definition?.renderCall?.(args, theme, innerContext(context)) ?? this.createCallFallback(); }
					catch { child = this.createCallFallback(); }
					return new FramedComponent(child, theme, context.expanded, this.toolName);
				},
				renderResult: (result, options, theme, context) => {
					let child: Component | undefined;
					try { child = definition?.renderResult?.(result, options, theme, innerContext(context)) ?? this.createResultFallback(); }
					catch { child = this.createResultFallback(); }
					return new FramedComponent(child, theme, options.expanded, undefined, options.isPartial, context.isError);
				},
			};
		}
		return original.call(this);
	};
	prototype.hasRendererDefinition = patched;
	const uninstall = () => {
		if (prototype.hasRendererDefinition === patched) prototype.hasRendererDefinition = original;
		if (prototype[FRAME_HOOK] === uninstall) delete prototype[FRAME_HOOK];
	};
	prototype[FRAME_HOOK] = uninstall;
	return uninstall;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const registerTool: ExtensionAPI["registerTool"] = (definition) => {
		const framed = { ...definition, [FRAMED]: true };
		pi.registerTool(framed);
	};
	let uninstall: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		uninstall = installToolFrames();
		if (!uninstall) ctx.ui.notify("mac-terminal-frame: Pi's tool UI changed; automatic tool frames are unavailable.", "warning");
	});
	pi.on("session_shutdown", () => { uninstall?.(); });

	// bash and powershell are NOT registered here. The `agents` extension already
	// registers both to wrap their execution for shell tracking, and pi resolves a
	// duplicate tool name first-wins, so a registration here would be ignored and
	// the frame would silently not appear. Its `src/mac-frame.ts` supplies the same
	// renderers to those registrations instead.

	// -----------------------------------------------------------------------
	// write: path, line count, optional content preview
	// -----------------------------------------------------------------------
	const originalWrite = createWriteToolDefinition(cwd);
	registerTool({
		...originalWrite,
		renderShell: "self",

		renderCall(args, theme, context) {
			const a = args ?? {};
			return callFrame(theme, context, "write", `write ${str(a.path)}`);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = textOf(result);
			if (/^error/i.test(text)) {
				return useFrame(
					context,
					"result",
					bottomFrame(theme, {
						rows: [[seg(`✗ ${text.split("\n")[0]}`, { fg: DEL })]],
						running: isPartial,
					}),
				);
			}

			const content = sanitizeForFrame(str((context.args as Record<string, unknown> | undefined)?.content));
			const lineCount = content ? content.split("\n").length : 0;
			const rows: Seg[][] = [[seg(`✓ written${lineCount ? ` (${lineCount} lines)` : ""}`, { fg: GREEN })]];
			if (expanded && content) {
				const lines = content.split("\n");
				for (const line of lines.slice(0, EXPANDED_ROWS)) rows.push([seg(`+ ${line}`, { fg: ADD, dim: true })]);
				if (lines.length > EXPANDED_ROWS) {
					rows.push([seg(`… ${lines.length - EXPANDED_ROWS} more lines`, { fg: MUTED, dim: true })]);
				}
			}
			return useFrame(context, "result", bottomFrame(theme, { rows, running: isPartial }));
		},
	});

	// -----------------------------------------------------------------------
	// grep / find / ls: read-only search tools.
	//
	// These are off by default in pi. Spreading their definitions would leave
	// `defaultActive` undefined, which pi treats as "activate on registration",
	// silently enabling tools the user had turned off. Forcing it to false
	// keeps the agent's toolset exactly as it was; if the user did enable one,
	// pi keeps it active and it simply renders framed.
	// -----------------------------------------------------------------------
	const originalGrep = createGrepToolDefinition(cwd);
	registerTool({
		...originalGrep,
		defaultActive: false,
		renderShell: "self",

		renderCall(args, theme, context) {
			const a = args ?? {};
			const flags = [a.ignoreCase ? "-i" : "", a.literal ? "-F" : "", a.glob ? `--glob ${str(a.glob)}` : ""]
				.filter(Boolean)
				.join(" ");
			const command = `grep ${flags ? `${flags} ` : ""}${str(a.pattern) || "…"}${a.path ? ` ${str(a.path)}` : ""}`;
			return callFrame(theme, context, "grep", command);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = textOf(result);
			return useFrame(
				context,
				"result",
				bottomFrame(theme, { ansiRows: ansiBodyFromText(text, expanded), running: isPartial }),
			);
		},
	});

	const originalFind = createFindToolDefinition(cwd);
	registerTool({
		...originalFind,
		defaultActive: false,
		renderShell: "self",

		renderCall(args, theme, context) {
			const a = args ?? {};
			return callFrame(theme, context, "find", `find ${str(a.pattern) || "…"}${a.path ? ` ${str(a.path)}` : ""}`);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = textOf(result);
			return useFrame(
				context,
				"result",
				bottomFrame(theme, { ansiRows: ansiBodyFromText(text, expanded), running: isPartial }),
			);
		},
	});

	const originalLs = createLsToolDefinition(cwd);
	registerTool({
		...originalLs,
		defaultActive: false,
		renderShell: "self",

		renderCall(args, theme, context) {
			const a = args ?? {};
			return callFrame(theme, context, "ls", `ls ${str(a.path) || "."}`);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = textOf(result);
			return useFrame(
				context,
				"result",
				bottomFrame(theme, { ansiRows: ansiBodyFromText(text, expanded), running: isPartial }),
			);
		},
	});
}
