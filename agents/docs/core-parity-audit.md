# Core OpenCode v2 parity audit

Reference: `anomalyco/opencode` branch `v2`, pinned commit
`46e53e3f2be79cf271d51410b87f979ce2b96cc3`.
Date: 2026-10-03. Scope: non-UI behavior of agents and paired safeguards.
This is a source-backed audit checkpoint, **not a claim of complete parity**.
No research subagents were delegated. Live fixtures use local mock providers.

Source links below are relative to `packages/core/` in that upstream checkout.
The installed Pi runtime is 1.0.0 on Node v24.18.0/Windows.

## Fixed in this checkpoint

Upstream `src/config/plugin/agent.ts` applies documents in order, removes a
configured disabled ID, and changes only fields present in each later entry.
This applies equally to builtins and custom agents. It does not require a
custom description; `src/tool/plugin/subagent.ts` supplies fallback listing text.

Six regressions in `test/config-parity.test.ts` first failed against our prior
implementation, then passed with these corrections:

- Disabled JSON/Markdown entries now remove a builtin or earlier custom agent,
  rather than being skipped and accidentally leaving the earlier agent enabled.
- Description-less custom agents remain discoverable and dispatchable.
- A partial overlay retains earlier model, variant, sampling, steps and visibility.
  Losing a step limit or inherited permissions was more than a cosmetic issue.
- Custom agents merge across layers, rather than being replaced wholesale.
- Explicit `hidden: false`, empty description and empty prompt win; omission does
  not reset visibility, display name or prompt.
- Primary restoration selects an available non-hidden primary if Build is removed,
  matching `src/agent.ts`'s fallback. If no primary exists, tool policies fail closed
  instead of falling back to unrestricted baseline permissions.

`test/live-subagent.mjs` also exercises a description-less Markdown agent and a
partial project override retaining the user-configured model, in both runners.
The public name `mergeOverBuiltin()` remains for compatibility, but its merging
now applies to all earlier definitions.

## Permission-derived loadouts — follow-up fixed

The [verified loadout checkpoint](permission-loadouts.md) closes the stale
inherited allowlist issue below. Final merged rules now drive declarations;
legacy aliases share the call-guard mapping, and both runners filter the actual
loaded catalog instead of a frozen builtin list. Root/primary empty policies,
custom wildcards and selected-baseline restoration are covered too.

Validation: typecheck, **296 passing tests**, and local process/actual-SDK live
loadout, paired-form, steering and subagent fixtures. This is a bounded fix, not
complete configuration or live agent/model-switch parity.

## Source-backed remaining differences

### 1. Explicit interaction rejection — fixed; feedback remains absent

- Upstream: `src/permission.ts` tunnels a `Permission.DeclinedError` past tool
  wrappers; `src/session/model-request.ts` recovers it as a typed failure;
  `src/session/runner/step.ts` interrupts execution instead of making another
  model request. Reject also rejects other pending permissions **in the same
  requesting session**, not indiscriminately throughout the family. Rejection
  with feedback is deliberately a different, recoverable `CorrectedError`.
- Fixed: form replies distinguish explicit decline, unavailable transport/UI,
  timeout and cancellation. `src/interactions.ts` binds abort to a requesting
  execution nonce, records a non-context cancellation marker before `ctx.abort()`,
  and invalidates that execution's pending waits. The root host drains only the
  matching session+execution group, not later turns or other children.
- Outcome: foreground and background result readers preserve the marker, so a
  tool-phase abort without an assistant `stopReason=aborted` is cancelled, not
  reported as success. Both subprocess and SDK live tests assert no post-decline
  provider request, parallel-form draining, new-input recovery and live sibling
  survival. Hard policy denial/transport failure is not converted into a decline.
- Remaining: feedback/correction input is not implemented. There is no automatic
  rollback of side effects completed before rejection.

### 2. Running-child steering and boundary-safe switching — implemented, bounded

- Upstream: `src/tool/plugin/subagent.ts` admits a prompt before joining the
  existing job; a running child's input steers it. The reference test
  `test/tool-subagent.test.ts`, “steers a running child session in the background”,
  proves this is supported behavior, not an inference from docs.
- Reproduced: the old extension rejected a live SDK child with “pending background
  result” in `test/live-steering.mjs`, before changing the implementation.
- Implemented: direct-parent ownership checks precede admission through the
  original subprocess's private RPC stdin or SDK run-ID capability. Admission
  is ordered and acknowledged (`queued` or extension-`handled`), not completion.
  No second runtime opens/writes the child's transcript. Closing/cancelled runs
  revoke input; uncertain acknowledgements never trigger automatic replay.
- Background input returns immediately; foreground input joins the original
  result observer. A background generation reserved for a foreground waiter
  is not collected as an automatic completion at the same time. Ctrl+B retains
  the same generation. New input retains child model/policy/history.
- Verified: local process/actual-SDK live fixtures cover ordered once-only input,
  foreground rejoining, parent responsiveness, foreign/unsupported requests,
  one background delivery and unrelated sibling survival. Unit fixtures cover
  admission/settlement races, worker failure and pre-admission cancellation.
