# pi-side-panel

A collapsible dashboard that docks to the right edge of Pi's terminal UI.

```
┌──────────────────────────────┬──────────────────────┐
│  ██▌  ██▌ Pi Agent v1.0.0    │─ Summary ────────────│
│ ████████████ grok-4.6        │                      │
│   ██    ██ ~/GitHub/project  │ Files Changed        │
│   ██    ██                   │   src/main.ts        │
│   ██    ██                   │                      │
│                              │ Last Turn            │
│  ● Side panel on             │   6 inspected        │
│                              │   10 edited          │
│  …transcript…                │   19 ran             │
│                              │─ Resources ──────────│
│                              │ 12 extensions        │
│                              │ 1 skill              │
│                              │ 0 MCPs               │
│                              │ 9 tools              │
│                              │──────────────────────│
│                              │ Context              │
│                              │   12.4k tokens · 6%  │
│                              │   CH 82.3%           │
│                              │   $0.03              │
│                              │──────────────────────│
│                              │ Subagents · 1 running│
│                              │  ● explore: scan deps│
│                              │                      │
│                              ╰──────────────────────╯
│                              │╭────────────────────╮│
│  ╭──────────────────────────┐││       Working       ││
│  │ ❯ _                      │││                    ││
│  ╰──────────────────────────┘│╰────────────────────╯│
│  project / pi-1.0.0          │                      │
└──────────────────────────────┴──────────────────────┘
        ↑ footer               ↑ status indicator
```

## Sections

| Section | Contents |
|---|---|
| **Summary** | Files changed this turn, and a read-only summary of the previous turn's tool activity. |
| **Resources** | Extension, skill, MCP, and tool counts; click a count to toggle them on or off. |
| **Context** | Context tokens, percent of the window used, cache hit rate, session cost, and output tokens per second. |
| **Subagents** | Always shown. Live, verified descendant sessions; click a row to view its transcript. |

`/side-panel` hides the whole panel; no section opts out of the toggle. Each
section is separated by a rule. Context takes its rows first when the panel is
short, because the usage figures are the reason the panel exists; the sections
above it shrink before it does. Subagents is next in line, since it is the one
section that reports live work.

### Context

Context renders its facts grouped by topic, one group per line, the same way
Last Turn does:

```
Context
   12.4k tokens · 6%
   CH 82.3%
   $0.03 · 1,234 tokens/sec
```

The cache hit line is omitted before any request reports usage, and the token
rate is omitted until a turn has produced enough output to measure one, so spend
stands alone rather than printing a placeholder.

### The status box

Below the sections sits a box that holds the **status indicator**: the working
vocabulary while a turn is in flight, and the idle vocabulary once it settles.
It is never blank. There is no spinner.

The font is the classic Adafruit GFX 5×7 alphabet, rendered with fine Braille
dots rather than chunky solid blocks. Each Braille cell holds 2×4 dots, so both
uppercase and lowercase lettering (including descenders) fit the normal two-row
interior. Only the word is drawn and centred, without trailing dots. Its casing
and the spotlight brightness animation are retained. Letter strokes gain an
adjacent dot column for extra weight, and dot lettering is bold throughout the
sweep. Inter-letter gaps are preserved. If the heavier strokes cannot fit, the
renderer tries intact thinner dot lettering, then condensed dots, before
falling back to ordinary text. Blank padding and the plain-text fallback keep
their original styling.

Each label scales uniformly to fit, without stretching short words across the
box. The lettering is centred, with a one-cell margin on either side. Layout is
recalculated when the word or box size changes.

Words too wide for native-size dots are condensed horizontally — dot columns
merge, letter by letter, never the blank column between letters — so a long
verb like `Discombobulating` keeps the dotted font at the panel's narrow
default width instead of falling back to plain text. Every letter keeps at
least two dot columns, so narrow letters stay narrow rather than being
inflated. Only when even condensed dots cannot fit (a one-row box, or a box
so narrow that a letter would collapse to a single dot column) does the
original centred terminal text return, and only when even that cannot fit is
it clipped, without appending trailing dots. Unicode is measured in terminal
columns, not JavaScript string length.

