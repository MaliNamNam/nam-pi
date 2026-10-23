# Large-result handoff checkpoint

Measured 2026-10-04, Windows/Node v24.18.0/Pi 1.0.0. Local fixture only;
no real providers, credentials, or Pi core modifications. The subprocess runner
remains default and the SDK worker remains opt-in.

## Measurement correction

The historical [scaling checkpoint](scaling-benchmark.md) observed long root RPC
pauses, but did not establish that all of their cost belonged to the extension.
A fresh run with the steering-capable transport reproduced streaming maxima of
356–659 ms at eight children.

V8 main-thread profiles attributed substantial sampled time to native stdout
writes. These samples can include **blocked I/O**, not just busy CPU. The fixture
consumer was repeatedly concatenating and scanning a growing JSONL record from
the beginning on every pipe chunk. Pi's final `turn_end`/`agent_end` records are
several MiB; this induced receiver-side copying/scanning and transport backpressure.

`test/helpers/jsonl-lines.ts` now scans each incoming chunk once and joins fragments
only when LF arrives. It preserves split UTF-8, CRLF and Unicode separators, which
are payload characters rather than JSONL boundaries. With **production extension
code unchanged**, eight-child maxima fell to 138–220 ms.
This is a benchmark correction, **not an installed TUI performance improvement**.
Do not compare historical RPC tails to new results without this qualification.

Corrected profiles still show root JSON serialization, UTF-8 encoding, transport,
file-backed observer parsing and persistence costs. Across the four profiled
streaming/handoff windows, `serializeJsonLine` accumulated about 67–76 ms of self
samples, and `writeRawStdoutChunk` about 99–123 ms of inclusive samples. Inclusive
rows overlap; these are not per-event latency measurements. Inspector start/stop
also contributes overhead and must not be interpreted as production work.
The raw result JSON and `.cpuprofile` files from these runs are not included in
this repository; the figures here are the recorded summary.

## Extension-side change: one copy of large tool output

`src/subagent-result.ts` builds the same complete `<subagent>` model-facing text.
For outputs longer than 65,536 **UTF-16 code units**, metadata uses
`details.outputRange = { contentIndex, start, length }` pointing into that text,
instead of storing another full `details.output`. Smaller results retain the old
inline field. The threshold affects metadata only: **no model output is truncated**.

Expanded rendering resolves the range in memory, with validated integer/bounds
checks, and reads legacy inline metadata as before. Ranges survive JSON persistence
and do not parse XML, so Unicode and nested envelope text remain exact. Both initial
foreground dispatch and foreground rejoining use the same builder. History, model,
policy, usage and background notification contracts are unchanged. Clients that
inspect large tool-result metadata should resolve `outputRange` when `output` is
absent; the authoritative full text is still in `content`.

At eight children × 512 KiB, completed-tool JSON dropped from **8 MiB to 4 MiB**
and root RPC traffic for each batch from **40.1 MiB to 20.1 MiB**. Model-facing text
remained byte-for-byte identical in every slot. The RPC protocol itself still
repeats finalized messages across events; this change does not alter Pi's protocol.

Same corrected harness, no profiler, both cold/warm batches:

| Backend | Batch | Legacy metadata RPC max | Compact metadata RPC max |
|---|---|---:|---:|
| Subprocess | cold | 128.6 ms | 92.4 ms |
| Subprocess | warm | 132.2 ms | 100.7 ms |
| SDK | cold | 145.5 ms | 68.7 ms |
| SDK | warm | 147.2 ms | 78.7 ms |

The baseline fixture used backed-up pre-compaction `index.ts`/`progress.ts` with the
same otherwise unchanged source tree. An earlier compact run observed 86–112 ms.
Timing varies with system load/GC; these few runs are not a statistical speedup
claim, confidence interval, keyboard-latency measurement or performance guarantee.

## Reproduce

```powershell
node test/live-scaling.mjs --counts 8 --output handoff.json
node test/live-scaling.mjs --counts 8 --backends sdk --profile-dir "$env:TEMP/pi-handoff-profiles" --output handoff-profile.json
node test/summarize-profile.mjs --output handoff-summary.json "$env:TEMP/pi-handoff-profiles/sdk-8-warm.cpuprofile"
```

Without `--counts`/`--backends`, the original 1/4/8 × process/SDK matrix remains.
The profiler starts only after children are ready and samples the **root main
thread**, not child processes or the SDK worker. Profiling changes timing; compare
unprofiled cases for latency. Every result must complete with exact output,
expanded metadata must resolve losslessly, SDK metadata must prove actual worker
use, and owner shutdown must succeed. Set `PI_AGENT_EXTENSION_DIR` and optionally
`PI_SAFEGUARDS_EXTENSION_DIR` to validate deployed copies with the same harness.

## Validation and remaining work

At this checkpoint, typecheck and all **280** unit/behavioral tests in the original
development workspace passed, including saved-result Markdown rendering, range
validation, metadata compatibility, large/Unicode JSONL framing and weighted
CPU-profile summaries. Live scaling fixtures assert
full output and real SDK execution rather than permitting silent fallback.

The selectively deployed copy also passed the eight-child scaling fixture and,
paired with installed safeguards, both runners' steering, continuation/lifecycle,
root forms, explicit-decline, sibling-isolation and shutdown suites. Its existing
Windows native-shell differences were preserved. The installed unprofiled RPC
maxima were 100–134 ms, again illustrating run-to-run variability rather than a
guaranteed latency ceiling.
Run `/reload` to load the installed metadata change in an existing Pi session.

No claim is made about interactive Markdown/TUI handoff latency. Large complete
model results still have unavoidable context, persistence and protocol cost; a
separate TUI profile or Pi-core protocol investigation must retain result/history
semantics. Boundary-safe live model/policy switching, opt-in restart recovery,
persistent root grants and native v2 configuration completeness remain separate
[parity work](core-parity-audit.md).
