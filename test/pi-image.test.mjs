import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";

// Pi loads extensions through jiti, with its live components supplied as virtual
// modules. PI_TEST_PACKAGE_DIR allows testing against a global Pi installation.
const entry = process.env.PI_TEST_PACKAGE_DIR
	? pathToFileURL(path.join(process.env.PI_TEST_PACKAGE_DIR, "dist/index.js")).href
	: import.meta.resolve("@earendil-works/pi-coding-agent");
const { createJiti } = await import(new URL("core/extensions/jiti-loader.js", entry));
const { VIRTUAL_MODULES } = await import(new URL("core/extensions/virtual-modules.js", entry));
const { visibleWidth } = VIRTUAL_MODULES["@earendil-works/pi-tui"];
const jiti = createJiti(import.meta.url, { virtualModules: VIRTUAL_MODULES, tryNative: false, moduleCache: false });
const { AttachmentStore, ThumbnailStrip, decodePng, renderThumbnail, installPaste, default: install } = await jiti.import(
	new URL("../pi-image.ts", import.meta.url).href,
);

const run = promisify(execFile);
const onWindows = { skip: process.platform !== "win32" };

/** Build an 8-bit RGB PNG whose pixels come from `color(x, y)`. */
function makePng(width, height, color) {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (buf) => {
		let c = 0xffffffff;
		for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
		const sum = Buffer.alloc(4);
		sum.writeUInt32BE(crc(body));
		return Buffer.concat([len, body, sum]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const raw = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y++) {
		// Alternate filters so the decoder's Sub/Up paths are exercised too.
		const filter = y % 3;
		raw[y * (width * 3 + 1)] = filter;
		for (let x = 0; x < width; x++) {
			const [r, g, b] = color(x, y);
			const o = y * (width * 3 + 1) + 1 + x * 3;
			const px = [r, g, b];
			for (let c = 0; c < 3; c++) {
				const left = x > 0 ? color(x - 1, y)[c] : 0;
				const up = y > 0 ? color(x, y - 1)[c] : 0;
				raw[o + c] = (px[c] - (filter === 1 ? left : filter === 2 ? up : 0)) & 0xff;
			}
		}
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// Left half red, right half blue.
const SPLIT_PNG = makePng(40, 20, (x) => (x < 20 ? [255, 0, 0] : [0, 0, 255]));
const SPLIT_B64 = SPLIT_PNG.toString("base64");

/** In-memory stand-in for ctx.ui with a pi-like editor behind pasteToEditor. */
function fakeUI() {
	const ui = {
		editorText: "",
		widgets: new Map(),
		notices: [],
		listener: undefined,
		onTerminalInput(handler) {
			ui.listener = handler;
			return () => {
				ui.listener = undefined;
			};
		},
		setWidget(key, factory) {
			if (factory === undefined) ui.widgets.delete(key);
			else ui.widgets.set(key, factory(undefined, { fg: (_color, text) => text }));
		},
		pasteToEditor(text) {
			ui.editorText += text;
		},
		getEditorText() {
			return ui.editorText;
		},
		notify(message, type) {
			ui.notices.push([message, type]);
		},
	};
	return ui;
}

async function waitFor(check, label) {
	for (let i = 0; i < 150 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 100));
	assert.ok(check(), label);
}

async function putImageOnClipboard() {
	await run(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $b = New-Object System.Drawing.Bitmap(1920,1080); $g = [System.Drawing.Graphics]::FromImage($b); $g.Clear([System.Drawing.Color]::SeaGreen); $g.Dispose(); [System.Windows.Forms.Clipboard]::SetImage($b)",
		],
		{ timeout: 15_000, windowsHide: true },
	);
}

test("the PNG decoder reads filtered RGB rows", () => {
	const image = decodePng(SPLIT_PNG);
	assert.equal(image.width, 40);
	assert.equal(image.height, 20);
	assert.deepEqual([...image.rgba.slice(0, 4)], [255, 0, 0, 255]);
	const right = (5 * 40 + 30) * 4;
	assert.deepEqual([...image.rgba.slice(right, right + 4)], [0, 0, 255, 255]);
	assert.equal(decodePng(Buffer.from("not a png")), undefined);
});

test("thumbnails are truecolor half-blocks that keep the picture", () => {
	const rows = renderThumbnail(decodePng(SPLIT_PNG), 20, 6);
	assert.equal(rows.length, 5); // 40x20 → 20 columns × 10 pixels → 5 rows
	for (const row of rows) assert.equal(visibleWidth(row), 20);
	assert.match(rows[0], /^\x1b\[38;2;255;0;0m\x1b\[48;2;255;0;0m▀/);
	assert.match(rows[0], /\x1b\[38;2;0;0;255m\x1b\[48;2;0;0;255m▀\x1b\[0m$/);
});

test("token numbering never collides: max existing + 1", () => {
	const store = new AttachmentStore();
	assert.equal(store.nextToken(""), "[Image 1]");
	assert.equal(store.nextToken("[Image 1]"), "[Image 2]");
	assert.equal(store.nextToken("deleted [Image 1], kept [Image 2]"), "[Image 3]");
});

test("submitting consumes the images whose tokens are in the text", () => {
	const store = new AttachmentStore();
	const handlers = new Map();
	install({ on: (event, handler) => handlers.set(event, handler) }, { store });
	store.add("[Image 1]", { type: "image", data: SPLIT_B64, mimeType: "image/png" });
	store.add("[Image 2]", { type: "image", data: SPLIT_B64, mimeType: "image/png" });

	const input = handlers.get("input");
	assert.equal(input({ type: "input", text: "no tokens", source: "interactive" }), undefined);
	assert.equal(input({ type: "input", text: "[Image 1]", source: "rpc" }), undefined);
	const result = input({ type: "input", text: "compare [Image 2] with [Image 1]", source: "interactive" });
	assert.equal(result.action, "transform");
	assert.equal(result.text, "compare [Image 2] with [Image 1]");
	assert.equal(result.images.length, 2);
	assert.deepEqual(result.images[0], { type: "image", data: SPLIT_B64, mimeType: "image/png" });
	// Consumed: the same text cannot attach them twice.
	assert.equal(input({ type: "input", text: "[Image 1] [Image 2]", source: "interactive" }), undefined);
});

test("the strip shows thumbnails side by side and fits narrow widths", () => {
	const store = new AttachmentStore();
	store.add("[Image 1]", { type: "image", data: SPLIT_B64, mimeType: "image/png" });
	store.add("[Image 2]", { type: "image", data: SPLIT_B64, mimeType: "image/png" });
	let text = "look [Image 1] and [Image 2]";
	const strip = new ThumbnailStrip(store, () => text, (s) => s);

	const wide = strip.render(80);
	assert.equal(wide.length, 6); // 5 thumbnail rows + label row
	assert.match(wide.at(-1), /\[Image 1\].*\[Image 2\]/);
	for (const width of [80, 30, 12, 5]) {
		for (const line of strip.render(width)) assert.ok(visibleWidth(line) <= width, `row exceeds ${width}`);
	}
	assert.doesNotMatch(strip.render(30).at(-1), /\[Image 1\]/, "narrow strip keeps the newest");

	text = "only [Image 2]";
	assert.doesNotMatch(strip.render(80).at(-1), /\[Image 1\]/);
	text = "";
	assert.deepEqual(strip.render(80), []);
});

test("an empty bracketed paste is consumed and pastes the clipboard image", onWindows, async () => {
	await putImageOnClipboard();
	const ui = fakeUI();
	const store = new AttachmentStore();
	const detach = installPaste(ui, store);

	assert.deepEqual(ui.listener("\x1b[200~\x1b[201~"), { consume: true });
	await waitFor(() => ui.widgets.has("pi-image"), "thumbnail widget should appear");
	assert.equal(ui.editorText, "[Image 1] ");
	assert.deepEqual(ui.notices, []);

	const strip = ui.widgets.get("pi-image").render(100);
	assert.ok(strip.length >= 2);
	assert.match(strip[0], /\x1b\[38;2;46;139;87m/, "thumbnail carries the image's color");

	// Ordinary keys pass through; once the token is gone the strip closes.
	assert.equal(ui.listener("a"), undefined);
	ui.editorText = "";
	ui.listener("\x7f");
	await waitFor(() => !ui.widgets.has("pi-image"), "strip should close with its token");
	detach();
	assert.equal(ui.listener, undefined);
});

test("Alt+V pastes too, and a large screenshot survives the clipboard read", onWindows, async () => {
	await putImageOnClipboard();
	const ui = fakeUI();
	const store = new AttachmentStore();
	installPaste(ui, store);

	assert.deepEqual(ui.listener("\x1bv"), { consume: true });
	await waitFor(() => ui.editorText === "[Image 1] ", "Alt+V should insert the token");
	const [image] = store.consume(ui.editorText);
	assert.equal(image.mimeType, "image/png");
	assert.equal(decodePng(Buffer.from(image.data, "base64")).width, 1920);
});

test("text on the clipboard pastes as text", onWindows, async () => {
	await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -Value 'héllo | world'"], {
		timeout: 15_000,
		windowsHide: true,
	});
	const ui = fakeUI();
	installPaste(ui, new AttachmentStore());
	ui.listener("\x1bv");
	await waitFor(() => ui.editorText.length > 0, "text should be pasted");
	assert.equal(ui.editorText, "héllo | world");
});
