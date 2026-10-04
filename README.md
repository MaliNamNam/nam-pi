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
| `pi-models.ts` | single-file | Model/provider config from `pi.jsonc` (local `pi-models.ts` extension) |
| `pi-splash.ts` | single-file | Splash screen while pi starts up |
| `quiet-chrome.ts` | single-file | Trims pi's default TUI chrome for a quieter UI |

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
| `pi-models.ts` | `pi-models.ts` | Own — loads models from `pi.jsonc` |
| `pi-splash.ts` | `pi-splash.ts` | Own — 3D renderer adapted from [mavam/pi-splash](https://github.com/mavam/pi-splash) (MIT) |
| `quiet-chrome.ts` | `quiet-chrome.ts` | Own |
| *(npm)* `@ssk_dev/pi-web-access-lean` | — | [kunkun9527/pi-web-access-lean](https://github.com/kunkun9527/pi-web-access-lean) (MIT) |
| *(npm)* `@sting8k/pi-vcc` | — | [sting8k/pi-vcc](https://github.com/sting8k/pi-vcc) (MIT) |

## Notes

- Each package extension has its own `README.md` with details.
- `mac-terminal-frame.ts` automatically frames extension tools, including late registrations and saved calls. Custom renderers and tool execution are preserved. Its guarded Pi UI hook runs only in TUI mode and warns if a Pi update makes it unavailable.
- Frame regression tests: `node --test test/mac-terminal-frame.test.mjs` (set `PI_TEST_PACKAGE_DIR` to Pi's package directory when Pi is installed globally).
- Prompt-budget tests: `node --test test/prompt-budget.test.mjs` (same `PI_TEST_PACKAGE_DIR` override). Checks compact agent-tool guidance while preserving tool availability and parameter contracts.
- `node_modules/` is gitignored; run `npm install` inside `agents/`, `safeguards/` and `pi-side-panel/` as needed.
- Third-party npm packages are pinned in `~/.pi/agent/settings.json` and live in `~/.pi/agent/npm/` — nothing from them is committed here.
- Attribution for adapted third-party code is in each extension's license file or header comment.