A monochrome spotlight sweeps the lettering — beams search the word, converge on
its centre, then expand until it is fully lit, and the cycle repeats with the
next verb. It is adapted from terminaltexteffects' Spotlights effect, minus the
colour gradient: brightness is a four-step ramp over the theme's own `dim`,
`muted`, and `text` tokens, with the brightest step emboldened. The unlit floor
is the dimmest step rather than nothing, so the word stays visible on a light or
dark background.

The verb list is Claude Code style: `Working`, `Discombobulating`, `Percolating`,
`Cogitating`, `Hornswoggling`, and 45 more. Longer words do not rely on the sizing
chosen for `Working`. The idle list matches it in spirit — `Idling`, `Sleeping`,
`Dozing`, `Snoozing`, `Hibernating`, and more — so the box says which state the
agent is in while keeping the same lettering and sweep.

The frame is drawn whether or not the agent is working, so the space stays
reserved at the bottom of the panel, and the box animates in both states so a
settled panel still reads as alive. The timer is armed only while the panel is
visible; a hidden panel, or a child pane whose sidebar is not on screen, stops
the sweep entirely.

While a turn is in flight, a white light rides the box's border: one bright
head cell — the theme's brightest text token, emboldened — travels clockwise
along the frame with a short fading tail, wrapping corner to corner. The lap
starts from the bottom-right corner with each turn, and its length is the
box's own perimeter, so the light conforms to whatever it is drawn on. Once
the agent settles, the border returns to its ordinary chrome tone and stands
still: a glance tells a busy box from a resting one by whether its frame is
lit.

### Summary collapses when Last Turn is empty

Last Turn is sized to its content. With no tool activity the section is omitted
entirely rather than printing a `No tool activity` placeholder, so the rule below
Summary lands directly under Files Changed instead of leaving a gap the stats
never fill. Once a turn has activity, the heading and its rows appear and the
rule follows the last one. The slot budget in `workspace-layout.ts` is computed
from the same condition, so the block's height and its rendered rows cannot
disagree.

### Resources and the toggle widget

Resources lists four clickable counts:

```
Resources
   12 extensions
   1 skill
   0 MCPs
   9 tools
```

Clicking a count opens that kind's **toggle widget** in the section's place — the
counts are replaced rather than sitting above the list, so the two never compete
for the same rows:

```
Resources · extensions
› [x] agents  user
  [x] pi-models  user
  [ ] mcp  builtin
  [x] local  project
  space toggle · ←→ kind
```

| Key | Action |
|---|---|
| `Space` | Toggle the selected resource |
| `↑` `↓` | Move the selection (wraps) |
| `←` `→` | Switch between extensions, skills, MCPs, and tools (wraps) |
| `Enter` / `Esc` | Close the widget |

A click selects a row; clicking the selected row toggles it, and wheel-scrolling
moves the selection. The keys are claimed through `ctx.ui.onTerminalInput` only
while a widget is open, so `Space` and the arrows keep their normal editor
meaning the rest of the time. Child panes claim the same keys in `handleInput`
before forwarding to the page.

The list comes from Pi's own resource resolver, so it shows exactly what Pi would
load — including entries that are currently disabled. Toggling writes the same
files `pi config` writes:

- **Extensions and skills** — a `+path` / `-path` entry in the user
  `settings.json`, with any earlier pattern for that path replaced rather than
  appended.
- **MCP servers** — `enabled: false` in the user `mcp.json`, removed again when
  re-enabled. Other content in the file is preserved.
- **Tools** — a `+name` / `-name` entry in the user `defaultTools`, the same
  setting `--tools` overrides. Unlike the other kinds, the toggle also applies
  immediately through `setActiveTools()`, since a tool's active set is live
  session state; the saved entry is what restores the choice on the next start.

Rows that cannot be toggled are shown as such: `project` entries belong to a
project settings file this panel does not write, `extension` servers were
registered by another extension rather than a config file, and in the tools
widget the same logic applies to the tools themselves — extension tools are
re-registered (and re-activated) by their extension on every load, so toggling
the extension is the way to change them, MCP tools are governed by their server
row in the MCPs widget, and `hidden` tools cannot be activated at all.

