/**
 * pi-image — opencode-style image pasting for Pi's chatbox.
 *
 * Ctrl+V with a screenshot on the clipboard inserts an `[Image N]` token into
 * the prompt and shows a thumbnail strip above the editor; on submit the image
 * travels with the message as an image part. Tokens stay in the submitted text
 * like opencode's, and deleting a token drops the attachment.
 *
 * Other extensions (pi-side-panel, agents) replace the editor, so this one
 * does not: a raw terminal listener catches the paste and the token goes in
 * through ctx.ui.pasteToEditor, which works with whichever editor is active.
 * Windows Terminal delivers Ctrl+V with an image-only clipboard as an empty
 * bracketed paste, which pi's editor would silently drop.
 *
 * Thumbnails are truecolor half-block cells, so they render in any truecolor
 * terminal, including Windows Terminal (no Kitty/iTerm2 image protocol there).
 */

import type { ExtensionAPI, ExtensionUIContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";

const execFileAsync = promisify(execFile);

const IMAGE_TOKEN_REGEX = /\[Image (\d+)\]/g;
const EMPTY_PASTE_REGEX = /^\x1b\[200~\s*\x1b\[201~$/;
const WIDGET_KEY = "pi-image";
const THUMB_MAX_COLS = 20;
const THUMB_MAX_ROWS = 6;
const THUMB_BACKGROUND = [32, 32, 32] as const;
const CLIPBOARD_TIMEOUT_MS = 15_000;
/** Screenshots are several MB of base64; execFile's 1 MB default would drop them. */
const CLIPBOARD_MAX_BUFFER = 256 * 1024 * 1024;

/** An image attachment, shaped like the ImageContent the model API expects. */
export interface ImageAttachment {
	type: "image";
	data: string;
	mimeType: string;
}

export type ClipboardRead =
	| { kind: "image"; data: string; mimeType: string }
	| { kind: "paths" | "text"; text: string }
	| { kind: "none" }
	| { kind: "error"; message: string };

type PasteUI = Pick<ExtensionUIContext, "pasteToEditor" | "getEditorText" | "notify">;
type WidgetUI = PasteUI & Pick<ExtensionUIContext, "onTerminalInput" | "setWidget">;

async function run(file: string, args: string[]): Promise<Buffer> {
	const { stdout } = await execFileAsync(file, args, {
		encoding: "buffer",
		timeout: CLIPBOARD_TIMEOUT_MS,
		maxBuffer: CLIPBOARD_MAX_BUFFER,
		windowsHide: true,
	});
	return stdout;
}

async function tryRun(file: string, args: string[]): Promise<Buffer> {
	try {
		return await run(file, args);
	} catch {
		return Buffer.alloc(0);
	}
}

// One Windows call decides the paste kind, in the same priority as pi's
// built-in paste: copied files, then image (as PNG), then text.
const WINDOWS_CLIPBOARD_SCRIPT = [
	"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
	"Add-Type -AssemblyName System.Windows.Forms",
	"Add-Type -AssemblyName System.Drawing",
	"if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {",
	'	"paths|" + ([System.Windows.Forms.Clipboard]::GetFileDropList() -join [char]10)',
	"} elseif ([System.Windows.Forms.Clipboard]::ContainsImage()) {",
	"	$img = [System.Windows.Forms.Clipboard]::GetImage()",
	"	$ms = New-Object System.IO.MemoryStream",
	"	$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
	'	"image|" + [System.Convert]::ToBase64String($ms.ToArray())',
	"} elseif ([System.Windows.Forms.Clipboard]::ContainsText()) {",
	'	"text|" + [System.Windows.Forms.Clipboard]::GetText()',
	"} else {",
	'	"none|"',
	"}",
].join("\n");

export async function readClipboard(): Promise<ClipboardRead> {
	if (process.platform === "win32") {
		let out: string;
		try {
			out = (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_CLIPBOARD_SCRIPT]))
				.toString("utf8")
				.replace(/\r\n/g, "\n");
		} catch (error) {
			return { kind: "error", message: error instanceof Error ? error.message : String(error) };
		}
		const separator = out.indexOf("|");
		if (separator === -1) return { kind: "none" };
		const kind = out.slice(0, separator);
		// Strip only the newline the PowerShell host appends, never user text.
		const value = out.slice(separator + 1).replace(/\n$/, "");
		if (kind === "image" && value) return { kind: "image", data: value, mimeType: "image/png" };
		if ((kind === "paths" || kind === "text") && value) return { kind, text: value };
		return { kind: "none" };
	}

	if (process.platform === "darwin") {
		// opencode's route: osascript writes `the clipboard as "PNGf"` to a temp file.
		const file = (await tryRun("mktemp", [])).toString("utf8").trim();
		if (file) {
			await tryRun("osascript", [
				"-e",
				'set imageData to the clipboard as "PNGf"',
				"-e",
				`set fileRef to open for access POSIX file "${file}" with write permission`,
				"-e",
				"set eof fileRef to 0",
				"-e",
				"write imageData to fileRef",
				"-e",
				"close access fileRef",
			]);
			try {
				const bytes = await readFile(file).catch(() => Buffer.alloc(0));
				if (bytes.length) return { kind: "image", data: bytes.toString("base64"), mimeType: "image/png" };
			} finally {
				await rm(file, { force: true }).catch(() => {});
			}
		}
		const text = (await tryRun("pbpaste", [])).toString("utf8");
		return text ? { kind: "text", text } : { kind: "none" };
	}

	const wayland = await tryRun("wl-paste", ["-t", "image/png"]);
	if (wayland.length) return { kind: "image", data: wayland.toString("base64"), mimeType: "image/png" };
	const x11 = await tryRun("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]);
	if (x11.length) return { kind: "image", data: x11.toString("base64"), mimeType: "image/png" };
	const text = (await tryRun("wl-paste", ["-n"])).toString("utf8") || (await tryRun("xclip", ["-selection", "clipboard", "-o"])).toString("utf8");
	return text ? { kind: "text", text } : { kind: "none" };
}

export interface DecodedImage {
	width: number;
	height: number;
	rgba: Uint8Array;
}

/** Minimal PNG decoder: 8-bit, non-interlaced, every color type. Enough for thumbnails. */
export function decodePng(bytes: Buffer): DecodedImage | undefined {
	if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) return undefined;
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	let interlace = 0;
	let palette: Buffer | undefined;
	const idat: Buffer[] = [];
	for (let pos = 8; pos + 8 <= bytes.length; ) {
		const length = bytes.readUInt32BE(pos);
		const type = bytes.toString("latin1", pos + 4, pos + 8);
		const data = bytes.subarray(pos + 8, pos + 8 + length);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			bitDepth = data[8]!;
			colorType = data[9]!;
			interlace = data[12]!;
		} else if (type === "PLTE") palette = data;
		else if (type === "IDAT") idat.push(data);
		else if (type === "IEND") break;
		pos += 12 + length;
	}
	const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
	if (!width || !height || bitDepth !== 8 || interlace !== 0 || !channels || (colorType === 3 && !palette)) return undefined;

	let raw: Buffer;
	try {
		raw = inflateSync(Buffer.concat(idat));
	} catch {
		return undefined;
	}
	const stride = width * channels;
	if (raw.length < (stride + 1) * height) return undefined;

	const rgba = new Uint8Array(width * height * 4);
	let prev = new Uint8Array(stride);
	let cur = new Uint8Array(stride);
	let p = 0;
	for (let y = 0; y < height; y++) {
		const filter = raw[p++]!;
		for (let x = 0; x < stride; x++) {
			const left = x >= channels ? cur[x - channels]! : 0;
			const up = prev[x]!;
			const upLeft = x >= channels ? prev[x - channels]! : 0;
			let value = raw[p++]!;
			if (filter === 1) value += left;
			else if (filter === 2) value += up;
			else if (filter === 3) value += (left + up) >> 1;
			else if (filter === 4) {
				const estimate = left + up - upLeft;
				const pa = Math.abs(estimate - left);
				const pb = Math.abs(estimate - up);
				const pc = Math.abs(estimate - upLeft);
				value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
			}
			cur[x] = value & 0xff;
		}
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 4;
			const i = x * channels;
			if (colorType === 6) {
				rgba[o] = cur[i]!;
				rgba[o + 1] = cur[i + 1]!;
				rgba[o + 2] = cur[i + 2]!;
				rgba[o + 3] = cur[i + 3]!;
			} else if (colorType === 2) {
				rgba[o] = cur[i]!;
				rgba[o + 1] = cur[i + 1]!;
				rgba[o + 2] = cur[i + 2]!;
				rgba[o + 3] = 255;
			} else if (colorType === 3) {
				const k = cur[i]! * 3;
				rgba[o] = palette![k] ?? 0;
				rgba[o + 1] = palette![k + 1] ?? 0;
				rgba[o + 2] = palette![k + 2] ?? 0;
				rgba[o + 3] = 255;
			} else {
				rgba[o] = rgba[o + 1] = rgba[o + 2] = cur[i]!;
				rgba[o + 3] = colorType === 4 ? cur[i + 1]! : 255;
			}
		}
		[prev, cur] = [cur, prev];
	}
	return { width, height, rgba };
}

