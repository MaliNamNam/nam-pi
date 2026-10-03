# Pi OpenCode Agents

Adapts [OpenCode v2's agent system](https://opencode.ai/docs/agents) to Pi: primary agents, subagents, foreground and background dispatch, session continuation, and permission rulesets. This is not an exact 1:1 implementation; see [Limits](#limits) and the [source-backed non-UI parity audit](docs/core-parity-audit.md).

Build, General, and Explore are based on OpenCode v2's built-ins (`packages/core/src/plugin/agent.ts`); Pi-specific tool and directory rules mean they are not byte-for-byte identical.

## Install

```bash
mkdir -p ~/.pi/agent/extensions
cp -r pi-opencode-agents ~/.pi/agent/extensions/agents
```

## Built-in agents

| Agent | Mode | Tools | Prompt |
|---|---|---|---|
| `build` | primary | all | default |
| `plan` | primary | read/search; writes only under `<agent-dir>/plan` | Plan-mode reminder |
| `general` | subagent | all | — |
| `explore` | subagent | `read, grep, find, ls, webfetch, websearch` | "file search specialist" |
| `scout` | subagent | read-only + `git clone/fetch/log/show/diff` | "dependency research specialist" (experimental) |

`explore` and `general` follow OpenCode's permission shape: `explore` denies everything then allows its read-only tools, `general` denies `question` and nested `subagent` calls.

One deliberate addition: OpenCode v2 has **no separate list tool** — its `read` accepts "File or directory to read" and lists directory entries. Pi splits that into `read` (files only; `EISDIR` on a directory) and `ls`, so the built-in rulesets also grant `list`. Without it, `explore` would be offered `ls` and then denied it.

**Scout is marked experimental** because OpenCode v2 documents it but ships no implementation: there is no entry in `plugin/agent.ts`, no `scout` key in the config schema, and no source file for it. The description and permission shape here follow the documented behavior. It is gated behind `OPENCODE_EXPERIMENTAL_SCOUT`, mirroring OpenCode's own default of off:

```bash
OPENCODE_EXPERIMENTAL_SCOUT=1 pi     # or --agent-experimental
```

## Usage

```bash
@explore find where auth tokens are validated     # invoke a subagent directly
/agents                                           # open normal OpenCode-style composer (TUI); list agents (RPC)
/agent plan                                       # switch the primary agent
/agents sessions                                  # list this conversation's child sessions
/agents view                                      # open the Subagents/Shell composer
/agents view <sessionID>                          # view that child's live transcript page
/agents background                                # move existing foreground work to the background
/agents migrate                                   # hide older owned child sessions from /resume
/agents running                                   # list running background subagents
/agents cancel <sessionID>                       # stop a background subagent
```

The model dispatches subagents through the `subagent` tool, whose parameters match OpenCode's exactly:

| Parameter | Meaning |
|---|---|
| `agent` | Which subagent to run |
| `description` | Short 3-5 word label |
| `prompt` | The task |
| `model` | `providerID/modelID` or `providerID/modelID#variant` |
| `sessionID` | Continue a settled child, or admit input to its existing live run |
| `background` | Run asynchronously and return immediately |

Typing `@` offers an autocomplete menu of available subagents, matching OpenCode.

`@name` works when the prompt is typed in the editor or sent over RPC. Pi expands `@file` arguments **only** on the command line, so a shell invocation needs the `::name` alias instead:

```bash
pi "@explore find the auth code"      # @ is read as a file argument -> error
pi "::explore find the auth code"     # works
```

Both spellings are accepted and both appear in autocomplete.

## Normal OpenCode TUI

The UI target is normal OpenCode v2, **not `opencode mini`**. The composer is based on `packages/tui/src/routes/session/composer/{index,subagents-tab,shell-tab}.tsx`, with a left border, Subagents/Shell tabs, at most five job rows, a highlighted selection, and the original labels/shortcuts:

- Click `↓ 1 subagent` by the editor, or press Down with an empty editor, to open the composer in place (no floating picker).
- Left/Right switch Subagents/Shell. Up/Down select a job; Up on the first row closes the panel.
- The Shell tab lists this session's running model-issued Bash/PowerShell calls. Enter opens live output with Running, Exited (and the native exit code), Timed out or Killed status; Ctrl+D kills only the selected command, not its agent or other shells. Esc returns from output to the composer.
- Ctrl+A toggles active/inactive children. Ctrl+D interrupts the selected running child, not its whole parent turn.
- Enter/click a job row opens that child's live transcript page using Pi's native user-message, assistant Markdown/thinking, and tool-execution components. The inline `General Subagent — task · Model` delegation row opens the same page. Tool arguments/results retain their normal Pi presentation; Ctrl+O expands tools and Ctrl+T toggles thinking.
- Esc returns without discarding the parent's draft. Ctrl+B transfers foreground children to the background without starting a duplicate.

Child pages replace the chat editor with an always-open Subagents/Shell composer, matching V2's child-page layout. The Subagents tab lists the root's full verified descendant tree on every child page, with V2's nested prefixes and recently updated siblings first. The current child is highlighted when it belongs to the active/inactive filter; Up/Down select rows, Enter opens any listed descendant, Ctrl+A toggles active/inactive children, and Ctrl+D interrupts the selected running child. Esc, Ctrl+C or Up from the first row returns to that child's direct parent, not the previously visited page. PgUp/PgDn and Home/End scroll the transcript; Ctrl+O/Ctrl+T still control native tool/thinking presentation. The child's Shell tab shows only its own running model-issued Bash/PowerShell calls. Enter previews output and Ctrl+D kills that command through its live owner, including grandchildren, without stopping the child or its ancestors. Finished commands leave the running list, but an open output view keeps its final status/output. Opening a child or sibling does not switch Pi sessions or launch another process. Live discovery preserves selection by session ID or shell-run ID so new work does not change the interruption target.

`/agents sessions`, `/agents running` and `/agents view <id>` also include verified grandchildren. Nested interruption is cooperatively routed to the process holding that child's live handle; it never kills an ancestor or signals a PID from disk. Per-run nonces prevent stale requests from affecting a later continuation. Missing or unresponsive owners produce a warning rather than a guessed kill. Ownership and job record formats are unchanged, and background results still go only to the session that dispatched them. Continuation through the `subagent` tool remains restricted to its direct parent.

### Integration with pi-side-panel

When the paired `pi-side-panel` extension is loaded, the verified family list appears
below **Context**, behind a separator, instead of in the footer. Click a row to
inspect that child; click the section heading, press Down in an empty editor, or
run `/agents view` to open the same Subagents/Shell controls in the rounded Pi
composer. Foreground dispatch, completion, cancellation, restoration and nested
children all use the agents extension's live state rather than a second list built
from tool-result messages.

Child pages are wrapped in the current Pi workspace: sidebar, rounded composer,
active theme and registered root tool renderers (including shell frames). Their
context/model/cost facts and successful edit paths come from the viewed child,
with full-history accounting independent of the bounded preview. Child resource
counts are read-only and never borrow the root's extension/skill/MCP counts.
Markdown transforms, message padding and thinking defaults inherit the current
TUI; visible extension messages/entries retain their native renderers. The root
sidebar overlay is suspended while inspecting a child. See
[viewer behavior and compatibility limits](docs/subagent-viewing.md).
Navigation still preserves
the root draft, stays in the same Pi session and returns to each child's direct
parent. No agent subprocess is launched by inspection. The bridge in `src/ui.ts`
is presentation-only and session-scoped; without the side-panel extension the
original OpenCode-style composer/page remains available.

For mouse navigation use **`pi --tui-mode fullscreen`**; Pi's regular scrollback mode does not route transcript mouse clicks. Keyboard navigation works in both modes. The panel and child messages use the active Pi theme, not a replacement of the whole OpenCode application. The child page remains a live inspection view, without writing to the child's session file or adding a direct child chat editor (V2 also replaces that editor with its composer). Built-in tools use Pi's own renderers; registered custom tools inherit the root's rendering, with generic Pi rendering as a fallback. Server-style forms and the optional Terminals tab remain incomplete. Non-TUI/RPC clients still receive a plain-text transcript preview.

### Questions and permissions at the root

The `questionnaire` tool implements V2's model-facing question forms: `questions[{header, question, options[{label, description}], multiple?}]`. A custom-answer choice is added automatically; multiselect lets you toggle options and finish with **Done selecting**. Root, child and grandchild requests are answered through native Pi dialogs at the root, in regular/fullscreen TUI or RPC. Questions remain denied for General and Explore unless their configured permissions explicitly allow them.

Permission dialogs offer **Allow once**, **Always for this Pi session**, and **Reject**. Always remembers only the shown action/resource checks across the current root family, never overrides a hard deny, and is not offered for the `question` action alone. Configured policy and path permissions are rechecked after the reply. Reject or dismissing the dialog ends the **requesting execution**, matching V2's no-feedback rejection semantics. Pending permission/question waits in that same execution drain without another dialog. A child decline is reported as cancelled to its parent; it does not abort an unrelated sibling or the shared worker. A later user prompt starts a fresh execution. Configured hard denials, missing UI, transport failures, timeout and cancellation remain distinct and never masquerade as a user decline. Already-completed side effects are not undone. The feedback/correction editor is not implemented.

Only one form owns the root editor at a time; queued permissions take priority over queued questions. Opening child pages is disabled while a form is visible. If you are already inspecting a child, new forms wait at the root and the child page shows a notice; Esc returns one parent level at a time. No Pi session switch or second terminal is used, and the root draft is preserved. Requests expire after 60 seconds for permissions or five minutes for questions. Root/child cancellation, shutdown, stale routes, missing UI and unresponsive owners fail closed. Each call has a fresh reply ID; an Always grant is saved only after the live caller acknowledges it. The bridge's temporary nonce directory is removed on root shutdown. Like the shell tools themselves, this trusted same-machine file channel is not an OS sandbox.

### Paired safeguards

When the updated `safeguards` extension is also loaded, both contribute to one versioned permission preflight. Agent restrictions, safeguards rules and doom-loop checks are evaluated before a single root dialog; an approved headless child is not rejected by a second unattended prompt. Hard denies from either policy win, both policies are rechecked after approval, and each once reply is tied to the session, call ID and exact arguments. Extension load order does not matter. Safeguards remains usable alone, with its original dialogs and persistent project grants.

The combined root dialog's **Always for this Pi session** still grants only the displayed checks for that root lifetime. It does not invoke safeguards' broader persistent save patterns. `/safeguards allow` remains an explicit project-wide command.

## Foreground and background

**Foreground** (default) waits for a child Pi process while its event stream is recorded to a file. The normal TUI shows one inline delegation row; Ctrl+O expands diagnostic progress, and opening the child page shows live output. Ctrl+B releases the foreground wait and adopts the **same** process into the job registry, so the parent can handle other work while Pi remains open. Interrupting the child cancels only its foreground wait; the parent can continue after the tool failure. The final text comes back wrapped in OpenCode's envelope:

```xml
<subagent sessionID="sub-explore-..." state="completed">
...
</subagent>
```

**Background** (`background=true`) starts a child and returns immediately with a background notice. The composer count and its job list track foreground/background children; the child transcript page refreshes only when its output changes. After the parent has completed its first turn, a finished child is delivered as a `<subagent>` message to that same session. While idle, the extension checks for results every two seconds. **All children belong to their owning Pi session and stop on shutdown**, including quitting, reloading extensions or replacing the session. Backgrounding does not create an independent daemon:

```
The subagent is working in the background (sessionID: ...). You will be notified automatically when it finishes.
DO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; ...
```

Completed jobs from a prior process are collected after the first agent turn (not at session start, to avoid preempting the first user input). Work interrupted by shutdown is reported as cancelled, not revived on reopening. Delivery also runs after subsequent turns and during idle polling. A job is marked delivered only after Pi emits the completion's persisted `message_end`; on reopening, existing session entries suppress a duplicate if Pi closed between appending the message and marking the job. This improves durability but is not an exactly-once transaction. A completed job owned by another parent session stays pending until that session is reopened. Legacy jobs without an owner can be delivered in any session in the workspace.

### Stream responsiveness

Live viewers and background result collection consume append-only JSONL cursors instead of repeatedly reparsing growing logs. Catch-up reads yield between 64 KiB chunks so the root can keep handling input. The viewer reconstructs Pi 1's delta-only thinking, text, and tool arguments; a long reasoning turn no longer drops its earlier messages when the log exceeds 512 KiB. Display history is bounded to 300 entries and streaming text/thinking blocks to 32 KiB; incomplete records over 8 MiB are skipped with a notice.

Family discovery uses asynchronous, per-refresh claim/header indexes, and composer refreshes coalesce concurrent requests. The root form bridge verifies the family only when live requests exist, not on every idle heartbeat. The default subprocess backend still pays full per-child startup/memory costs; eligible foreground sessions can opt into the experimental shared worker below.

Large completed foreground results keep their full model-facing text once. Up to 65,536 UTF-16 code units, tool metadata retains `details.output`; larger results use a validated `details.outputRange` into the existing text content. Expanded rendering resolves that range even after session persistence, while legacy results remain readable. This reduces duplicate serialization without truncating the child's answer. See the [handoff profile and benchmark correction](docs/handoff-profile.md); RPC timings are not TUI latency measurements.

### Experimental shared SDK worker

The default remains `process`. To opt in on Pi 1.0+ under Node:

```bash
pi --agent-runner sdk
# or set PI_AGENT_RUNNER=sdk before starting Pi
```

Foreground agents whose final delegation rule denies all nested subagents (including the default General and Explore) can share one lazy SDK worker thread per owning Pi runtime. The loaded runtime code is reused, without allocating another Pi process per eligible child, and child processing stays off the root UI loop. Conversation history, model/provider registrations, settings, permissions, abort state and extension runtime remain private per session. Provider/config runtimes are intentionally not shared yet. Root forms and native transcript files use the existing protocols. Ctrl+B transfers the same SDK session to the background; cancelling it does not cancel siblings or follow the old parent signal.

Direct background dispatch, nested-capable agents, Bun, different-cwd sessions and custom per-child environment overrides retain the subprocess runner. Unsupported SDK startup falls back with a warning before a task prompt starts; failed/uncertain initialization after enqueue is not retried if that could duplicate work. Cancelled initialization cannot start a late prompt, and a session ID stays locked until its cleanup finishes.

**This is experimental, not an OS sandbox.** Extensions must be safe to instantiate concurrently in a shared process; arbitrary module-global extension state is not isolated. A single child uses cooperative cancellation—even SIGKILL cannot kill only one session in a shared worker. Owner shutdown first aborts sessions and cleans up native tools/MCP, with a seven-second thread-termination fallback for an unresponsive worker. A worker crash affects its SDK siblings and is reported rather than leaving jobs “running” against the root PID. Uncooperative/breakaway native processes may still escape abrupt termination. Keep the default subprocess backend where a hard process boundary is required.

## Session continuation

A follow-up to a **running, directly owned** child is admitted to that same run. `background=true` returns a notice after admission; foreground mode joins the existing child result. Ordered inputs enter at Pi's steering boundary after the current assistant/tool turn, not by interrupting completed side effects. The child retains its history and saved model unless a different agent or explicit model is selected; no duplicate runtime writes its transcript. Supported process/SDK children apply agent/model/prompt/permission changes at the next turn boundary, after the old tool batch finishes. Preparation must be explicitly acknowledged before the task is queued; only an applied child receipt changes parent metadata. A completed but undelivered background result must still be collected before a new generation starts. Missing/stale capabilities and uncertain acknowledgements fail closed without automatic replay.

Subprocess runs use a private RPC stdin/stdout channel and a file-backed observer log; SDK runs use their per-run worker capability. Neither is recovered from a saved PID. Unrelated RPC dialogs fail closed; paired permissions/questions still use the verified root form route. On Windows/Pi 1.0/Node 24, child RPC shutdown includes an idle handshake and 100 ms drain grace to avoid a reproduced native `UV_HANDLE_CLOSING` exit race; nonzero exits remain errors. The earlier scaling benchmark predates this subprocess transport change.

Passing `sessionID` continues an existing conversation, matching OpenCode:

```
subagent(agent="general", sessionID="sub-explore-abc", prompt="Now check the callers")
```

OpenCode v2 also creates a **separate child session**, but links it to its parent via `parentID` and displays it as a child in its TUI. Pi's child needs a separate context to preserve independent history, but previously stored the transcript beside normal sessions, cluttering `/resume`. New children now live below `<parent-session-dir>/.pi-subagents/<parent-key>/`, so Pi's ordinary `/resume` shows the parent while `/agents sessions` and `/agents view <id>` expose the children. Child processes use `windowsHide` to avoid opening transient Windows console windows.

The first call claims an ID in the nested child directory and creates the child with `pi --session-id`. Later calls verify the persisted owner **and** exact child session file; a live run uses its retained input capability, while a settled run resumes using `pi --session <verified-file>`. Older *owned* children from previous versions can still be continued; open their parent and run `/agents migrate` to move settled children out of `/resume`. Migration skips running or incomplete jobs. Sessions created before ownership tracking have no verifiable parent and cannot be migrated automatically; inspect or remove those manually through `/resume`. A session from another parent or an absent child file is rejected rather than silently created or adopted. Background continuations also use the verified file; changing agents updates the ownership record after dispatch.

For a new child, model precedence is explicit `model` argument → configured agent model → parent's currently selected Pi model. A continuation keeps its saved child model unless explicitly overridden or switched to an agent with its own model. Explicit model IDs and Pi-supported thinking variants are checked against Pi's available model catalog before dispatch.

## Configuration

Agents come from JSON or Markdown, using OpenCode's field names.

### JSON

```jsonc
// <agent-dir>/safeguards.json, <agent-dir>/pi.jsonc, <agent-dir>/settings.json
// or the project's .pi/ equivalents
{
  "agent": {
    "code-reviewer": {
      "description": "Reviews code for best practices and potential issues",
      "mode": "subagent",
      "model": "anthropic/claude-sonnet-4-20250514",
      "prompt": "You are a code reviewer. Focus on security, performance, and maintainability.",
      "permission": { "edit": "deny" },
      "steps": 8
    },
    "orchestrator": {
      "mode": "primary",
      "permission": { "task": { "*": "deny", "orchestrator-*": "allow" } }
    }
  }
}
```

### Markdown

The filename becomes the agent name, as in OpenCode:

```markdown
---
description: Reviews code for quality and best practices
mode: subagent
model: anthropic/claude-sonnet-4-20250514
permission:
  edit: deny
  bash:
    "*": ask
    "git diff": allow
    "git log*": allow
steps: 10
---

You are in code review mode. Focus on code quality and potential bugs.
```

Locations, lowest precedence first:

| Path | Scope |
|---|---|
| `~/.config/opencode/opencode.jsonc` (or `opencode.json`) | migration fallback, user |
| `<agent-dir>/settings.json`, `safeguards.json`, `pi.jsonc` | user; `pi.jsonc` wins among JSON files |
| `<agent-dir>/agents/*.md` | user Markdown |
| `<cwd>/.pi/settings.json`, `safeguards.json`, `pi.jsonc` | project (opt in) |
| `<cwd>/.pi/agents/*.md` | project Markdown (opt in) |

Every existing file is read. OpenCode's legacy config is a migration fallback; Pi's user `pi.jsonc` overlays it, and opted-in project config overlays user config. User Markdown can override user JSON; project JSON overrides user Markdown. Partial entries merge for custom agents as well as built-ins: omitted fields preserve earlier values, explicit false/empty text wins, and permission rules append in order. `disable: true` or `disabled: true` removes an earlier definition, including a built-in. Description-less agents remain available with fallback listing text. Native v2 structured config is still a compatibility subset; see the audit.

Project-local agents are **not** loaded by default, since they are repository-controlled prompts.

### Customizing a built-in

A config entry **customizes** the built-in of the same name rather than replacing it, matching OpenCode. Setting only a model keeps the built-in prompt, tools, and mode:

```jsonc
{
  "agent": {
    "explore": { "model": "codebuddy/deepseek-v4.1-flash", "variant": "max" }
  }
}
```

`explore` then runs on that model at `max` thinking, and still has only its read-only tools. Fields you omit keep their built-in values; permissions are unioned rather than replaced, so a partial override cannot drop a built-in guard.

### Options

| Field | Notes |
|---|---|
| `description` | Optional; missing/empty uses OpenCode's fallback listing text |
| `mode` | `primary`, `subagent`, or `all` (default) |
| `hidden` | Hide from listings; still dispatchable |
| `model` | `provider/model` or `provider/model#variant` |
| `prompt` / `system` | Replaces the system prompt |
| `permission` | OpenCode ruleset, last matching rule wins |
| `tools` | Deprecated in OpenCode; translated to permissions |
| `steps` / `maxSteps` | Max agentic iterations before tools are disabled |
| `disable` / `disabled` | Remove this agent, including an inherited/built-in definition |
| `variant` | OpenCode model variant, e.g. `"max"`; applies only with the agent's own `model` |
| `thinkingLevel` | Pi extension: default thinking level |
| `temperature` / `top_p` | Forwarded to the provider request if configured; unsupported providers may reject them |

`temperature` and `top_p` (including zero) are injected into outgoing provider requests. Other provider-specific options and `color` are not forwarded.

## Permissions

OpenCode rulesets are evaluated last-match-wins. `deny` on the `subagent` action removes that agent from the dispatchable list, exactly as OpenCode does:

```jsonc
"permission": { "task": { "*": "deny", "orchestrator-*": "allow", "code-reviewer": "ask" } }
```

OpenCode's permission keys map onto Pi's tools like this:

| OpenCode | Pi |
|---|---|
| `read` | `read` |
| `edit` | `edit`, `write` |
| `glob` | `find` |
| `grep` | `grep` |
| `list` | `ls` |
| `bash` | `bash`, `powershell` |
| `webfetch` / `websearch` | same |
| `question` | `questionnaire` |
| `subagent` (legacy `task`) | `subagent` |

Declared tools are filtered from the final merged permissions against Pi's actual active tool catalog, in both runners and primary agents. A whole-action deny hides the declaration; a scoped restriction keeps it available and is enforced **per call**. Later grants can reopen earlier denies, and custom tool-name wildcards are supported. Deprecated `tools` entries become rules before explicit `permission` entries; they are not a separate veto.

```yaml
permission:
  bash:
    "*": deny
    "echo *": allow        # blocks rm -rf, allows echo
```

The runtime loadout gates which tools are offered (`--no-tools` for an unreopened blanket deny); the user's selected tools remain the upper bound, and switching primaries restores that selected baseline, not every registered tool. See [the verified loadout checkpoint](docs/permission-loadouts.md). Mapped calls are checked against the ruleset and OpenCode's baseline `* allow`, `.env` ask, and external-directory ask rules. Permission asks from the whole verified family are routed to the root TUI/RPC; without that live root UI, subagents still fail closed. File/search calls check external directories, including symlink escapes and Pi path syntax. Unknown child tools require an explicit allow rule. Bash and PowerShell use OpenCode v2's vendored portable shell scanner: each command in a chain, pipeline, substitution or script block is checked individually, and a deny anywhere blocks the call. Operators inside quotes are literal, and redirects stay with their command. Like V2, shell external-directory checks cover directory changes (`cd`/`Set-Location`), not arbitrary arguments or every shell variable. Allowed compounds run as one original tool call; they do not need splitting. Unparseable syntax fails closed with a parsing reason. **This is not a shell sandbox:** code in an allowed shell command can still construct paths dynamically. For higher assurance, launch Pi with `--agent-strict-shell` (or `PI_AGENT_STRICT_SHELL=1`) to remove Bash and PowerShell from dispatched subagents; this trades General's shell capabilities for a narrower tool surface. Other explicitly permitted custom tools may still have side effects. Keep the safeguards extension enabled for additional checks.

### File-path rule normalization

`read`, `edit`/`write`, and `ls` rules are evaluated using normalized workspace-relative and absolute aliases. Pi's `@`, `~`, `file://`, Windows drive-path syntax, Unicode spaces, and read filename recovery are resolved before checks. Literal pattern prefixes are normalized without collapsing wildcard segments. Windows filesystem comparisons are case-insensitive and protect the base file behind an NTFS alternate stream.

Logical and physical (symlink/junction) targets are checked separately: a lexical alias allow cannot override a physical target deny. Missing write targets resolve through their existing ancestors, including dangling links. Cycles, ambiguous paths, and device/verbatim paths fail closed. This physical-target check is deliberately stricter than OpenCode's lexical file-access resolution. It is still a preflight check, not an OS sandbox or protection against a filesystem change between checking and using a path. Search queries/globs are not rewritten as file paths.

Hard denials on all parsed commands are checked before approval prompts, so approving one command cannot override a denial on another segment or nested command. The scanner and command-prefix logic are pinned to `anomalyco/opencode` V2 commit `0bef0eab678e94a389930a2a1365115fd5a35c69` (`packages/core/src/shell/{scan,parse}.ts`; MIT license in `LICENSE.opencode`).

## Max steps

When an agent's `steps` budget is spent, OpenCode appends `MAX_STEPS_PROMPT` and disables tools. Pi has no `toolChoice` override, so this extension injects the same prompt and blocks tool calls with OpenCode's exact message: `Tools are disabled after the maximum agent steps`. A new user prompt resets the budget; queued steering waits for its next turn before resetting.

## Limits

Remaining differences and implementation limits:

- **The form bridge covers permissions and model-facing questions, not the generic server form API.** Location-scoped global/MCP forms, conditional/numeric/external fields, tabbed review and form drafts are not implemented. Pi uses sequential native dialogs instead of V2's full form renderer. Explicit rejection/dismissal stops only the requesting execution and drains its pending forms; V2's rejection-feedback/correction editor remains absent.
- **Always approvals are session-local and exact-check scoped.** V2 saves requested patterns project-wide; this extension deliberately makes no persistent policy-file changes. Reloading or replacing the root session clears grants.
- **Shell tracking covers model-issued native Bash/PowerShell calls only.** Pi's user `!` commands keep their own execution/cancellation path and do not appear in this tab; shell background jobs and the optional Terminals tab are absent. Output previews retain a capped tail (300 lines), not V2's byte-paged output API or seven-day retention cleanup. Records and cancellation capabilities are scoped to the exact session/file; cancellation never signals a saved PID. Owner shutdown aborts running shells, and expired live leases display as Killed after restart. Windows uses Pi's native hidden process-tree kill; descendants created during an early-spawn cancellation race, breakaway processes or detached services can escape that tree. Live checks verify running commands after their first captured output, not a guaranteed Windows job-object sandbox.
- **Effective Bash settings are preserved on Pi 1.0+.** The wrapper retains the native shell path/prefix, renderers, results and guards. Older Pi exposes neither effective runtime settings nor project trust: global file settings are retained, but project Bash overrides are refused rather than blindly applied, and SDK-only runtime overrides cannot be recovered through its extension API.
- **Plan mode uses Pi's `<agent-dir>/plan`.** Edits are limited to that directory, and switching back to Build injects a leave-Plan reminder. Mode selection is stored on the active session branch, so switching sessions or restarting restores Plan/Build and their tool restrictions. This is not OpenCode's `~/.opencode/plan` location.
- **`--system-prompt` replaces the whole prompt.** OpenCode's provider system array is `[agent.system, initial]`, so an agent with a prompt still keeps the session's cwd context. Because Pi's flag replaces everything, the cwd is re-added to the child prompt explicitly.
- **Tool descriptions cannot be mutated.** OpenCode rewrites the `subagent` tool description before each request with the dispatchable agents. Pi has no such hook, so the same listing (same filter, same sort, same fallback text) is injected as context instead.
- **`@` mentions depend on how the prompt arrives.** Pi's argument parser resolves `@file` before extensions load, so `@name` works when typed in the editor or sent over RPC, but a command-line prompt needs `::name`.
- **Scout's cache has no OpenCode equivalent.** OpenCode clones into a managed cache; the Pi port uses `<agent-dir>/cache/scout` and names that path in the prompt.
- **Provider sampling options depend on the provider.** `temperature` and `top_p` are forwarded to the payload, but some models (notably some reasoning models) reject them.
- **Model variants are mapped, not passed through.** An explicit `#variant` must name a thinking level supported by the Pi model; other explicit variants are rejected. Configured agent variants outside Pi's levels still have no equivalent.
- **Live switching is boundary-scoped.** It requires a supported child and one-at-a-time steering; all-at-once mode fails before admission. SDK children cannot switch to nested-capable agents without settling and continuing through the process runner. An already-running tool keeps its old policy. Settlement races may reject input; uncertain acknowledgements are never replayed, and queued admission does not guarantee survival across cancellation/crash. See [the verified switching checkpoint](docs/live-switching.md).
- **Background jobs are owned Pi subprocesses, not OpenCode server jobs.** All children stop when their owning Pi session shuts down; Ctrl+B only releases the foreground wait. `/agents cancel <sessionID>` uses a directly retained live handle or asks the descendant's owning runtime to interrupt that exact run, never an unverified PID from disk. A completed job is reported after its direct parent session completes a turn. Foreground dispatch is cancellable with `Ctrl+C`.
- **`subagent_depth` defaults to 1**, matching OpenCode. Nesting requires both a higher `--agent-depth N` and an agent whose permissions allow subagent dispatch; the family viewer does not loosen either guard.

## Development

```bash
npm install
npm run typecheck
npm test
```

Unit and behavioral tests cover agent definitions, configuration, permissions, child arguments, background delivery and cancellation, provider options, and switching primary agents. Run `node test/live-rpc.mjs` to verify `/agents` and `/agents running` with empty, unrelated, and stale job records against a live Pi RPC process. Run `node test/live-continuation.mjs` to check Pi's exact-file continuation and project-scope handoff. Run `node test/live-plan-resume.mjs` to verify restored Plan/Build mode across real session switches and process restarts. Run `node test/live-subagent.mjs` for parent→child dispatch, model selection, hidden child storage, live viewing, background delivery, foreground/background interruption, transferring the same foreground child while Pi is open, and stopping owned children on parent exit against an isolated local mock endpoint (no real-provider traffic). Run `node test/live-path-rules.mjs` to exercise real Pi writes against relative, absolute, dot-segment, file-URL, `@` and junction aliases; the protected file must remain unchanged while an allowed public write succeeds. `test/composer*.test.ts` checks the normal OpenCode layout, controls and click entry points. `test/tui-render.test.ts` exercises the composer and full-page child navigation through Pi's regular and fullscreen terminal renderers with a memory terminal. Repeat with `PI_AGENT_STRICT_SHELL=1` to verify the child tool allowlist excludes shell tools. RPC clients must keep stdin open until the command response arrives: closing it early asks Pi to shut down while an asynchronous command may still be running.

`test/config-parity.test.ts` covers source-backed v2 merging/removal, optional descriptions, retained limits/model settings, explicit false/empty values and primary fallback. The live dispatch suite also exercises description-less agents and partial project overrides in both runners.

Run `node test/live-scaling.mjs --output test/results/scaling-local.json` for real 1/4/8 parallel foreground dispatch, cold/warm startup, root RPC latency and sampled aggregate working-set memory. It never contacts real providers, rejects hidden SDK fallback, and is a standalone benchmark rather than part of `npm test`. See [the measured baseline and caveats](docs/scaling-benchmark.md) and the [corrected handoff checkpoint](docs/handoff-profile.md). Use `--counts 8 --backends sdk --profile-dir <directory>` for focused root-main-thread V8 sampling; `node test/summarize-profile.mjs <file.cpuprofile>` summarizes weighted samples (including possible blocked-I/O time). `test/subagent-result.test.ts`, `test/jsonl-lines.test.ts` and `test/cpu-profile.test.ts` cover lossless compact metadata, linear LF framing and sample attribution.

`test/sdk-worker.test.ts` uses an isolated local provider to verify shared-thread concurrency, separate histories/models/policies, project trust, sibling-safe cancellation, initialization cancellation, same-session transfer, root-PID safety, worker failure/restart and graceful native-shell cleanup. Repeat `test/live-subagent.mjs` and `test/live-forms.mjs` with `PI_AGENT_RUNNER=sdk`; they assert actual persisted SDK runner metadata, not just a successful subprocess fallback.

`test/child-input.test.ts` covers ordered admission, cancellation, stale handles and RPC settlement/failure races. `test/sdk-worker.test.ts` also tests same-session steering and a slow input handler racing settlement. Run `node test/live-steering.mjs` in process/SDK modes (optionally paired with safeguards) for direct-parent validation, ordered once-only input, model/policy/history retention, foreground joining and single background delivery. `test/live-rpc-shutdown.mjs` isolates the Windows native exit assertion without extensions.

`test/live-input.test.ts` covers boundary ordering, inert preparations, malformed/foreign configuration and lossless frame cleanup. RPC preparation-receipt regressions are in `test/child-input.test.ts`; owner role/status serialization and stale-generation guards are in `test/ownership.test.ts`. Run `node test/live-switching.mjs` with `PI_AGENT_RUNNER=process` and `sdk` for actual same-session agent/model switches, old-batch/new-request policies, prompts/tools/sampling/budgets, sibling isolation and final metadata. Repeat with `PI_SWITCH_STEERING_MODE=all` for unsupported-mode rejection. See [the checkpoint and bounded differences](docs/live-switching.md).

`test/decline.test.ts` checks rejection provenance, exact execution scoping, sibling/next-turn isolation, queue draining, stale replies and cancellation markers. Run `node test/live-decline.mjs` in both process/SDK modes (also with `PI_SAFEGUARDS_EXTENSION_DIR`) to assert no post-decline provider request, root recovery on new input, live sibling survival, same-execution form draining and cancelled background delivery. SDK metadata prevents hidden fallback.

`test/paired-approvals.test.ts` tests both extension load orders and policy revalidation (its sibling safeguards integration is optional when that workspace is absent). Set `PI_SAFEGUARDS_EXTENSION_DIR` to the safeguards workspace when running `test/live-forms.mjs` to exercise both installed extensions together; the fixture copies them into an isolated agent directory and never contacts a real provider.

`test/streaming-performance.test.ts` checks delta-only thinking/tool arguments, multi-megabyte reasoning, cooperative catch-up, zero-replay idle reads, UTF-8/partial records, reused output paths, bounded display state, idle form discovery and shared family indexes. It uses synthetic logs, not provider-backed agents.

`test/child-render.test.ts` checks native Pi rendering, streaming, deduplicated tool calls/results, expansion, thinking controls and scroll preservation. `test/child-composer.test.ts` checks the always-open child composer, current-row highlighting, navigation, controls, scoped live shell output and cleanup of native elapsed-time timers. `node --experimental-strip-types test/view-snapshot.mjs after "path/to/chrome.exe"` captures an ANSI-preserving child-page snapshot under the OpenCode temporary directory. On Windows, `powershell -NoProfile -File test/console-windows.ps1` watches for new visible console windows during the live dispatch suite; that suite must also verify child shutdown on parent exit before a launch change is considered safe.

`test/family.test.ts` covers verified modern/legacy descendant chains, foreign claims, cycle exclusion and V2's prefixes/order (Pi transcript mtime supplies the updated timestamp). `test/interrupts.test.ts` covers acknowledged owner-routed requests, stale/foreign capabilities, continuation cleanup races and safe timeouts. Run `node --experimental-strip-types test/live-family.mjs` for real foreground/background grandchildren, root-side listing/viewing/cancellation and nested shutdown against the local mock. On Windows, run the same suite under `powershell -NoProfile -File test/console-windows.ps1 -TestScript test/live-family.mjs` to check for extra console windows. Use `test/view-snapshot.mjs after-family "path/to/chrome.exe"` for the tree-layout snapshot.

`test/forms.test.ts`, `test/form-ui.test.ts` and `test/approval.test.ts` cover root ownership, UI serialization, question answers, session-local grants, rechecks and stale/cancelled requests. Run `node --experimental-strip-types test/live-forms.mjs` for real foreground/background descendants and root RPC answers, hard denials after a saved grant, nested questions, cancellation and shutdown against the local mock. On Windows, use `test/console-windows.ps1 -TestScript test/live-forms.mjs` to probe visible console windows. The `before-permission`/`after-permission` snapshot modes compare the old confirmation with the new root permission selector.

`test/shells.test.ts` covers independent abort signals, exact session scoping, nonce-safe reused call IDs, native error/result preservation for Pi 0.87/1.0, shell settings, final output and stale leases. Run `node --experimental-strip-types test/live-shells.mjs` for native root/foreground/background/nested shells, isolated cancellation with agent continuation, nonzero exits, timeouts and shutdown against the local mock. Windows defaults to PowerShell; repeat with `PI_AGENT_SHELL_TOOL=bash` to check Bash and preservation of its configured shell path/prefix. On Windows, use `test/console-windows.ps1 -TestScript test/live-shells.mjs` to check that both native execution and killing stay hidden. The `before-shell-controls`/`after-shell-controls` and `before-shell-output-killed`/`after-shell-output-killed` snapshot modes show the Shell controls and final output status.

## Layout

```
index.ts            extension entry: tool, commands, events
src/builtin.ts      Pi translations of Build, Plan, General, Explore
src/scout.ts        experimental scout agent
src/config.ts       JSON + markdown discovery, tool allowlist derivation
src/permissions.ts  wildcard matching and ruleset evaluation
src/runner.ts       subprocess/SDK dispatch and owned shutdown
src/child-input.ts  serialized, revocable live input admission
src/live-input.ts   private configuration preparation, user-frame cleanup and turn-boundary application
src/process-client.ts private RPC subprocess capability and event-log drain
src/sdk-client.ts   lazy shared worker, scoped capabilities and safe fallback
src/sdk-worker.mjs  host-SDK/Jiti bootstrap outside the root UI loop
src/sdk-host.ts     isolated SDK sessions, flags, logs and tool cleanup
src/approvals.ts    shared preflight/approval contract with safeguards
src/interactions.ts per-execution decline scope, abort and persisted cancellation marker
src/foreground.ts   file-backed foreground wait and Ctrl+B handoff
src/jsonl.ts        cooperative incremental JSONL cursors and partial-record handling
src/jobs.ts         background job records and completion collection
src/ownership.ts    child-session ownership, nested storage, legacy migration
src/family.ts       verified descendant discovery and V2 tree prefixes
src/interrupts.ts   per-run, owner-routed descendant interruption
src/forms.ts        root-owned request/reply queue and session-local ask grants
src/form-ui.ts      native Pi permission/question dialogs
src/primary-state.ts persisted, branch-sensitive primary selection
src/steps.ts        max-steps prompt, message, and counter
src/enforce.ts      per-call permissions and external-path checks
src/path-rules.ts   normalized logical/physical file-path rules
src/shell-paths.ts  conservative literal shell-path preflight
src/progress.ts     structured, throttled child tool progress
src/view.ts         bounded live transcript and full-page child viewing
src/ui.ts           session-scoped presentation bridge for the sidebar UI
src/mac-frame.ts    shell-window renderers, shared by root and child views
src/composer.ts     normal OpenCode Subagents/Shell composer and controls
src/shells.ts       per-call native shell cancellation, session-scoped output and live leases
src/listing.ts      dynamic "Available subagents" listing
src/models.ts       model references, supported variants, selection precedence
src/autocomplete.ts ::name autocomplete provider
src/types.ts        shared types
```