- Follow-up: [boundary-safe live switching](live-switching.md) now applies the
  selected agent/model, prompt, policy/declarations, sampling and step budget
  before the next request while leaving the current tool batch unchanged.
  Explicit private preparation receipts gate task admission; only applied child
  receipts update parent metadata. Role/status mutations are serialized and
  stale generations cannot commit. Typecheck, **304 tests** and real process/SDK
  local-provider switching fixtures pass, including SDK no-fallback assertions.
- Bounded: one-at-a-time steering only; SDK switches cannot enable nesting.
  Unsupported modes/targets fail before admission. A boundary failure aborts
  rather than using a mixed configuration. No rollback or durable acceptance
  across cancellation/crash is promised. This is not full live-server parity.

### 3. Restart recovery does not automatically resume interrupted work

- Upstream: `src/session/execution/restart.ts` resumes orphaned/shutdown-interrupted
  execution claims, reconstructs subagent jobs and durable notification IDs, and
  enforces a per-turn durable retry budget (default 10). Managed-server ownership
  guarantees the former owner is dead. Recovery is explicitly **at-least-once**.
- Here: shutdown stops owned children; reopening reports interrupted background
  work as cancelled. Completed but unacknowledged notices are replayed/deduplicated.
  History remains available for explicit continuation; work is not auto-restarted.
- Needed: durable execution intentions and exclusive ownership before any opt-in
  recovery. Never assume a saved PID proves ownership or automatically repeat
  file-changing work just to imitate a server's recovery behavior.

### 4. “Always” has a deliberate narrower lifetime

- Upstream: `src/permission.ts` saves `request.save` patterns using
  `src/permission/saved.ts`, keyed by project, and re-evaluates pending asks.
  Configured hard denies are checked before saved grants.
- Here: the paired root dialog grants exact displayed checks only for this root
  lifetime. Standalone safeguards retains its persistent store and explicit
  `/safeguards allow` still exists. These are not equivalent paired “Always” semantics.
- Decision: preserve the explicitly session-scoped dialog; any persistent root
  choice needs clear opt-in labeling, requested save patterns, project identity,
  revocation, and hard-deny precedence. No silent policy broadening.

### 5. Configuration is still a compatibility subset

- Upstream: `src/config/plugin/agent.ts` accepts native v2 documents, structured
  model references, request headers/body, global permissions/default_agent,
  recursive agent Markdown paths and legacy migration.
- Here: the supported Pi surface uses legacy-style `agent`, string `model`,
  `permission`, sampling options and flat Markdown directories. The fixes above
  repair merging/removal and permission-derived declarations; they do not implement
  every native v2 config field or a dynamic config watcher. The stale inherited
  allowlist issue is fixed and tested against the final effective rule sequence;
  that does not make the rest of the native configuration surface equivalent.

## Behaviors already verified, not new gaps

- Direct-parent ownership and exact verified child-file continuation.
- New/continued child model selection and switches, with Pi-compatible variants.
- Nested depth enforcement plus separate delegation permission checks.
- Foreground progress, same-session background handoff and owner-routed cancellation.
- Completed background-result delivery, acknowledgment and duplicate suppression.
- Shared preflight across agents/safeguards, hard denies before prompts, exact call
  binding, policy rechecks, aborts and both extension load orders.
- Branch-sensitive Plan/Build restoration, tool restrictions and max-step enforcement.

## Scaling checkpoint and next order

See [scaling-benchmark.md](scaling-benchmark.md) and the raw fixture results.
The shared worker has a measurable memory/warm-start benefit; additional mutable
runtime sharing is not justified by the measurements yet. The follow-up
[handoff checkpoint](handoff-profile.md) corrects receiver-induced RPC backpressure
and uses content-range metadata instead of duplicating large completed tool text.
Full output and saved-result rendering remain intact; interactive TUI handoff
latency is not measured or represented as solved.

Explicit rejection and bounded running-child admission are now validated.
Large-result profiling and the bounded metadata optimization are complete.
Effective allowlist derivation from merged permission rules is now fixed and
validated. Boundary-safe live agent/model switching is now implemented and
verified in both runners; see [its checkpoint](live-switching.md). Opt-in recovery,
persistent permission grants, native configuration completeness and interactive
handoff profiling remain separate follow-ups.
The subprocess runner remains default. Its controllable path now uses RPC pipes
and a file-backed observer log; earlier scaling numbers predate that transport
change and must not be claimed as measurements of this revision.

Windows Pi 1.0/Node v24.18.0 RPC exits after a steered turn reproduced a native
`UV_HANDLE_CLOSING` assertion with **no extensions**. Idle acknowledgement alone
still failed; a 100 ms exit/drain grace passed the controlled probe. The process
client applies that Windows-only grace and still surfaces nonzero exit/error
markers. See `test/live-rpc-shutdown.mjs`; Pi itself was inspected read-only,
not patched.