/**
 * Half-block thumbnail: each cell is `▀` with the upper pixel as foreground
 * and the lower pixel as background. Returns rows of exactly `cols` cells.
 */
export function renderThumbnail(image: DecodedImage, maxCols = THUMB_MAX_COLS, maxRows = THUMB_MAX_ROWS): string[] {
	const { width, height, rgba } = image;
	let cols = Math.min(maxCols, width);
	let pxHeight = Math.max(1, Math.round((cols * height) / width));
	if (pxHeight > maxRows * 2) {
		pxHeight = maxRows * 2;
		cols = Math.max(1, Math.min(maxCols, Math.round((pxHeight * width) / height)));
	}
	const sample = (cx: number, cy: number): string => {
		const x0 = Math.floor((cx * width) / cols);
		const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * width) / cols));
		const y0 = Math.floor((cy * height) / pxHeight);
		const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * height) / pxHeight));
		const stepX = Math.max(1, Math.floor((x1 - x0) / 8));
		const stepY = Math.max(1, Math.floor((y1 - y0) / 8));
		let r = 0;
		let g = 0;
		let b = 0;
		let n = 0;
		for (let y = y0; y < y1; y += stepY) {
			for (let x = x0; x < x1; x += stepX) {
				const o = (y * width + x) * 4;
				const alpha = rgba[o + 3]! / 255;
				r += rgba[o]! * alpha + THUMB_BACKGROUND[0] * (1 - alpha);
				g += rgba[o + 1]! * alpha + THUMB_BACKGROUND[1] * (1 - alpha);
				b += rgba[o + 2]! * alpha + THUMB_BACKGROUND[2] * (1 - alpha);
				n++;
			}
		}
		return `${Math.round(r / n)};${Math.round(g / n)};${Math.round(b / n)}`;
	};
	const rows: string[] = [];
	for (let row = 0; row * 2 < pxHeight; row++) {
		let line = "";
		for (let col = 0; col < cols; col++) {
			const top = sample(col, row * 2);
			line +=
				row * 2 + 1 < pxHeight
					? `\x1b[38;2;${top}m\x1b[48;2;${sample(col, row * 2 + 1)}m▀`
					: `\x1b[38;2;${top}m\x1b[49m▀`;
		}
		rows.push(`${line}\x1b[0m`);
	}
	return rows;
}

