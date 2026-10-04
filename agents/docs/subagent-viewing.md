# Child viewer: own facts, shared presentation

Child inspection stays in the root Pi TUI. It does not switch sessions, invoke a
second interactive process, execute rendering tool definitions, or write to the
child transcript. Only the running child publishes `subagent-ui-state` entries.

## Facts belong to the child

- The JSONL observer keeps a separate usage ledger while the visible transcript
  stays bounded to 300 entries. Earlier cost and successfully edited file paths
  survive display eviction. Partial updates do not add final-message cost twice.
- Context tokens and cache hit come from the child's latest assistant usage.
  Capacity comes from its own model snapshot, with a matching registry lookup as
  a compatibility fallback. The root's selected model/usage is never a fallback.
- Files are successful child `write`/`edit` paths, not the shared worktree's git
  status. Shell-created edits and custom write tools are not attributed yet.
- Resources shows the child's published active tool count, read-only. Old
  transcripts without this declaration say unknown. Root extension/skill/MCP
  counts and root resource toggles are not presented as child facts.
- Shared children keep their owning workspace branch; isolated children show their own worktree branch. Sidebar width remains a shared appearance setting.
  The regular-mode root sidebar overlay is suspended until child disposal, so
  its stats and open resource widget cannot obscure or consume child input.

## Presentation comes from the current TUI

`src/presentation.ts` is the small Pi 1 compatibility adapter. It takes the
current native message components' Markdown theme/transformers, output padding,
hidden-thinking label/settings, and extension message/tool/entry renderers.
Child pages use fresh native components with the child's data; they never reuse
or mutate a root message component. Visible extension messages and session
entries are retained, and private/hidden bookkeeping is not shown.

Tools registered by this extension are available immediately. Other extensions'
renderers are inherited once materialized in the root transcript, because Pi's
public API does not expose other extensions' complete renderer registries.
Unseen custom tools use Pi's generic fallback. Arbitrary extension-owned widgets
or components tied to root session state are not cloned into the child.
CustomEntryComponent is not publicly exported: the adapter retains the existing
native constructor instead of importing a private production package path.

Ctrl+O expands tools/custom entries; Ctrl+T changes thinking visibility locally.
Scrolling, narrow resizing, interruption, direct-parent return, siblings, shell
frames, rounded composer, and the untouched root draft retain their existing
behavior. RPC/plain clients still get a text preview.

## Verification

- `npm run typecheck` and `npm test` in `pi-opencode-agents`.
- `npm run typecheck`, `npm test`, and `npm run test:agents` in `pi-side-panel`.
- Native component fixtures cover root Markdown transforms, padding/thinking,
  other-extension tools/messages/entries, full-history spend/files/loadout,
  renderer width bounds and hidden messages.
- Paired-extension fixtures exercise Pi's real regular/fullscreen renderers,
  child-only stats/files versus conflicting root facts, overlay suspension and
  restoration, navigation and preservation of the root draft.
- Process and SDK live switching/continuation/lifecycle checks remain passing.