The tool list itself comes from the session's registry — built-ins and
extension-registered tools alike — with the active set as the enabled state.

**Changes are saved, not applied.** Nothing reloads automatically: each toggle
reports `saved; run /reload to apply`, and the new state takes effect on the next
`/reload` or Pi start. The counts keep showing what is currently loaded, which is
why a disabled entry stays listed and reads `[ ]`.

`/side-panel extensions`, `/side-panel skills`, `/side-panel mcps`, and
`/side-panel tools` open a widget directly, showing the panel first if it was
hidden.

### Last Turn is read-only

Last Turn reports statistics — how the previous turn's tool calls broke down by
category, one line per category (inspected, edited, ran, delegated). Categories
with no activity are omitted, and the total is not shown because it is just the
sum of the lines below it. Its rows are not interactive: there is nothing to
expand, copy, or open, and clicking one does nothing. With no activity at all the
section does not appear.

The **file list is still interactive**: wheel-scroll to move through a list
longer than its pane, and click to select. Selecting no longer previews a diff,
so the click marks the row only.

Above the status box, the Summary, Resources, Context, and Subagents sections form a single
framed block that closes with its own bottom border; rows the sections do not use
stay blank.

The extension also replaces the header, the footer, and the editor:

- **Header** — Pi logo, version, model, working directory, panel state.
- **Editor** — a rounded border. Its bottom edge carries the status line:

  ```
  ╰ github / pi-1.0.0 (main) ────── codebuddy/deepseek-v4.1-flash · max ╯
  ```

  Project, Pi version, branch, model, and thinking level. The branch drops
  below 42 columns, and the model and thinking level drop below 66.

- **Footer** — carries *only* what the composer cannot, so the same facts are
  never rendered twice. It is empty when there is nothing to report.

### Subagents

Subagents now appear **below Context, separated by a rule**, not in the footer.
The section is **always on screen**: with nothing spawned it reads
`Subagents · 0 running` and `none`, so the panel's shape never changes as work
starts and finishes.

The paired `agents` extension publishes its authoritative, ownership-verified
family list through `pi.events`. This includes foreground work before its tool
returns, background completions/cancellations, resumed children and grandchildren.
There is no second list inferred from tool-result messages that can go stale.

- Click a child row to open its live transcript. Status icons distinguish running,
  completed, failed and cancelled work; wheel-scroll lists longer than five rows.
- Click the Subagents heading, press Down in an empty editor, or use `/agents view`
  to open the Subagents/Shell composer **inside the current rounded editor frame**.
  Left/Right, Up/Down, Enter, Ctrl+A (active/inactive), Ctrl+D (interrupt), and
  Ctrl+B (background foreground work) retain OpenCode v2's behavior. The heading
  only responds when something is listed: with no jobs the view would open empty,
  which is the same reason the empty-editor Down key is gated on `hasJobs`.
- Child pages use the same sidebar, rounded composer, theme and registered tool
  renderers as the root—including the custom macOS-style shell frames. The sidebar
  shows the child's own model/context/spend and successful write/edit paths, not
  the parent's. A separate ledger retains earlier spend/files beyond the bounded
  transcript preview. Unknown usage stays unset. Resources shows only the child's
  declared active tools, read-only; it never borrows root extension/skill/MCP counts.
  The root sidebar overlay and resource-widget input are suspended during inspection.
  Markdown transforms, padding/thinking defaults, and materialized root extension
  message/entry/tool renderers carry into native child message components.
- Child pages keep V2's always-open job composer instead of exposing a writable
  child chat editor. Click siblings/descendants in either list; Esc returns to the
  direct parent. The root draft and Pi session are never replaced.
- Hiding the panel also hides it on child pages. Narrow terminals keep the framed
  composer and keyboard controls, with no overlapping sidebar.

Mouse interaction requires Pi fullscreen mode (`pi --tui-mode fullscreen`).
Regular mode retains the keyboard controls and `/agents view <id>`.

The footer still carries other extensions' statuses, including the primary agent
and forms waiting at the root, but no duplicate subagent summary.

## Install

Try it for one invocation:

