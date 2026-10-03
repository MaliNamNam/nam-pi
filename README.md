# Nam-pi

Collection of extensions for the [pi coding agent](https://github.com/badlogic/pi-mono), maintained by [@MaliNamNam](https://github.com/MaliNamNam).

Loaded from `~/.pi/agent/extensions`.

## Contents

| Path | Type | Description |
|------|------|-------------|
| `agents/` | package | Subagent extension — spawn child pi sessions (`::explore`, `@agent`, parallel work) |
| `safeguards/` | package | Safety extension — destructive-command confirm gates and allowlists |
| `pi-side-panel/` | package | Side panel — themes, extensions and tooling for a dockable panel |
| `mac-terminal-frame.ts` | single-file | Renders file/search tool calls in a macOS Terminal.app–style frame |
| `pi-models.ts` | single-file | Model/provider config from `pi.jsonc` (local `pi-models.ts` extension) |
| `pi-splash.ts` | single-file | Splash screen while pi starts up |
| `quiet-chrome.ts` | single-file | Trims pi's default TUI chrome for a quieter UI |

## Install

Copy (or symlink) these into your pi extensions directory:

```sh
cp -r . ~/.pi/agent/extensions/
```

Then restart pi. No global config edits needed — pi auto-loads everything in that folder.

## Notes

- Each package extension has its own `README.md` with details.
- `node_modules/` is gitignored; run `npm install` inside `agents/`, `safeguards/` and `pi-side-panel/` as needed.
