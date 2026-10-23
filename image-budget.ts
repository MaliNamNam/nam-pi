/**
 * Lossless outgoing PNG copies, then oldest-first image eviction for Factory.
 * Eviction notice/policy adapted from OpenCode V2's session/model-request.ts
 * at 40cc0f377bb30c35ad56bebfc57de83097e70995 (MIT; image-budget.LICENSE.opencode).
 * Unlike V2's 25 → 15 MiB image-only budget, bound the whole request to 4.3 MB
 * and stop as soon as it fits Factory's 4.5 MB gateway. Never edit saved history.
 */
import { getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";

// Leave headroom for the proxy's protocol translation; this is a byte budget,
// not a token/context limit. No provider other than Factory is changed.
const REQUEST_BUDGET = 4_300_000;
const CACHE_ENTRIES = 16;
export const IMAGE_REMOVED = "[This image was removed to reduce the request size and is no longer visible. Do not make claims about its contents from memory. If needed, retrieve it again with an available tool or ask the user to attach it again.]";
type Image = {
	get_width(): number;
	get_height(): number;
	get_raw_pixels(): Uint8Array;
	get_bytes_webp(): Uint8Array;
	free(): void;
};
let photon: { PhotonImage: { new_from_byteslice(bytes: Uint8Array): Image } } | undefined;

function staticPng(bytes: Buffer): boolean {
	if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes[24]! > 8) return false;
	for (let offset = 8; offset + 12 <= bytes.length;) {
		const size = bytes.readUInt32BE(offset);
		if (offset + size + 12 > bytes.length) return false;
		const type = bytes.toString("ascii", offset + 4, offset + 8);
		// Do not flatten animations or discard embedded ICC/orientation metadata.
		if (["acTL", "iCCP", "eXIf"].includes(type)) return false;
		if (type === "IEND") return true;
		offset += size + 12;
	}
	return false;
}

/** Return a smaller, pixel-verified WebP, never JPEG or a resized image. */
export function losslessPng(url: string): string | undefined {
	const prefix = "data:image/png;base64,";
	if (!url.startsWith(prefix)) return undefined;
	const bytes = Buffer.from(url.slice(prefix.length), "base64");
	if (!staticPng(bytes)) return undefined;
	// Reuse Pi's existing Rust/WASM encoder: no new package or external process.
	photon ??= createRequire(join(getPackageDir(), "package.json"))("@silvia-odwyer/photon-node");
	let original: Image | undefined;
	let decoded: Image | undefined;
	try {
		original = photon!.PhotonImage.new_from_byteslice(bytes);
		const encoded = Buffer.from(original.get_bytes_webp());
		if (encoded.length >= bytes.length) return undefined;
		decoded = photon!.PhotonImage.new_from_byteslice(encoded);
		if (decoded.get_width() !== original.get_width() || decoded.get_height() !== original.get_height()
			|| !Buffer.from(decoded.get_raw_pixels()).equals(Buffer.from(original.get_raw_pixels()))) return undefined;
		return `data:image/webp;base64,${encoded.toString("base64")}`;
	} catch { return undefined; }
	finally {
		decoded?.free();
		original?.free();
	}
}

type Payload = { messages?: Array<{ content?: string | Array<{ type?: string; text?: string; image_url?: { url?: string } }> }> };
const payloadBytes = (payload: unknown): number => Buffer.byteLength(JSON.stringify(payload), "utf8");

/** Modify only a detached provider payload, not Pi's stored message objects. */
export function preparePayload(payload: unknown, maxBytes = REQUEST_BUDGET, cache = new Map<string, string | undefined>()) {
	const beforeBytes = payloadBytes(payload);
	let afterBytes = beforeBytes;
	let changed = 0;
	let omitted = 0;
	if (beforeBytes <= maxBytes) return { payload, beforeBytes, afterBytes, changed, omitted };
	const copy = structuredClone(payload) as Payload;
	for (const message of copy.messages ?? []) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			const url = part.image_url?.url;
			if (part.type !== "image_url" || typeof url !== "string" || !url.startsWith("data:image/png;base64,")) continue;
			const key = createHash("sha256").update(url).digest("hex");
			if (!cache.has(key)) {
				cache.set(key, losslessPng(url));
				if (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
			}
			const candidate = cache.get(key);
			if (!candidate) continue;
			part.image_url!.url = candidate;
			changed++;
			afterBytes = payloadBytes(copy);
			if (afterBytes <= maxBytes) return { payload: copy, beforeBytes, afterBytes, changed, omitted };
		}
	}
	// OpenCode V2 replaces images oldest-first with an explicit visibility notice.
	// Keep remote URLs, all existing text, message order, and tool links untouched.
	for (const message of copy.messages ?? []) {
		if (!Array.isArray(message.content)) continue;
		for (const [index, part] of message.content.entries()) {
			const url = part.image_url?.url;
			if (part.type !== "image_url" || typeof url !== "string" || !/^data:image\/[^;,]+;base64,/i.test(url)) continue;
			message.content[index] = { type: "text", text: IMAGE_REMOVED };
			omitted++;
			afterBytes = payloadBytes(copy);
			if (afterBytes <= maxBytes) return { payload: copy, beforeBytes, afterBytes, changed, omitted };
		}
	}
	throw new Error(`Factory request is still too large after lossless compression and outgoing image eviction (${(afterBytes / 1e6).toFixed(2)} MB; budget ${(maxBytes / 1e6).toFixed(2)} MB). Conversation text and saved images are unchanged. Reduce non-image context or tool definitions.`);
}

export default function (pi: ExtensionAPI) {
	const cache = new Map<string, string | undefined>();
	pi.on("session_start", () => { cache.clear(); });
	pi.on("session_shutdown", () => { cache.clear(); });
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "factory" || ctx.model.api !== "openai-completions") return;
		try {
			const result = preparePayload(event.payload, REQUEST_BUDGET, cache);
			if (!result.changed && !result.omitted) return;
			const size = `${(result.beforeBytes / 1e6).toFixed(2)} → ${(result.afterBytes / 1e6).toFixed(2)} MB`;
			ctx.ui.notify(result.omitted
				? `Factory image budget: ${size}; ${result.omitted} older image(s) omitted from this request with visibility notices. Saved originals and remaining image quality are unchanged.`
				: `Factory images compressed losslessly: ${size}. Original dimensions and pixels preserved.`, result.omitted ? "warning" : "info");
			return result.payload;
		} catch (error) {
			// Pi reports hook exceptions but continues sending, so abort explicitly.
			ctx.abort();
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			throw error;
		}
	});
}
