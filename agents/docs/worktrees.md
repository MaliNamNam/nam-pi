# Optional worktree isolation

The `subagent` tool accepts `isolation: "shared" | "worktree"`. Omitting it keeps the existing shared-directory behavior; `@agent`/`::agent` shortcuts also remain shared.

For an independent writing task, the model can dispatch:

```json
{
  "agent": "general",
  "description": "Add authentication regression tests",
  "prompt": "Add regression tests for the committed authentication implementation. Run the relevant tests and report the changes; do not merge or delete the checkout.",
  "isolation": "worktree"
}
```

## Starting state

- A new worktree and `pi-agent/<sessionID>` branch start at the dispatching checkout's committed `HEAD`, not a hardcoded main branch.
- Dirty parent checkouts are allowed, but receive a warning. Staged, unstaged and untracked drafts are not copied. The parent is never automatically committed, stashed, reset or cleaned.
- A parent operating in a repository subdirectory keeps the equivalent subdirectory in the child checkout.
- Worktrees live in `<child-session-dir>/.pi-worktrees/<sessionID>`, outside ordinary `/resume` discovery. Each task gets a fresh path/branch; no pool, forced reuse or branch reset is implemented.
- Allocation and continuation verification share an exclusive `pi-agents-worktree.lock` in Git's canonical common directory, so linked checkouts and separate Pi processes cannot observe each other's half-created Git metadata. The lock ends before the child's task starts; agents still work concurrently. Lock waiting is cancellable and bounded to 30 seconds.
- Git and a committed `HEAD` are required only for this mode. Failed setup returns an error without falling back to shared files. Partially created work is not automatically removed.

Use shared mode if the task needs your uncommitted edits, or commit the relevant changes before dispatching in isolated mode.

A hard crash can leave an allocation lock behind. A dead owner produces an explicit stale-lock error; malformed/unfinished locks time out rather than being bypassed or deleted. Before explicitly removing that lock, verify its owner and any Git children have stopped. This recovery removes only the allocation lock, never retained worktrees or branches. Coordination applies to this extension, not external Git commands.

## Existing orchestration

Foreground and background execution, Ctrl+B transfer, verified child navigation, root questions/permissions and owner-scoped cancellation still use the agents extension. No tmux or second interactive terminal is required. Observer/job files remain in the dispatching workspace, while tools and the child transcript's cwd point at the worktree. Nested family discovery follows each child's actual cwd.

An isolated child uses the subprocess backend even when `--agent-runner sdk` is selected. Continuation uses the exact saved child session and retained checkout, including its unfinished edits. Omitting `isolation` on continuation inherits the saved mode; explicitly changing the mode is rejected. Missing, detached or repurposed worktrees are rejected rather than recreated, reset or silently adopted.

Agent definitions and paired safeguards policy are loaded from the originating project, while file permissions are evaluated against the child's cwd. Policy files are not copied. `PI_AGENT_CONFIG_CWD` and `--agent-worktree` are internal child-launch channels; they are not an OS security boundary.

Dependencies, ignored build artifacts, local runtime settings, extra project extensions and other startup resources are not automatically copied or bootstrapped. Put required shared resources in your normal user-level Pi configuration, or initialize the child workspace explicitly. Submodules and environment-specific build setup may also need initialization. Arbitrary shell commands and custom tools still require trusted permissions: a worktree is not a sandbox.

## Review and integration

Results include the retained branch, worktree path and starting commit; `/agents sessions` also lists isolated workspace locations. The paired child page shows that child's branch rather than the parent's branch.

Completion means **ready for review**, not automatically integrated. Cancellation, failure, parent shutdown and background-result acknowledgement preserve the branch and files. The extension never automatically merges, deletes, resets or cleans an isolated checkout. Its instructions require explicit user approval for integration or removal; this is a workflow rule, not a Git-command sandbox.

The pre-existing unused `forgetChild` helper is unchanged. Failures after allocation keep the owner claim so retained work remains discoverable.

Suggested conversation:

1. “Review the isolated child's changes and run its tests.”
2. “Commit those changes and integrate them into my current branch.” — only after approving the review. Integration needs committed child work and a suitable parent state; do not discard unrelated parent drafts.
3. Run tests on the combined result: successful isolated tests do not prove combined changes are compatible.
4. “Remove that worktree and its branch.” — only after verifying the work is integrated or intentionally abandoned, the child is stopped, and no unfinished edits would be lost.

The parent uses existing Git tools for these explicitly requested operations. This release adds no merge/cleanup commands, automatic rebase, push, PR creation or disk-retention expiry.

## Verification

`agents/test/worktrees.test.ts` uses disposable Git repositories for snapshot isolation, concurrent allocation, dirty warnings, cwd-aware ownership and preservation, including separate-process allocation across linked checkouts, cancellable lock waiting, failed-command cleanup and stale/partial locks. `agents/test/worktree-dispatch.test.ts` drives the real dispatcher through a synthetic Node RPC fixture: no Pi child, model provider or credentials are used. It covers foreground/background delivery, exact-file continuation, workspace-mode rejection, cancellation/transfer, root form membership and inherited safeguards policy. The root `test/worktree-ui.test.mjs` renders the real child-page/sidebar components with synthetic data and checks shared/isolated branch labels and narrow widths; `WORKTREE_UI_SNAPSHOT_DIR` enables ANSI snapshot output.