/**
 * Pending attachments keyed by token. Display filters by the current editor
 * text; submission consumes the tokens present in the submitted text. Nothing
 * is deleted on render, so the input event never races a repaint.
 */
export class AttachmentStore {
	private pending = new Map<string, { image: ImageAttachment; thumbnail: string[] }>();

	/** Next token: max existing + 1, so deleting [Image 1] keeps [Image 2] stable. */
	nextToken(text: string): string {
		let max = 0;
		for (const match of text.matchAll(IMAGE_TOKEN_REGEX)) max = Math.max(max, Number(match[1]));
		return `[Image ${max + 1}]`;
	}

	add(token: string, image: ImageAttachment): void {
		let thumbnail: string[] = [];
		if (image.mimeType === "image/png") {
			const decoded = decodePng(Buffer.from(image.data, "base64"));
			if (decoded) thumbnail = renderThumbnail(decoded);
		}
		this.pending.set(token, { image, thumbnail });
	}

	/** Tokens with an attachment that appear in the text, oldest first. */
	tokensIn(text: string): string[] {
		return [...this.pending.keys()]
			.filter((token) => text.includes(token))
			.sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
	}

	thumbnail(token: string): string[] {
		return this.pending.get(token)?.thumbnail ?? [];
	}

	/** Images for the tokens in the submitted text, removed from the store. */
	consume(text: string): ImageAttachment[] {
		return this.tokensIn(text).map((token) => {
			const { image } = this.pending.get(token)!;
			this.pending.delete(token);
			return image;
		});
	}
}

