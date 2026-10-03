import assert from "node:assert/strict";
import test from "node:test";
import { summarizeCpuProfile, type CpuProfile } from "./helpers/cpu-profile.ts";

const frame = (functionName: string) => ({ functionName, url: "fixture.js", lineNumber: 0, columnNumber: 0 });
const fixture = (): CpuProfile => ({ startTime: 0, endTime: 6000, nodes: [
  { id: 1, callFrame: frame("root"), children: [2] },
  { id: 2, callFrame: frame("recursive"), children: [3] },
  { id: 3, callFrame: frame("recursive") },
], samples: [3, 2, 1], timeDeltas: [1000, 2000, 3000] });

test("CPU profile summary weights time deltas and does not double-count recursive inclusive frames", () => {
  const summary = summarizeCpuProfile(fixture());
  assert.equal(summary.sampledMs, 6);
  assert.equal(summary.durationMs, 6);
  assert.deepEqual(summary.frames.map(({ functionName, selfMs, inclusiveMs }) => ({ functionName, selfMs, inclusiveMs })), [
    { functionName: "recursive", selfMs: 3, inclusiveMs: 3 },
    { functionName: "root", selfMs: 3, inclusiveMs: 6 },
  ]);
});

test("CPU profile summary rejects mismatched samples, missing nodes and cyclic parent links", () => {
  assert.throws(() => summarizeCpuProfile({ ...fixture(), timeDeltas: [] }), /differ/);
  assert.throws(() => summarizeCpuProfile({ ...fixture(), samples: [99, 2, 1] }), /Unknown/);
  const cyclic = fixture(); cyclic.nodes[2].children = [1];
  assert.throws(() => summarizeCpuProfile(cyclic), /cycle/);
  assert.throws(() => summarizeCpuProfile({ ...fixture(), timeDeltas: [1000, -1, 3000] }), /delta/);
});
