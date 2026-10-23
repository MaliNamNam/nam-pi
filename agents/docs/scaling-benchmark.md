# Shared worker scaling checkpoint

Measured 2026-10-03, Windows/Node v24.18.0/Pi 1.0.0.
Harness: `test/live-scaling.mjs`.

**Historical baseline:** the subprocess transport predates live-child steering.
The RPC receiver also inflated large-record tails through repeated growing-buffer
scans. See the [2026-10-04 handoff checkpoint](handoff-profile.md) for the measurement
correction and lossless compact-result change. Do not present the old tail numbers
as isolated extension/TUI latency or compare them directly with the corrected reader.

The raw result files from this run are not included in this repository; the
figures below are the recorded summary. To reproduce with the current code:

```powershell
node test/live-scaling.mjs --output scaling.json
```

## Method

A real, isolated Pi RPC parent uses a local OpenAI-compatible fixture to issue
1/4/8 **parallel foreground subagent tool calls**. No research or real-provider
work runs. All child requests are held until the batch is ready, then each streams
64 x 8 KiB text chunks at 40 ms intervals (512 KiB per child). A second new-session
batch reuses the same parent, exposing warm worker startup without reusing child
conversation history.

- Startup: prompt submission to first/all child provider requests.
- Responsiveness: parent `get_state` round trips about every 50 ms; parent internal
  event-loop-delay monitor also records p95/max.
- Memory: externally sampled sum of parent/child process working sets, about every
  100 ms during streaming. The SDK worker lives in the parent and is counted once.
  Fixture server and sampler memory are excluded. Figures are **sampled peaks**,
  not OS high-water marks or private-memory measurements.
- Instrumentation records child PID/thread identities. SDK cases also require
  persisted `subagent-runner` metadata: fallback cannot silently pass this benchmark.
- Every tool must complete, and every owning parent must shut down cleanly.

This run used workspace agents without safeguards or other production extensions.
Set `PI_AGENT_EXTENSION_DIR`/`PI_SAFEGUARDS_EXTENSION_DIR` for another extension set.

## Results

| Children | Batch | Subprocess all ready | SDK all ready | Subprocess sampled peak | SDK sampled peak |
|---:|---|---:|---:|---:|---:|
| 1 | cold | 1,499 ms | 1,531 ms | 446 MiB | 435 MiB |
| 1 | warm | 1,285 ms | 61 ms | 514 MiB | 462 MiB |
| 4 | cold | 1,654 ms | 1,718 ms | 916 MiB | 501 MiB |
| 4 | warm | 1,835 ms | 155 ms | 1,033 MiB | 563 MiB |
| 8 | cold | 2,304 ms | 1,771 ms | 1,529 MiB | 562 MiB |
| 8 | warm | 2,106 ms | 253 ms | 1,544 MiB | 630 MiB |

At eight children, SDK sampled aggregate memory was approximately **59–63% lower**.
Warm all-child startup was approximately **8x faster** at eight, **12x** at four,
and **21x** at one. Cold startup at one/four was essentially similar; this is code
reuse, not elimination of resource/model loading per child. Each SDK batch used
one worker thread and one Pi process, versus 2/5/9 Pi processes in the subprocess
cases.

Root RPC streaming p95 at eight was **2.0–2.3 ms SDK** versus **6.9–7.8 ms subprocess**.
However, root max round trips were **436–455 ms SDK** and **407–429 ms subprocess**;
parent internal event-loop maxima were approximately **438–488 ms**. These tails
occurred around large final-result handoff. The worker does **not** solve that pause.

## Interpretation and limits

- Keep SDK opt-in: the measured scaling benefit is real in this controlled fixture,
  but not proof of compatibility with arbitrary extension module-global state.
- No additional shared mutable provider/config runtime is warranted yet. Existing
  code reuse captures much of the multi-child memory and warm-start benefit.
- Profile large final-result serialization/context handling separately before
  changing output limits or claiming end-to-end responsiveness is solved.
- One cold/warm batch per case, fixed order, no confidence intervals. Parent GC,
  accumulated history, Jiti/filesystem caches and system load affect the figures.
- RPC responsiveness is not interactive TUI rendering or keyboard latency.
- No native shell/MCP workloads, production extensions or long-running model calls.
- Linux sampler currently assumes ordinary 4 KiB pages; the recorded run is Windows.

This establishes a historical baseline; it is not a performance guarantee or
reason to make SDK the default. Follow-up [handoff profiling](handoff-profile.md)
separates receiver backpressure from production cost and removes duplicate large
tool-result metadata without changing complete model output. The source-backed
[core parity audit](core-parity-audit.md) tracks the remaining bounded work.
