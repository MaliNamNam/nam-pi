# Nam-pi

A personal extension suite for the [Pi coding agent](https://github.com/earendil-works/pi), maintained by [@MaliNamNam](https://github.com/MaliNamNam). It brings an [OpenCode v2](https://opencode.ai/docs)-style workflow to Pi: primary agents and subagents with permission rulesets, an approval layer for risky tool calls, a dockable dashboard, framed transcripts, and image handling that keeps oversized requests from failing.

Each extension is a standalone TypeScript file or package that Pi loads from `~/.pi/agent/extensions`. They work together but can be installed individually.

## Highlights

- **[`agents/`](agents/README.md)**: OpenCode v2's agent system on Pi. It provides Build/Plan primary agents and Explore/General subagents, foreground and background dispatch, optional Git-worktree isolation, live viewing of child sessions, and permission rulesets. Shell commands are checked per command with a vendored OpenCode shell scanner.
- **[`safeguards/`](safeguards/README.md)**: OpenCode's permission system, with `allow` / `ask` / `deny` on every tool call, **Allow once / Always allow / Reject** prompts, saved per-project grants, and doom-loop detection.
- **[`pi-side-panel/`](pi-side-panel/README.md)**: a collapsible right-hand dashboard showing files changed, last-turn activity, resource counts, context usage and cost, and running subagents.
- **`image-budget.ts`**: keeps image-heavy sessions under a provider's request-size limit. It first makes pixel-verified lossless WebP copies, then evicts the oldest images with an explicit notice. Saved history is never modified.

## Contents

| Path | Type | Description |
|------|------|-------------|
| `agents/` | package | Primary agents and subagents: `@explore` / `::explore` dispatch, background jobs, worktrees, permission rulesets |
| `safeguards/` | package | OpenCode-style permission prompts, allowlists and saved grants |
| `pi-side-panel/` | package | Dockable dashboard sidebar, composer frame and conversation frames |
| `mac-terminal-frame.ts` | single-file | Frames built-in and extension tool calls in a macOS Terminal.app–style window |
| `neutral-preamble.ts` | single-file | Removes Pi's default identity sentence from outgoing system prompts, preserving all other instructions |
| `pi-models.ts` | single-file | Registers custom providers and models from `<agent-dir>/pi.jsonc` |
| `pi-splash.ts` | single-file | A slowly turning 3D π as the startup header |
| `clean-copy.ts` | single-file | Strips conversation-frame chrome from mouse-selection copies in fullscreen mode |
| `quiet-chrome.ts` | single-file | Hides redundant built-in TUI notices and the duplicate working row |
| `pi-image.ts` | single-file | OpenCode-style image paste: Ctrl+V inserts an `[Image N]` chip with a thumbnail and attaches the image |
| `image-budget.ts` | single-file | Lossless PNG copies, then oldest-image eviction for oversized Factory requests; saved history remains untouched |

## Install

Requires Pi installed globally via npm (`npm install -g @earendil-works/pi-coding-agent`) and Node.js 22.19 or newer.

Copy the extensions you want into Pi's extensions directory, then run `/reload` or restart Pi:

```sh
mkdir -p ~/.pi/agent/extensions
cp -r agents safeguards pi-side-panel ~/.pi/agent/extensions/
cp *.ts image-budget.LICENSE.opencode ~/.pi/agent/extensions/
```

Pi loads top-level `.ts` files and directories with an `index.ts` or a `package.json` `pi` manifest. To try a single extension for one session, run `pi -e ./pi-splash.ts`.

`mac-terminal-frame.ts` leaves `read`, `edit` and `grep` to [`pi-hashline-edit-pro`](https://www.npmjs.com/package/pi-hashline-edit-pro); install it with `pi install npm:pi-hashline-edit-pro`, along with the other third-party packages below.

## Third-party extensions (npm)

Installed with Pi's package manager into `~/.pi/agent/npm` (`settings.json` → `packages`). They are referenced here, not vendored:

| Package | Source | Description |
|---------|--------|-------------|
| [`pi-hashline-edit-pro`](https://www.npmjs.com/package/pi-hashline-edit-pro) | [YuGiMob/pi-hashline-edit-pro](https://github.com/YuGiMob/pi-hashline-edit-pro) (MIT) | Hash-anchored `read` / `replace` / `insert` / `grep` tools with stable line anchors |
| [`@ssk_dev/pi-web-access-lean`](https://www.npmjs.com/package/@ssk_dev/pi-web-access-lean) | [kunkun9527/pi-web-access-lean](https://github.com/kunkun9527/pi-web-access-lean) (MIT) | Lean web access: search, URL fetching, PDF extraction, YouTube/video understanding |
| [`@sting8k/pi-vcc`](https://www.npmjs.com/package/@sting8k/pi-vcc) | [sting8k/pi-vcc](https://github.com/sting8k/pi-vcc) (MIT) | Algorithmic conversation compaction: transcript-preserving summaries, no LLM calls |

Also loaded in this setup but not part of this repo: `herdr-agent-state.ts`, the [herdr](https://github.com/herdrdev/herdr) (Apache-2.0) integration that reports Pi's session and working state to herdr panes. herdr generates and updates that file itself; install it with `herdr integration install pi`.

## Origins and attribution

| Extension | Origin |
|---|---|
| `agents/` | Own; adapted from [OpenCode v2](https://opencode.ai/docs/agents) (MIT, see `agents/LICENSE.opencode`) |
| `safeguards/` | Own; ports [OpenCode's permission system](https://opencode.ai/docs/permissions) (MIT, see `safeguards/LICENSE.opencode`) |
| `pi-side-panel/` | Own; built on pi-slate modules vendored into `extensions/slate/` ([pi-slate](https://github.com/GaganSD/pi-extensions/tree/main/pi-slate), MIT, see `pi-side-panel/LICENSE-pi-slate`) |
| `mac-terminal-frame.ts` | Own |
| `neutral-preamble.ts` | Own |
| `pi-models.ts` | Own |
| `pi-splash.ts` | Own; 3D renderer adapted from [mavam/pi-splash](https://github.com/mavam/pi-splash) (MIT) |
| `quiet-chrome.ts` | Own |
| `clean-copy.ts` | Own |
| `pi-image.ts` | Own; paste flow modeled on [OpenCode v2](https://opencode.ai/docs)'s TUI |
| `image-budget.ts` | Own; lossless WebP copies plus [OpenCode V2's oldest-image eviction](https://github.com/anomalyco/opencode/blob/40cc0f377bb30c35ad56bebfc57de83097e70995/packages/core/src/session/model-request.ts#L189-L216) (MIT, see `image-budget.LICENSE.opencode`) |

## Development

Root tests load each extension through Pi's own `jiti` loader. When Pi is installed globally, point them at its package directory:

```sh
export PI_TEST_PACKAGE_DIR="$(npm root -g)/@earendil-works/pi-coding-agent"
node --test test/*.test.mjs
```

The `agents/` package has its own suite and type check, which also cover `safeguards/`:

```sh
cd agents && npm install && npm run typecheck && npm test
```

`pi-side-panel/` has `npm install && npm run typecheck`; its behavioral tests are in the root suite.

## Design notes

- Each package extension has its own `README.md` with details.
- `mac-terminal-frame.ts` automatically frames extension tools, including late registrations and saved calls. Custom renderers and tool execution are preserved. Its guarded Pi UI hook runs only in TUI mode and warns if a Pi update makes it unavailable.
- Conversation frames: right-aligned user prompts (`👤`), left-aligned replies (`🤖`) and thoughts (`🧠`), with subtle opposite-side gutters matching the side panel's rounded border. `CONVERSATION_FRAME_EXTENSION_DIR` can point `test/conversation-frames.test.mjs` at an installed copy's `extensions/` directory.
- Neutral preamble: removes only the default identity, including on resumed requests; custom prompts, quoted source, and tool transitions remain intact.
- Clean copies: mouse drag-selection in fullscreen mode copies exactly what is on screen, and the conversation frames draw `│` chrome on every row, so `clean-copy.ts` wraps `TuiAltScreen.getActiveSelectionText` to strip border rows and edge cells (blockquote bars, table cells and `tree` markers survive).
- Image paste: `pi-image.ts` does not replace the editor (pi-side-panel and agents own it). A raw terminal-input listener catches Ctrl+V — which Windows Terminal delivers as an empty bracketed paste when the clipboard holds only an image — and Alt+V, reads the clipboard (copied files, then image, then text), and inserts through `ctx.ui.pasteToEditor`, so it works with whichever editor is active. An image inserts an `[Image N]` token and a truecolor half-block thumbnail strip above the editor. The token stays in the submitted text and the image is attached via the `input` event; deleting the token drops it. The clipboard test cases run on Windows only.
- Image budget: `image-budget.ts` handles Factory's OpenAI-compatible outgoing requests, including pasted images, tool-read images, and resumed history. Above 4.3 MB (headroom below the gateway's 4.5 MB limit), it first makes pixel-verified lossless WebP copies of eligible static PNGs using Pi's bundled Photon encoder. If that cannot fit, it replaces the oldest inline images with OpenCode V2's exact visibility notice, warning the model not to claim their contents and to retrieve or request them again when needed. Newest images are retained preferentially, with no JPEG recompression or resizing. Saved attachments, existing text, tools, message order, and other providers stay unchanged; remote image URLs are untouched. Processing stops once the whole request fits and runs again on every turn, including resumed sessions. This is V2's oldest-first policy adapted to Factory, not exact size/normalization parity: V2 evicts above 25 MiB of image data down to 15 MiB, and its per-image normalizer can resize and use JPEG. Animations, 16-bit PNGs, ICC/orientation-tagged images, and other formats are not converted but may be omitted when necessary. If non-image context still exceeds the budget, the request is explicitly aborted rather than truncating text. Requires Pi's Node/npm installation with its existing Photon dependency. Its tests include actual CLI eviction and request-blocking verification.
- Attribution for adapted third-party code is in each extension's license file or header comment.

## License

[MIT](LICENSE). Adapted third-party code keeps its original MIT license; see the attribution table above.
