# Boundary-safe live child switching

Checkpoint: Pi 1.0.0 / Node v24.18.0 / Windows. Local mock providers only;
no research subagents or real-provider requests.

## Supported behavior

A `subagent` call with an owned, running `sessionID` can select another available
subagent or an explicit `provider/model#thinking-level`. It retains the original
process/SDK session, transcript, history and cancellation capability.

The current assistant/tool batch keeps its old policy. The configuration attached
to the first queued user input applies at Pi's next `turn_end` boundary, before
the next provider request: agent prompt (with cwd), model/thinking selection,
permissions, actual tool declarations, sampling options and a fresh step budget.
Inputs are admitted in order; a later queued configuration cannot leapfrog the
first input. No second runtime opens the transcript to change its configuration.

Model precedence remains explicit override, otherwise a newly selected agent's
configured model, otherwise the existing child model. An unchanged agent without
an override retains the child's saved selection.

## Preparation is not application

The parent sends configuration over the existing private capability and waits
for an explicit, session/transaction-bound preparation receipt. Pi can report a
command as handled even when its handler rejected it; command success alone is
therefore **not** permission to send the task. Rejected, missing or ambiguous
receipts fail before queueing. Cancellation is rechecked before admission.

The queued user frame carries only a transaction identifier. Its private
configuration is staged in the child, not embedded in model-facing text.
`message_end` strips the frame before persistence/context conversion, preserving
Unicode, images and input transformations. Extension-handled input cancels its
unused preparation. Uncertain admission is never automatically replayed.

Only the child's applied receipt changes parent agent metadata. Owner role and
status updates share a serialized, atomic mutation sequence, use unique temporary
files, recheck ownership, and revoke stale generations before commit. The
regression first reproduced colliding fixed-name temporary files (`EEXIST`).
Windows also required queueing before the SDK's asynchronous realpath registration
to avoid a target-rename collision (`EPERM`); the concurrent-update regression
then passed repeatedly. Final foreground/background metadata uses the actual
child agent and model, not its original launch label.

## Bounded differences and failure behavior

- Requires Pi's **one-at-a-time steering** and the supported extension/runtime
  capability. All-at-once steering fails before admission rather than applying
  one policy to multiple differently configured inputs.
- SDK children cannot switch to an agent permitting nested delegation. Finish
  that run, then continue through the process backend. Direct background dispatch
  still uses the process backend; the runner default is unchanged.
- Unknown agents, primary-only agents, foreign sessions, invalid model IDs and
  unsupported thinking variants fail closed. Configuration is validated again
  in the child; a boundary application failure disables tools, clears queued
  work and aborts that child rather than proceeding with a mixed configuration.
- This is a turn-boundary switch, not interruption of a tool already executing.
  Completed side effects are not rolled back. Queued admission is not durable
  work acceptance across cancellation, worker failure or restart.
- Request-local prompt replacement does not add a native Pi prompt setter or
  implement dynamic configuration watching/full OpenCode v2 configuration.

## Verification

Typecheck and **304 tests** pass, including staged configuration ordering,
validation, cancellation/failure, Unicode/image cleanup, explicit RPC preparation
acknowledgements, concurrent owner role/status updates and revoked generations.

`test/live-switching.mjs` runs against both real Pi transports with an isolated
local provider. It holds the old request, switches to a read-only agent, verifies
that the old tool batch still writes, then checks the next prompt/model/tools,
sampling and step limit. Model-only and agent-back switches keep history and
admit each task once; siblings stay live and isolated. The SDK fixture verifies
persisted runner metadata (no hidden subprocess fallback), and rejects a
nested-capable target without admitting its task. Repeat with
`PI_SWITCH_STEERING_MODE=all` to verify unsupported-mode rejection.

`test/live-steering.mjs` continues to cover ordered input, foreground rejoining,
parent responsiveness, one background delivery and retained model/policy/history.
The loadout fixture checks declaration/call agreement on both runners.

The selectively installed copy also passed switching (normal/all-at-once),
steering, paired installed-safeguards forms, decline/recovery, subagent
continuation/lifecycle and permission-loadout fixtures in both runners. Actual
SDK metadata was asserted; no hidden process fallback counted as SDK success.

These are functional mock-provider checks, not interactive TUI latency or new
scaling measurements. The three existing Windows native-shell regions in the
installed entrypoint were preserved exactly; unrelated local Windows shell
implementation changes were not deployed.
