# Pi OpenCode Safeguards

Ports [OpenCode's permission system](https://opencode.ai/docs/permissions) to Pi as an extension.

Every tool call resolves to one of three effects — `allow`, `ask`, or `deny` — and `ask` prompts with **Allow once / Always allow / Reject**, exactly like OpenCode. "Always allow" persists a pattern for the project so later sessions stop asking.

## Install

```bash
mkdir -p ~/.pi/agent/extensions
cp -r safeguards ~/.pi/agent/extensions/safeguards
```

Pi loads the extension at startup. Works with **zero configuration**: it starts from OpenCode's permissive defaults plus its safety guards.

```bash
pi --help                 # shows --safeguards-auto under "Extension CLI Flags"
```

## What is guarded

| Pi tool | OpenCode permission | Default |
|---|---|---|
| `read` | `read` | allow, except `.env` files → ask |
| `edit`, `write` | `edit` | allow |
| `grep` | `grep` | allow (matches the pattern) |
| `find` | `glob` | allow (matches the glob) |
| `ls` | `list` | allow |
| `bash`, `powershell` | `bash` | allow (matches each parsed command) |
| `task`, `subagent` | `task` | allow (matches the agent) |
| `skill` | `skill` | allow (matches the skill) |
| `webfetch` | `webfetch` | allow (matches the URL) |
| `websearch` | `websearch` | allow |
| `question`, `questionnaire` | `question` | allow |
| `lsp` | `lsp` | allow |
| any tool touching a path outside the working directory | `external_directory` | **ask** |
| the same tool call repeated 3× with identical input | `doom_loop` | **ask** |

`.env` handling matches OpenCode:

```jsonc
"read": { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" }
```

## Configuration

Rules live in `permission` blocks. Files are merged in order, later files win:

1. `<agent-dir>/safeguards.json`
2. `<agent-dir>/pi.jsonc`
3. `<agent-dir>/settings.json`
4. `<cwd>/.pi/safeguards.json`
5. `<cwd>/.pi/settings.json`

Only the first existing file per directory is read. OpenCode's `opencode.json` shape works unchanged:

```jsonc
{
  "permission": {
    "*": "allow",
    "bash": { "*": "ask", "git *": "allow", "rm *": "deny" },
    "edit": { "*": "ask", "packages/web/src/content/docs/*.mdx": "allow" },
    "webfetch": { "*": "ask", "https://en.wikipedia.org/*": "allow" }
  },
  "permissionFallback": "ask",
  "safeguards": {
    "doomLoop": true,
    "doomLoopThreshold": 3,
    "strictGuards": false
  }
}
```

You can also set one effect for everything: `"permission": "allow"`.

### Patterns

`*` matches zero or more characters, `?` exactly one, everything else is literal. Backslashes normalize to `/`. **The last matching rule wins**, so put the catch-all `*` first and specific rules after it.

`~` and `$HOME` expand at the start of a pattern.

### OpenCode v2 rule ordering

Built-in `.env`, `external_directory`, and `doom_loop` guards precede user configuration, matching OpenCode v2 by default. A later `"*": "allow"` or `"permission": "allow"` overrides those defaults. Without overrides, the guards remain active.

If you want stricter-than-OpenCode behavior, explicitly set `"safeguards": { "strictGuards": true }`: guards are then re-applied unless your config names their action.

### Deny cannot be overridden

An explicit `deny` is checked before saved grants, so a stale "Always allow" can never unlock something you have since denied.

## Commands

| Command | Effect |
|---|---|
| `/safeguards` | Show sources, fallback, auto state, and every active rule |
| `/safeguards auto` | Toggle auto-approve (or press `ctrl+shift+a`) |
| `/safeguards allow <action> [resource]` | Save an always-allow rule |
| `/safeguards deny <action> [resource]` | Append a deny rule to `.pi/safeguards.json` |
| `/safeguards reset` | Clear saved grants for this project |
| `/safeguards check <action> <resource>` | Explain which rule wins, without running anything |

```bash
pi --safeguards-auto=true     # auto-approve for one run
```

Use `--safeguards-auto=true`; without `=`, Pi's CLI parser consumes the following token as the flag's value.

Auto mode approves only requests that would otherwise ask. Explicit `deny` rules are still enforced.

## Paired with agents

With the updated agents extension, safeguards contributes all checks (including hard denies and doom-loop detection) to the agents root approval coordinator. Both policies are evaluated before one dialog and rechecked after approval, independent of load order. A verified headless child uses that live root route instead of being rejected by safeguards' separate no-UI prompt. Explicit rejection/dismissal through the updated agents bridge stops only the requesting execution; configuration hard denies and unavailable UI/transport remain ordinary policy failures, not user declines. Without the coordinator, safeguards retains its standalone behavior and fails closed when UI is unavailable.

The paired root dialog offers **Always for this Pi session**, not a persistent project grant. It remembers only the displayed action/resources and never silently saves safeguards' broader wildcard patterns. Standalone **Always allow** and the explicit `/safeguards allow` command still persist project grants.

## Notes on behavior

- **Shell commands use OpenCode v2's actual portable scanner**, vendored at commit `0bef0eab678e94a389930a2a1365115fd5a35c69` (MIT; see `LICENSE.opencode`). Bash and PowerShell have separate syntax handling. Chains, pipelines, groups and substitutions produce individual resources; quoted operators remain literal and redirects stay with their command. A deny anywhere blocks the whole call. Allowed compounds execute unchanged as one tool call. "Always allow" saves a command prefix (`git status *`), not the full line. Unparseable syntax fails closed.
- **Unattended runs fail closed.** Without a UI or the paired agents' live root approval route, an `ask` blocks rather than silently approving. Pass `--safeguards-auto=true` to approve safeguards asks; agent hard denials and separate agent asks still apply.
- **External paths are granted per directory.** Approving `/elsewhere/data.csv` saves `/elsewhere/*`, not the single file, so sibling reads stop prompting. Paths inside another repository grant that repository root instead.
- **Pi's own files are allowlisted** (`<agent-dir>`, and the temp files Pi writes for truncated output), so they never trigger the external-directory prompt.
- **`cd` outside the project** is checked as an external-directory request, since later commands in the same line run there.
- Grants are stored in `<agent-dir>/safeguards-allow.json`, keyed by repository root.
- If another extension rewrites a tool call first (for example a command-rewriting wrapper), the guard sees the rewritten call — the one that actually executes.

## Development

Safeguards has no separate package or test runner. Its engine and Pi integration are exercised by the agents suite (`agents/test/worktree-dispatch.test.ts` and `agents/test/config.test.ts`):

```bash
cd ../agents
npm install
npm test
```

## Layout

```
index.ts        extension entry: tool interception, commands, shortcut
src/engine.ts   pure preflight, standalone prompt UI, always-allow store, doom loop
src/approval-bridge.ts optional versioned agents coordinator integration
src/config.ts   JSONC config loading and OpenCode default rules
src/rules.ts    wildcard matching, path resolution, rule evaluation
src/shell.ts    OpenCode v2 command-prefix and directory-check adapter
src/shell-scan.ts vendored OpenCode v2 Bash/PowerShell scanner
src/requests.ts maps Pi tools to OpenCode permission checks
src/saved.ts    persistent always-allow grants
src/types.ts    shared types
```