```bash
pi -e ./pi-side-panel
```

To load it in every session, copy the folder into the Pi agent extensions
directory, then run `/reload` or restart Pi:

```bash
# macOS / Linux
cp -r ./pi-side-panel ~/.pi/agent/extensions/

# Windows (PowerShell)
Copy-Item -Recurse .\pi-side-panel "$env:USERPROFILE\.pi\agent\extensions\"
```

## Usage

```
/side-panel
```

Toggles the panel. Everything in it, Context included, hides together.

## Notes

- The panel hides itself when the chat would drop below 40 columns.
- Requires interactive mode; the command reports a warning in other modes.
- Because it rewraps the layout root, it conflicts with other extensions that
  also replace Pi's layout or editor. pi-slate does the same, so run one or the
  other, not both.

## How the panel is mounted

Pi gives extensions no sidebar API, so the panel reserves real columns by
wrapping Pi's own layout root:

1. Pi renders fullscreen mode through `tui.setLayoutRoot(root)`, where `root` is
   a `VStack` of the transcript and the input dock.
2. The extension replaces `tui.setLayoutRoot` with a wrapper that rewraps every
   root Pi installs in an `HStack` of `[chat, panel]`. Pi keeps calling its own
   method and stays unaware of the extra column.
3. The panel's width is refreshed each frame from its `visible` callback, so
   resizing needs no remount.

This is the same technique
[pi-slate](https://github.com/GaganSD/pi-extensions/tree/main/pi-slate) uses.

**Regular mode has no layout root.** `TuiMainScreen` leaves scrollback to the
terminal, so there is nothing to split. The panel then falls back to a
non-capturing overlay anchored to the right edge, which draws over the
transcript instead of shrinking it. The status box at the bottom keeps the same
fallback. The editor keeps keyboard focus either way.

## Notes

- The panel hides itself when the chat would drop below 40 columns.
- Requires interactive mode; the command reports a warning in other modes.
- Because it rewraps the layout root, it conflicts with other extensions that
  also replace Pi's layout or editor. pi-slate does the same, so run one or the
  other, not both.

## Development

```bash
npm run setup       # link the host Pi packages into node_modules
npm run typecheck   # tsc against the real Pi type definitions
npm test            # entry-point and sidebar tests
npm run test:agents # paired agents + sidebar regression fixtures (repos side by side)
```

`npm run setup` symlinks `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
and `@types/node` from your Pi installation, so the extension is checked against
the exact API it runs on. The tests load the extension through `jiti` (Pi's own
loader) and assert that the sections render in order, every rendered line fits
its width, the Resources and Context counts refresh after a render, Last Turn
collapses when it is empty and pushes the divider down by exactly its rows when
it is not, the status box keeps its lettering in both the working and idle
states, lettering fits variable word lengths and box sizes, no spinner appears,
and the resource toggles round-trip through real settings files in a throwaway
agent directory.

`npm run test:installed` runs a smaller check against the deployed copy under
`~/.pi/agent/extensions/pi-side-panel`, which is what Pi actually loads — the
repo and the installed copy are separate, so a green repo suite does not prove
the running extension is current. The spotlight suite also covers the border
light: it starts at the bottom-right corner, wraps at the box's perimeter,
lights only frame cells, and goes dark the moment the agent settles.

## Layout

```
pi-side-panel/
├── extensions/
│   ├── side-panel.ts         the extension
│   ├── agents-ui.ts          framed agent composer and child workspace adapter
│   └── slate/
│       ├── sidebar.ts        the panel and its sections
│       ├── resources.ts      the resource catalog and its settings toggles
│       ├── sidebar-split.ts  the layout-root wrapper
│       └── …                 composer, dock, and layout helpers
├── scripts/
│   ├── link-host.mjs         links the host Pi packages
│   ├── sync-slate.mjs        copies the vendored pi-slate modules
│   ├── test-load.mjs         extension entry-point smoke test
│   ├── test-dock.mjs         section layout, facts, and line widths
│   ├── test-resources.mjs    resource listing and toggle round-trips
│   └── test-installed.mjs    checks the deployed copy under ~/.pi
├── package.json
└── tsconfig.json
```
