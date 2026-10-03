/**
 * Quiet UI chrome.
 *
 * Three pieces of Pi's built-in UI are redundant or misplaced in this setup, so
 * this extension adjusts all three:
 *
 * 1. **Thinking-level notices.** Pi's `cycleThinkingLevel()` (Shift+Tab) and
 *    `/thinking <level>` print "Thinking level: <level>" into the chat
 *    transcript via `InteractiveMode.showStatus()`. The footer already shows the
 *    level, so the notice is noise.
 *
 * 2. **The working row.** While streaming, Pi renders a `⠋ Working` loader row
 *    above the editor. The side panel's own box reports the same state in fine
 *    dot lettering, so the built-in row is a duplicate that costs transcript
 *    space. `ctx.ui.setWorkingVisible(false)` is the documented way to hide it.
 *
 * 3. **Update notices.** The "Update Available" box (and the package-update
 *    box) are appended by `showNewVersionNotification()` /
 *    `showPackageUpdateNotification()` to the chat container, which renders
 *    below the header — under the splash screen's π on a fresh screen. The
 *    wrappers move the components Pi just created to the very top of the header
 *    area instead, so the box appears above the symbol, in Pi's own drawing.
 *
 * The first needs a prototype patch; the other two need different mechanisms:
 *
 * - `showStatus()` has no hook to suppress it, and `registerShortcut` cannot
 *   shadow Shift+Tab because `app.thinking.cycle` is reserved from extension
 *   override. What works: load the running CLI's own bundle chunk and wrap
 *   `InteractiveMode.prototype.showStatus`, dropping only the thinking-level
 *   notice. Because that import resolves to the exact class instance the CLI
 *   runs (verified), the patch applies to the live UI. Every other status
 *   message passes through untouched.
 *
 * - `setWorkingVisible()` is public API, so no patch is needed. It does have to
 *   be reapplied: `resetExtensionUI()` restores `workingVisible = true`, and it
 *   runs before every session replacement and before `/reload`. Hooking
 *   `session_start` covers all of those, since Pi emits it with reason
 *   "startup", "new", "resume", "fork", or "reload" each time.
 *
 * Hiding the working row only clears the indicator of kind "working". Retry,
 * compaction, and branch-summary indicators render through `showStatusIndicator`
 * directly and are unaffected, so a retry countdown still appears.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Matches the notices this extension removes: "Thinking level: X". */
const SUPPRESSED = /^Thinking level:\s/i;

/**
 * Locate the bundle chunk the running CLI actually loaded.
 *
 * `dist/bundle/cli-runtime.js` imports exactly one `./chunks/*.js`, so following
 * that import keeps working across versions even though the hash in the filename
 * changes. Returns undefined for unbundled/dev installs, where patching is skipped.
 */
function findRuntimeChunk(): string | undefined {
	try {
		const bundleDir = path.join(getPackageDir(), "dist", "bundle");
		const runtimePath = path.join(bundleDir, "cli-runtime.js");
		if (!fs.existsSync(runtimePath)) return undefined;

		const source = fs.readFileSync(runtimePath, "utf8");
		const match = /from\s*["']\.\/(chunks\/[^"']+\.js)["']/.exec(source);
		if (!match) return undefined;

		const chunkPath = path.join(bundleDir, match[1]);
		return fs.existsSync(chunkPath) ? chunkPath : undefined;
	} catch {
		return undefined;
	}
}

/** Just the part of the container API the relocation needs; duck-typed on purpose. */
interface ChildHost {
	children: unknown[];
}

/** The part of `InteractiveMode` this extension patches or reads. */
interface InteractiveModeProto {
	showStatus(message: string): void;
	showNewVersionNotification(release: unknown): void;
	showPackageUpdateNotification(packages: unknown): void;
	chatContainer?: ChildHost;
	headerContainer?: ChildHost;
	__quietUi?: boolean;
}

/**
 * Move the components Pi appended to the chat container since `baseline` to the
 * top of the header container, keeping their order. Pi adds the update-notice
 * components one by one, so this lifts the whole box above the header content
 * while leaving the borders and theming of the notice exactly as Pi drew it.
 */
function hoistToHeaderTop(mode: InteractiveModeProto, baseline: number): void {
	const chat = mode.chatContainer;
	const header = mode.headerContainer;
	if (!chat || !header || !Array.isArray(chat.children) || !Array.isArray(header.children)) return;
	if (chat.children.length <= baseline) return;

	const appended = chat.children.splice(baseline);
	// Prepend in reverse so the first-appended component ends up topmost.
	for (let index = appended.length - 1; index >= 0; index -= 1) {
		header.children.unshift(appended[index]);
	}
}

/** Wrap one of the update-notice methods so its components land above the header. */
function hoistNotice<K extends "showNewVersionNotification" | "showPackageUpdateNotification">(
	prototype: InteractiveModeProto,
	name: K,
): void {
	const original = prototype[name] as (this: InteractiveModeProto, ...args: never[]) => void;
	prototype[name] = function (this: InteractiveModeProto, ...args: never[]) {
		const baseline = this.chatContainer?.children.length ?? 0;
		const result = original.apply(this, args);
		try {
			hoistToHeaderTop(this, baseline);
		} catch {
			// A future layout change should leave the notice where Pi put it.
		}
		return result;
	} as InteractiveModeProto[K];
}

export default function (pi: ExtensionAPI) {
	// The chunk is an ESM module, so patch asynchronously and let startup proceed.
	void (async () => {
		const chunkPath = findRuntimeChunk();
		if (!chunkPath) return;

		let module: { InteractiveMode?: { prototype: InteractiveModeProto } };
		try {
			// Import via the package's own module graph so this resolves to the
			// same class instance the CLI is running.
			module = (await import(pathToFileURL(chunkPath).href)) as {
				InteractiveMode?: { prototype: InteractiveModeProto };
			};
			if (!module.InteractiveMode) return;
		} catch {
			// A future layout change should not break startup; just skip the patch.
			return;
		}

		const prototype = module.InteractiveMode.prototype;
		if (prototype.__quietUi) return; // already patched (e.g. after /reload)

		const originalShowStatus = prototype.showStatus;
		prototype.showStatus = function (this: unknown, message: string) {
			if (typeof message === "string" && SUPPRESSED.test(message)) return;
			return originalShowStatus.call(this, message);
		};

		hoistNotice(prototype, "showNewVersionNotification");
		hoistNotice(prototype, "showPackageUpdateNotification");

		prototype.__quietUi = true;
	})();

	// Reapplied on every session_start, because resetExtensionUI() restores the
	// default before each session replacement and each /reload.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWorkingVisible(false);
	});
}
