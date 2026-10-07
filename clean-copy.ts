/**
 * Clean clipboard copies from the fullscreen transcript.
 *
 * In fullscreen mode (pi's default), mouse drag-select is handled by pi itself:
 * `TuiAltScreen.getActiveSelectionText()` returns the exact glyphs on screen,
 * and this setup frames every message — pi-side-panel's conversation frames
 * (`   ╭─ 👤 ──╮` / `│ text │` / `╰──╯`), mac-terminal-frame's tool windows, and
 * the agents extension's views — so a copied message arrives as mangled
 * `│`-edged fragments. This wraps `getActiveSelectionText` (the one funnel every
 * selection copy uses: copy-on-select, `ctrl+c`, `ctrl+x`) to strip that chrome:
 *
 * - Rows made only of border glyphs (`╭───╮`, `├─┼──┤`, `╰──╯`, a dragged
 *   `│` column) are dropped; a corner row with text in it
 *   (`╭─ write · src/main.ts ─╮`) keeps the text.
 * - Content rows lose exactly one border cell per side, so blockquote bars,
 *   markdown table cells, and `tree` output markers survive, while a tool
 *   window nested inside a framed message peels (`│ ╰──╯ │` drops).
 *
 * The wrapper never invents text: it only removes frame glyphs and padding, and
 * reports a chrome-only selection as no selection (so it doesn't flash
 * "Copied!"). Regular (non-fullscreen) mode selects through the terminal, which
 * no extension can intercept — but that mode is not the default.
 */
import { TuiAltScreen } from "@earendil-works/pi-tui";

/** A row made only of border glyphs and padding: rules, corners, cells, `───`. */
const BORDER_ONLY = /^ *[│┃╭╮╰╯├┤┬┴┼─][ │┃╭╮╰╯├┤┬┴┼─]*$/u;
/** A corner row with something inscribed: captures the text between the corners. */
const CORNER_ROW = /^\s*([╭├╰])(.*)([╮┤╯])\s*$/u;
/** One leading border cell plus its pad: the 3-space gutter, then `│ `. */
const LEADING_EDGE = /^ {0,8}[│┃] ?/u;
/** One trailing border cell plus its pad: padding, then `│` at the line end. */
const TRAILING_EDGE = / *[│┃] *$/u;

function hasLetterOrDigit(title: string): boolean {
	return /[\p{L}\p{N}]/u.test(title);
}

/** Remove one frame layer from a row; returns undefined for pure border rows. */
function stripRow(row: string): string | undefined {
	if (BORDER_ONLY.test(row)) return undefined;
	const corner = CORNER_ROW.exec(row);
	if (corner) {
		const title = corner[2].replace(/^[ ─]+|[ ─]+$/gu, "").trim();
		return hasLetterOrDigit(title) ? title : undefined;
	}
	return row.replace(LEADING_EDGE, "").replace(TRAILING_EDGE, "").trimEnd();
}

/** Strip frame chrome from copied transcript text, line by line. */
export function stripFrameChrome(text: string): string {
	const lines: string[] = [];
	for (const line of text.split("\n")) {
		let row: string | undefined = line;
		// Peel nested borders (a tool window inside a framed message), but stop
		// at the first content row so table edges are not stripped away too.
		for (let depth = 0; row !== undefined && depth < 4; depth += 1) {
			const stripped = stripRow(row);
			if (stripped === row) break;
			row = stripped;
			if (row === undefined || !(BORDER_ONLY.test(row) || CORNER_ROW.test(row))) break;
		}
		if (row !== undefined) lines.push(row);
	}
	return lines.join("\n");
}

/** The private-in-the-typings method this extension wraps, accessed structurally. */
type SelectionText = (this: TuiAltScreen) => string | undefined;
type PatchedPrototype = { __cleanCopyPatched?: boolean; getActiveSelectionText?: SelectionText };

export default function (): void {
	const prototype = TuiAltScreen.prototype as unknown as PatchedPrototype;
	if (typeof prototype.getActiveSelectionText !== "function" || prototype.__cleanCopyPatched) return;

	const original = prototype.getActiveSelectionText;
	prototype.getActiveSelectionText = function (this: TuiAltScreen): string | undefined {
		const text = original.call(this);
		if (text === undefined) return undefined;
		const cleaned = stripFrameChrome(text);
		return cleaned.length > 0 ? cleaned : undefined;
	};
	prototype.__cleanCopyPatched = true;
}
