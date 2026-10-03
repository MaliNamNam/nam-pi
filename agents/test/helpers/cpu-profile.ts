export interface CpuFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

export interface CpuProfile {
  startTime: number;
  endTime: number;
  nodes: { id: number; callFrame: CpuFrame; children?: number[] }[];
  samples: number[];
  timeDeltas: number[];
}

/** Sampled elapsed time, not necessarily busy CPU time (native I/O can block). */
export function summarizeCpuProfile(profile: CpuProfile) {
  if (profile.samples.length !== profile.timeDeltas.length) throw new Error("Profile samples/timeDeltas differ");
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map<number, number>();
  const frames = new Map<string, CpuFrame & { selfMs: number; inclusiveMs: number }>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  let sampledMs = 0;
  for (let index = 0; index < profile.samples.length; index++) {
    const ms = profile.timeDeltas[index] / 1000;
    if (!Number.isFinite(ms) || ms < 0) throw new Error("Invalid profile time delta");
    sampledMs += ms;
    const seenIDs = new Set<number>(), seenFrames = new Set<string>();
    for (let id: number | undefined = profile.samples[index]; id !== undefined; id = parents.get(id)) {
      if (seenIDs.has(id)) throw new Error("Profile parent cycle");
      seenIDs.add(id);
      const node = nodes.get(id);
      if (!node) throw new Error(`Unknown profile node ${id}`);
      const key = JSON.stringify(node.callFrame);
      let frame = frames.get(key);
      if (!frame) { frame = { ...node.callFrame, selfMs: 0, inclusiveMs: 0 }; frames.set(key, frame); }
      if (seenIDs.size === 1) frame.selfMs += ms;
      if (!seenFrames.has(key)) frame.inclusiveMs += ms;
      seenFrames.add(key);
    }
  }
  return {
    durationMs: (profile.endTime - profile.startTime) / 1000,
    sampledMs,
    frames: [...frames.values()].sort((a, b) => b.selfMs - a.selfMs),
  };
}
