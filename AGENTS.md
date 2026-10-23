# pi-extensions — Agent Notes

Project learnings for this repo only. Add one concrete one-line rule after a correction; prune rules whose issue disappeared.

- Cancel task-owned background subagents before reporting completion when their results are no longer needed.
- Before saying an extension update needs only a restart, verify the installed extension points to the edited checkout; separate copies need syncing.
- Stress-test concurrent Git worktree allocation before shipping; unique branch names do not prevent shared repository metadata races.
- Keep collapsible UI controls at the same horizontal position across states, with mouse hitboxes aligned to their visible glyphs.
- Do not make Pi agent configuration implicitly depend on OpenCode config; migrate overrides into Pi’s own config.
- Do not have new extensions replace the editor: pi-side-panel's setEditorComponent loads later and wins; hook input with ctx.ui.onTerminalInput and insert with ctx.ui.pasteToEditor.
- Handle oversized Pi image requests in a Pi extension, not the proxy; modify outgoing payload copies without changing saved attachments or conversation text.
- Pi swallows `before_provider_request` hook exceptions and continues sending; explicitly call `ctx.abort()` when an outgoing-request guard must block HTTP, and verify with the actual CLI.
- Test image-budget recovery after an additional tool-read image and across subsequent turns, not only the initially failing payload.
