// Summarize V8 main-thread samples, including blocked native-I/O time.
// node test/summarize-profile.mjs [--output summary.json] file.cpuprofile ...
import fs from "node:fs/promises";
import { parseArgs } from "node:util";
import { summarizeCpuProfile } from "./helpers/cpu-profile.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { output: { type: "string" } } });
if (!positionals.length) throw new Error("Supply one or more .cpuprofile files");
const round = (value) => Math.round(value * 10) / 10;
const reports = [];
for (const file of positionals) {
  const summary = summarizeCpuProfile(JSON.parse(await fs.readFile(file, "utf8")));
  const frame = (item) => ({ ...item, lineNumber: item.lineNumber + 1, columnNumber: item.columnNumber + 1,
    selfMs: round(item.selfMs), inclusiveMs: round(item.inclusiveMs) });
  const report = { file, durationMs: round(summary.durationMs), sampledMs: round(summary.sampledMs),
    note: "Sampled elapsed time, not proof of CPU-busy time. Native stdout writes can include blocked I/O; inclusive rows overlap. Profiler overhead is present; child/worker CPU is not sampled.",
    self: summary.frames.slice(0, 20).map(frame),
    inclusive: summary.frames.filter((item) => item.url).sort((a, b) => b.inclusiveMs - a.inclusiveMs).slice(0, 20).map(frame) };
  reports.push(report);
  console.log(JSON.stringify(report));
}
if (values.output) await fs.writeFile(values.output, JSON.stringify(reports, null, 2) + "\n");