/** Reads the clipboard and pastes the right thing into the active editor. */
export async function pasteClipboard(ui: PasteUI, store: AttachmentStore): Promise<void> {
	const result = await readClipboard();
	switch (result.kind) {
		case "image": {
			const token = store.nextToken(ui.getEditorText());
			store.add(token, { type: "image", data: result.data, mimeType: result.mimeType });
			ui.pasteToEditor(`${token} `);
			break;
		}
		case "paths":
		case "text":
			ui.pasteToEditor(result.text);
			break;
		case "none":
			ui.notify("Clipboard has no image, files, or text to paste", "warning");
			break;
		case "error":
			ui.notify(`Could not read the clipboard: ${result.message}`, "error");
			break;
	}
}

/** Thumbnail strip above the editor: newest attachments that fit the width. */
export class ThumbnailStrip {
	constructor(
		private store: AttachmentStore,
		private editorText: () => string,
		private label: (text: string) => string,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const blocks = this.store.tokensIn(this.editorText()).map((token) => {
			const rows = this.store.thumbnail(token);
			const thumbWidth = rows.length ? visibleWidth(rows[0]!) : 0;
			const blockWidth = Math.max(thumbWidth, token.length);
			return {
				blockWidth,
				lines: [
					...rows.map((row) => row + " ".repeat(blockWidth - thumbWidth)),
					this.label(token) + " ".repeat(blockWidth - token.length),
				],
			};
		});
		if (!blocks.length) return [];

		const shown: typeof blocks = [];
		let used = 1;
		for (let i = blocks.length - 1; i >= 0; i--) {
			const extra = (shown.length ? 2 : 0) + blocks[i]!.blockWidth;
			if (shown.length && used + extra > width) break;
			shown.unshift(blocks[i]!);
			used += extra;
		}
		const height = Math.max(...shown.map((block) => block.lines.length));
		const lines: string[] = [];
		for (let i = 0; i < height; i++) {
			const parts = shown.map((block) => {
				const offset = height - block.lines.length;
				return i < offset ? " ".repeat(block.blockWidth) : block.lines[i - offset]!;
			});
			lines.push(truncateToWidth(` ${parts.join("  ")}`, width, ""));
		}
		return lines;
	}
}

/**
 * Catch paste requests before the active editor sees them and keep the
 * thumbnail widget in sync with the editor text. Returns a detach function.
 */
export function installPaste(ui: WidgetUI, store: AttachmentStore): () => void {
	let widgetShown = false;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;

	const refresh = () => {
		const show = store.tokensIn(ui.getEditorText()).length > 0;
		if (show && !widgetShown) {
			ui.setWidget(
				WIDGET_KEY,
				(_tui, theme) => new ThumbnailStrip(store, () => ui.getEditorText(), (text) => theme.fg("accent", text)),
				{ placement: "aboveEditor" },
			);
		} else if (!show && widgetShown) {
			ui.setWidget(WIDGET_KEY, undefined);
		}
		widgetShown = show;
	};

	const unsubscribe = ui.onTerminalInput((data) => {
		// Ctrl+V in Windows Terminal with an image-only clipboard arrives as an
		// empty bracketed paste; Alt+V is pi's own paste key on Windows.
		if (EMPTY_PASTE_REGEX.test(data) || matchesKey(data, "alt+v")) {
			void pasteClipboard(ui, store)
				.catch((error) => ui.notify(`Paste failed: ${error instanceof Error ? error.message : String(error)}`, "error"))
				.finally(refresh);
			return { consume: true };
		}
		if (widgetShown) {
			// Let the editor apply the keystroke first, then drop the strip if
			// its tokens were deleted or submitted.
			clearTimeout(refreshTimer);
			refreshTimer = setTimeout(refresh, 0);
		}
		return undefined;
	});

	return () => {
		unsubscribe();
		clearTimeout(refreshTimer);
		if (widgetShown) ui.setWidget(WIDGET_KEY, undefined);
		widgetShown = false;
	};
}

export default function (pi: ExtensionAPI, options?: { store?: AttachmentStore }) {
	const store = options?.store ?? new AttachmentStore();
	let detach: (() => void) | undefined;

	pi.on("input", (event: InputEvent): InputEventResult | undefined => {
		if (event.source !== "interactive") return undefined;
		const images = store.consume(event.text);
		if (!images.length) return undefined;
		return { action: "transform", text: event.text, images: [...(event.images ?? []), ...images] };
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		detach?.();
		detach = installPaste(ctx.ui, store);
	});

	pi.on("session_shutdown", () => {
		detach?.();
		detach = undefined;
	});
}
