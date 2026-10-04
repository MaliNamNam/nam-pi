/**
 * macOS Terminal frame for the shell tools.
 *
 * Presentation only: these renderers draw a bash/powershell call as a window
 * with a title bar (traffic lights, tool name, command) and the streamed output
 * inside a rounded frame. They are spread into the shell tool registrations in
 * `index.ts` so the shell tracking and cancellation there keep working.
 *
 * Why the renderers live here rather than in a separate extension: Pi resolves
 * a duplicate tool name first-wins (`ExtensionRunner.getAllRegisteredTools()`),
 * and this extension registers `bash`/`powershell` to wrap their execution. A
 * second extension registering the same names would be ignored, so the frame
 * has to be part of the same tool definition.
 *
 * The title bar shows the tool the "terminal" is for, which is what macOS
 * Terminal shows there, with the command right-aligned.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
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
const DEL = rgbColor(255, 95, 86);

/** Rows shown before ctrl+e expands a result. */
const COLLAPSED_ROWS = 20;
/** Hard ceiling when expanded, so huge output cannot stall the render path. */
const EXPANDED_ROWS = 400;

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
 * Make raw shell output safe to place inside the frame.
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
 * appends, or the tail of shell output that carries its own ANSI (ls --color,
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

/** Render one full-width row: a background plus per-segment foregrounds. */
function renderRow(width: number, segs: Seg[], bg: Color, mode: TerminalColorMode): string {
	const bgAnsi = backgroundAnsi(bg, mode);
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
	return renderRow(width, [seg(left + "─".repeat(fill) + right, { fg: BORDER })], BODY_BG, mode);
}

/**
 * Title bar: traffic lights and the tool name, which is what macOS Terminal
 * shows there. The command itself is drawn in the body below, so it is not
 * repeated here.
 */
function titleRow(width: number, name: string, mode: TerminalColorMode): string {
	const innerWidth = Math.max(0, width - 4);
	const inner: Seg[] = [
		seg("●", { fg: RED }),
		seg(" "),
		seg("●", { fg: YELLOW }),
		seg(" "),
		seg("●", { fg: GREEN }),
		seg("  "),
		seg(name, { fg: TEXT, bold: true }),
	];
	return renderRow(width, [seg("│ ", { fg: BORDER }), ...fit(inner, innerWidth), seg(" │", { fg: BORDER })], BAR_BG, mode);
}

function contentRow(width: number, inner: Seg[], mode: TerminalColorMode): string {
	const innerWidth = Math.max(0, width - 4);
	return renderRow(
		width,
		[seg("│ ", { fg: BORDER }), ...fit(inner, innerWidth), seg(" │", { fg: BORDER })],
		BODY_BG,
		mode,
	);
}

/** Wrap a pre-styled line in the frame, preserving its ANSI and background. */
function styledContentRow(width: number, ansiText: string, mode: TerminalColorMode): string {
	const innerWidth = Math.max(0, width - 4);
	const clipped = truncateToWidth(ansiText, innerWidth, "…", false);
	const clippedWidth = visibleWidth(clipped);
	const body = clipped + " ".repeat(Math.max(0, innerWidth - clippedWidth));
	return renderRow(width, [seg("│ ", { fg: BORDER }), seg(body), seg(" │", { fg: BORDER })], BODY_BG, mode);
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
// Result handling
// ---------------------------------------------------------------------------

interface ContentBlock {
	type: string;
	text?: string;
}

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

const STATUS_PATTERNS: Array<{ re: RegExp; render: (m: RegExpMatchArray) => Seg[] }> = [
	{
		re: /^Command exited with code (\d+)$/,
		render: (m) => [seg("✗ ", { fg: DEL, bold: true }), seg(`exit ${m[1]}`, { fg: DEL })],
	},
	{
		re: /^Command timed out after (.+)$/,
		render: (m) => [seg("✗ ", { fg: DEL, bold: true }), seg(`timed out after ${m[1]}`, { fg: DEL })],
	},
	{
		re: /^Command aborted$/,
		render: () => [seg("✗ ", { fg: DEL, bold: true }), seg("aborted", { fg: DEL })],
	},
	{
		re: /^Command terminated without an exit code$/,
		render: () => [seg("✗ ", { fg: DEL, bold: true }), seg("terminated", { fg: DEL })],
	},
];

/**
 * Split the trailing shell status line off a result so it can be drawn as a
 * styled status row rather than as ordinary output.
 */
function splitStatus(text: string): Status {
	const lines = text.replace(/\n+$/, "").split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].trim() === "") continue;
		for (const { re, render } of STATUS_PATTERNS) {
			const m = lines[i].trim().match(re);
			if (!m) continue;
			const body = lines.slice(0, i);
			while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
			return { segs: render(m), text: body.join("\n") };
		}
		break;
	}
	return { segs: [], text: text.replace(/\n+$/, "") };
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

interface BottomOptions {
	ansiRows: string[];
	status?: Seg[];
	/** While true the frame stays open, signalling the command is still running. */
	running: boolean;
}

function bottomFrame(theme: Theme, options: BottomOptions): Builder {
	return (width) => {
		if (width < 12) {
			return options.ansiRows.map((l) => truncateToWidth(stripAnsi(l), width, "…", true));
		}

		const mode = theme.getColorMode();
		const lines: string[] = [];
		for (const row of options.ansiRows) lines.push(styledContentRow(width, row, mode));

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
// Shell renderers
// ---------------------------------------------------------------------------

export type ShellToolName = "bash" | "powershell";

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const PROMPTS: Record<ShellToolName, string> = { bash: "$", powershell: ">" };

/**
 * Renderer fields for a shell tool. Spread these into the registration that
 * also supplies `execute`, so the frame and the shell tracking coexist.
 */
export function shellFrameRenderers(name: ShellToolName) {
	const prompt = PROMPTS[name];
	return {
		[Symbol.for("nam-pi.mac-terminal-frame.framed")]: true,
		renderShell: "self" as const,

		renderCall(args: { command?: string }, theme: Theme, context: { state: Record<string, unknown> }): Component {
			const command = sanitizeForFrame(str(args?.command)).split("\n")[0];
			return useFrame(context, "call", (width) => {
				const mode = theme.getColorMode();
				if (width < 12) return [truncateToWidth(`${prompt} ${command}`, width, "…", true)];
				const line: Seg[] = [seg(`${prompt} `, { fg: PROMPT, bold: true })];
				if (command) line.push(seg(command, { fg: TEXT }));
				else line.push(seg("…", { fg: MUTED, dim: true }));
				return [
					borderRow(width, "╭", "╮", mode),
					titleRow(width, name, mode),
					borderRow(width, "├", "┤", mode),
					contentRow(width, line, mode),
				];
			});
		},

		renderResult(
			result: { content: ReadonlyArray<ContentBlock> },
			options: { expanded: boolean; isPartial: boolean },
			theme: Theme,
			context: { state: Record<string, unknown> },
		): Component {
			const status = splitStatus(textOf(result));
			return useFrame(
				context,
				"result",
				bottomFrame(theme, {
					ansiRows: ansiBodyFromText(status.text, options.expanded),
					status: status.segs,
					running: options.isPartial,
				}),
			);
		},
	};
}
