# Nam-pi

Collection of extensions for the [pi coding agent](https://github.com/badlogic/pi-mono), maintained by [@MaliNamNam](https://github.com/MaliNamNam).

Loaded from `~/.pi/agent/extensions`.

## Contents

| Path | Type | Description |
|------|------|-------------|
| `agents/` | package | Subagent extension — spawn child pi sessions (`::explore`, `@agent`, parallel work) |
| `safeguards/` | package | Safety extension — destructive-command confirm gates and allowlists |
| `pi-side-panel/` | package | Side panel — themes, extensions and tooling for a dockable panel |
| `mac-terminal-frame.ts` | single-file | Frames built-in and extension tool calls in a macOS Terminal.app–style window |
| `neutral-preamble.ts` | single-file | Removes Pi's default identity sentence from outgoing system prompts, preserving all other instructions |
| `pi-models.ts` | single-file | Model/provider config from `pi.jsonc` (local `pi-models.ts` extension) |
| `pi-splash.ts` | single-file | Splash screen while pi starts up |
| `clean-copy.ts` | single-file | Strips conversation-frame chrome from mouse-selection copies in fullscreen mode |
| `quiet-chrome.ts` | single-file | Trims pi's default TUI chrome for a quieter UI |
| `pi-image.ts` | single-file | opencode-style image paste — Ctrl+V shows an `[Image N]` chip with a thumbnail and attaches the image to the message |
| `image-budget.ts` | single-file | Lossless PNG copies, then V2-style oldest-image eviction for oversized Factory requests; saved history remains untouched |

## Install

Copy (or symlink) these into your pi extensions directory:

```sh
cp -r . ~/.pi/agent/extensions/
```

Then restart pi. No global config edits needed — pi auto-loads everything in that folder.

## Third-party extensions (npm)

Installed via pi's package manager into `~/.pi/agent/npm` (`settings.json` → `packages`) — referenced here, not vendored:

| Package | Version | Source | Description |
|---------|---------|--------|-------------|
| [`@ssk_dev/pi-web-access-lean`](https://www.npmjs.com/package/@ssk_dev/pi-web-access-lean) | 0.35.1 | [kunkun9527/pi-web-access-lean](https://github.com/kunkun9527/pi-web-access-lean) (MIT) | Lean web access: search, URL fetching, PDF extraction, YouTube/video understanding |
| [`@sting8k/pi-vcc`](https://www.npmjs.com/package/@sting8k/pi-vcc) | 0.8.1 | [sting8k/pi-vcc](https://github.com/sting8k/pi-vcc) (MIT) | Algorithmic conversation compaction — transcript-preserving summaries, no LLM calls |

## Full pi extension inventory

Everything the current setup loads, and where it lives in this repo:

| Extension in `~/.pi/agent/extensions` | In this repo | Origin |
|---|---|---|
| `agents/` | `agents/` | Own — adapted from [OpenCode v2](https://opencode.ai/docs/agents) (MIT, see `agents/LICENSE.opencode`) |
| `safeguards/` | `safeguards/` | Own — ports [OpenCode's permission system](https://opencode.ai/docs/permissions) (MIT, see `safeguards/LICENSE.opencode`) |
| `pi-side-panel/` | `pi-side-panel/` | Own — your dashboard, built on pi-slate modules vendored into `extensions/slate/` ([pi-slate](https://github.com/GaganSD/pi-extensions/tree/main/pi-slate), MIT, see `pi-side-panel/LICENSE-pi-slate`) |
| `mac-terminal-frame.ts` | `mac-terminal-frame.ts` | Own |
| `neutral-preamble.ts` | `neutral-preamble.ts` | Own |
| `pi-models.ts` | `pi-models.ts` | Own — loads models from `pi.jsonc` |
| `pi-splash.ts` | `pi-splash.ts` | Own — 3D renderer adapted from [mavam/pi-splash](https://github.com/mavam/pi-splash) (MIT) |
| `quiet-chrome.ts` | `quiet-chrome.ts` | Own |
| `clean-copy.ts` | `clean-copy.ts` | Own |
| `pi-image.ts` | `pi-image.ts` | Own — paste flow modeled on [OpenCode v2](https://opencode.ai/docs)'s TUI |
| `image-budget.ts` | `image-budget.ts` | Own — lossless WebP copies plus [OpenCode V2's oldest-image eviction](https://github.com/anomalyco/opencode/blob/40cc0f377bb30c35ad56bebfc57de83097e70995/packages/core/src/session/model-request.ts#L189-L216) (MIT, see `image-budget.LICENSE.opencode`) |
| *(npm)* `@ssk_dev/pi-web-access-lean` | — | [kunkun9527/pi-web-access-lean](https://github.com/kunkun9527/pi-web-access-lean) (MIT) |
| *(npm)* `@sting8k/pi-vcc` | — | [sting8k/pi-vcc](https://github.com/sting8k/pi-vcc) (MIT) |

## Notes

- Each package extension has its own `README.md` with details.
- `mac-terminal-frame.ts` automatically frames extension tools, including late registrations and saved calls. Custom renderers and tool execution are preserved. Its guarded Pi UI hook runs only in TUI mode and warns if a Pi update makes it unavailable.
- Frame regression tests: `node --test test/mac-terminal-frame.test.mjs` (set `PI_TEST_PACKAGE_DIR` to Pi's package directory when Pi is installed globally).
- Conversation frames: right-aligned user prompts (`👤`), left-aligned replies (`🤖`) and thoughts (`🧠`), with subtle opposite-side gutters matching the side panel's rounded border. Tests: `node --test test/conversation-frames.test.mjs` (same `PI_TEST_PACKAGE_DIR` override; `CONVERSATION_FRAME_EXTENSION_DIR` can point to an installed copy's `extensions/` directory).
- Prompt-budget tests: `node --test test/prompt-budget.test.mjs` (same `PI_TEST_PACKAGE_DIR` override). Checks compact agent-tool guidance while preserving tool availability and parameter contracts.
- Neutral-preamble tests: `node --test test/neutral-preamble.test.mjs` (same `PI_TEST_PACKAGE_DIR` override). Removes only the default identity, including on resumed requests; custom prompts, quoted source, and tool transitions remain intact.
- Clean copies: mouse drag-selection in fullscreen mode copies exactly what is on screen, and the conversation frames draw `│` chrome on every row, so `clean-copy.ts` wraps `TuiAltScreen.getActiveSelectionText` to strip border rows and edge cells (blockquote bars, table cells and `tree` markers survive). Tests: `node --test test/clean-copy.test.mjs` (same `PI_TEST_PACKAGE_DIR` override).
- Image paste: `pi-image.ts` does not replace the editor (pi-side-panel and agents own it). A raw terminal-input listener catches Ctrl+V — which Windows Terminal delivers as an empty bracketed paste when the clipboard holds only an image — and Alt+V, reads the clipboard (copied files, then image, then text), and inserts through `ctx.ui.pasteToEditor`, so it works with whichever editor is active. An image inserts an `[Image N]` token and a truecolor half-block thumbnail strip above the editor. The token stays in the submitted text and the image is attached via the `input` event; deleting the token drops it. Tests: `node --test test/pi-image.test.mjs` (same `PI_TEST_PACKAGE_DIR` override; the clipboard cases run on Windows only).
- Image budget: `image-budget.ts` handles Factory's OpenAI-compatible outgoing requests, including pasted images, tool-read images, and resumed history. Above 4.3 MB (headroom below the gateway's 4.5 MB limit), it first makes pixel-verified lossless WebP copies of eligible static PNGs using Pi's bundled Photon encoder. If that cannot fit, it replaces the oldest inline images with OpenCode V2's exact visibility notice, warning the model not to claim their contents and to retrieve or request them again when needed. Newest images are retained preferentially, with no JPEG recompression or resizing. Saved attachments, existing text, tools, message order, and other providers stay unchanged; remote image URLs are untouched. Processing stops once the whole request fits and runs again on every turn, including resumed sessions. This is V2's oldest-first policy adapted to Factory, not exact size/normalization parity: V2 evicts above 25 MiB of image data down to 15 MiB, and its per-image normalizer can resize and use JPEG. Animations, 16-bit PNGs, ICC/orientation-tagged images, and other formats are not converted but may be omitted when necessary. If non-image context still exceeds the budget, the request is explicitly aborted rather than truncating text. Requires Pi's Node/npm installation with its existing Photon dependency. Tests: `node --test test/image-budget.test.mjs`, including actual CLI eviction and request-blocking verification.
- `node_modules/` is gitignored; run `npm install` inside `agents/`, `safeguards/` and `pi-side-panel/` as needed.
- Third-party npm packages are pinned in `~/.pi/agent/settings.json` and live in `~/.pi/agent/npm/` — nothing from them is committed here.
- Attribution for adapted third-party code is in each extension's license file or header comment.
