// Controlled scaling benchmark: local provider only; no real tasks/credentials.
// Run: node test/live-scaling.mjs [--output result.json] [--counts 8] [--backends sdk] [--profile-dir dir]
// A real RPC parent dispatches parallel foreground tools via the model. Cold and
// warm batches reuse that parent; SDK metadata makes hidden fallback a failure.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { JsonlLines } from "./helpers/jsonl-lines.ts";

const { values: options } = parseArgs({ options: {
  output: { type: "string" }, counts: { type: "string", default: "1,4,8" },
  backends: { type: "string", default: "process,sdk" }, "profile-dir": { type: "string" },
} });
const counts = options.counts.split(",").map(Number);
const backends = options.backends.split(",");
assert.ok(counts.length && counts.every((count) => Number.isInteger(count) && count > 0 && count <= 32), "--counts must contain integers from 1 to 32");
assert.ok(backends.length && backends.every((backend) => backend === "process" || backend === "sdk"), "--backends must contain process and/or sdk");
assert.equal(new Set(counts).size, counts.length, "--counts must not repeat a case");
assert.equal(new Set(backends).size, backends.length, "--backends must not repeat a backend");
const profileDir = options["profile-dir"] ? path.resolve(options["profile-dir"]) : undefined;
if (profileDir) await fs.mkdir(profileDir, { recursive: true });

const source = process.env.PI_AGENT_EXTENSION_DIR ?? fileURLToPath(new URL("../", import.meta.url));
const safeguards = process.env.PI_SAFEGUARDS_EXTENSION_DIR;
const cli = process.env.PI_CLI ?? path.join(process.env.APPDATA, "npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const outputFile = options.output;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-live-scaling-"));
const chunkBytes = 8192, chunkCount = 64, streamIntervalMs = 40;
const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value) => Math.round(value * 10) / 10;
const percentile = (values, percent) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * percent) - 1)] ?? 0;

function delta(res, content, toolCalls) {
  res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
    choices: [{ index: 0, delta: toolCalls ? { role: "assistant", tool_calls: toolCalls } : { content }, finish_reason: null }] })}\n\n`);
}
function finish(res, tools = false) {
  res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
    choices: [{ index: 0, delta: {}, finish_reason: tools ? "tool_calls" : "stop" }] })}\n\n`);
  res.end("data: [DONE]\n\n");
}

// The OS sampler runs outside the measured parent/children. Windows working set
// includes the worker's memory, so it is counted once, not once per SDK session.
async function createMemorySampler() {
  if (process.platform === "linux") return { async sample(pids) {
    const values = await Promise.all(pids.map(async (pid) => {
      const statm = await fs.readFile(`/proc/${pid}/statm`, "utf8").catch(() => "0 0");
      return Number(statm.split(/\s+/)[1]) * 4096; // benchmark assumes ordinary 4 KiB Linux pages
    }));
    return { total: values.reduce((a, b) => a + b, 0), parent: values[0] ?? 0 };
  }, async close() {} };
  if (process.platform !== "win32") throw new Error("Memory sampler currently supports Windows and Linux");
  const script = path.join(root, "memory-sampler.ps1");
  await fs.writeFile(script, `while ($null -ne ($line = [Console]::ReadLine())) {
    $ids = ConvertFrom-Json -InputObject $line; $total = 0L; $parent = 0L
    for ($i = 0; $i -lt $ids.Count; $i++) {
      try { $p = [System.Diagnostics.Process]::GetProcessById([int]$ids[$i]); $bytes = $p.WorkingSet64; $p.Dispose() } catch { $bytes = 0L }
      $total += $bytes; if ($i -eq 0) { $parent = $bytes }
    }
    [Console]::WriteLine((ConvertTo-Json -Compress @{total=$total;parent=$parent}))
  }`);
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "", diagnostic = "";
  const queue = [];
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (data) => { diagnostic += data.toString(); });
  child.stdout.on("data", (data) => {
    buffer += data;
    for (let at; (at = buffer.indexOf("\n")) !== -1;) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      try { const parsed = JSON.parse(line); const next = queue.shift(); if (next) { clearTimeout(next.timer); next.resolve(parsed); } }
      catch { /* ignore shell diagnostics */ }
    }
  });
  child.on("error", (error) => { for (const next of queue.splice(0)) { clearTimeout(next.timer); next.reject(error); } });
  return { sample(pids) { return new Promise((resolve, reject) => {
    const entry = { resolve, reject, timer: setTimeout(() => reject(new Error(`memory sampler timed out: ${diagnostic}`)), 10_000) };
    queue.push(entry); child.stdin.write(JSON.stringify(pids) + "\n");
  }); }, async close() {
    if (child.exitCode !== null) return;
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.stdin.end(); await closed;
  } };
}

async function runCase(backend, count, sampler) {
  const base = path.join(root, `${backend}-${count}`), agentDir = path.join(base, "agent"), cwd = path.join(base, "work"), sessions = path.join(base, "sessions"), probes = path.join(base, "probes");
  const records = [], waiters = [], commands = new Map(), held = new Map(), streamTimers = new Set();
  let pi, stderr = "", phase, sequence = 0, bytesReceived = 0;
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ""; for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
      if (body.model === "child") {
        const marker = /BENCH_SLOT=(cold|warm)-(\d+)/.exec(JSON.stringify(body.messages));
        assert.ok(marker, "every child must carry a fixture marker");
        assert.equal(marker[1], phase.label); assert.ok(!held.has(marker[0]), "fixture prompt must run exactly once");
        held.set(marker[0], { res, index: Number(marker[2]) });
        phase.arrivals.push(performance.now() - phase.start);
        res.on("close", () => held.delete(marker[0]));
      } else {
        const last = [...body.messages].reverse().find((message) => message.role === "tool" || message.role === "user" && JSON.stringify(message.content).includes("BENCH_BATCH="));
        if (last?.role === "tool") { delta(res, "PARENT_DONE"); finish(res); return; }
        const batch = /BENCH_BATCH=(cold|warm)/.exec(JSON.stringify(last?.content));
        assert.ok(batch);
        delta(res, undefined, Array.from({ length: count }, (_, index) => ({ index, id: `${batch[1]}-${index}`, type: "function",
          function: { name: "subagent", arguments: JSON.stringify({ agent: "general", description: `Fixture slot ${index}`, prompt: `BENCH_SLOT=${batch[1]}-${index}` }) } })));
        finish(res, true);
      }
    } catch (error) { stderr += `\nfixture server: ${error.stack}`; res.destroy(error); }
  });
  function receive(record) {
    records.push(record);
    if (record.type === "response" && commands.has(record.id)) {
      const pending = commands.get(record.id); commands.delete(record.id); clearTimeout(pending.timer);
      if (record.success) pending.resolve(record); else pending.reject(new Error(record.error));
    }
    for (const waiter of [...waiters]) if (waiter.accept(record)) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(record); }
  }
  function request(type, extras = {}, timeout = 45_000) {
    const id = `request-${sequence++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { commands.delete(id); reject(new Error(`RPC ${type} timed out: ${stderr.slice(-4000)}`)); }, timeout);
      commands.set(id, { resolve, reject, timer }); pi.stdin.write(JSON.stringify({ id, type, ...extras }) + "\n");
    });
  }
  function event(accept, timeout = 60_000) {
    return new Promise((resolve, reject) => {
      const waiter = { accept, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`event timed out: ${stderr.slice(-4000)}; recent=${JSON.stringify(records.slice(-8)).slice(-4000)}`)); }, timeout) };
      waiters.push(waiter);
    });
  }
  async function metadata() {
    const files = await fs.readdir(probes);
    return Promise.all(files.map(async (file) => JSON.parse(await fs.readFile(path.join(probes, file), "utf8"))));
  }
  async function stats() {
    const notice = event((record) => record.method === "notify" && record.message?.startsWith("BENCH_STATS="));
    await request("prompt", { message: "/bench-stats" });
    return JSON.parse((await notice).message.slice("BENCH_STATS=".length));
  }
  try {
    await fs.mkdir(path.join(agentDir, "extensions", "agents"), { recursive: true });
    await fs.cp(path.join(source, "src"), path.join(agentDir, "extensions", "agents", "src"), { recursive: true });
    await fs.copyFile(path.join(source, "index.ts"), path.join(agentDir, "extensions", "agents", "index.ts"));
    if (safeguards) {
      const target = path.join(agentDir, "extensions", "safeguards");
      await fs.mkdir(target); await fs.cp(path.join(safeguards, "src"), path.join(target, "src"), { recursive: true });
      await fs.copyFile(path.join(safeguards, "index.ts"), path.join(target, "index.ts"));
    }
    await fs.mkdir(cwd, { recursive: true }); await fs.mkdir(probes);
    await fs.writeFile(path.join(agentDir, "extensions", "probe.ts"), `import fs from 'node:fs/promises'; import path from 'node:path'; import { isMainThread, threadId } from 'node:worker_threads'; import { monitorEventLoopDelay } from 'node:perf_hooks'; import { Session } from 'node:inspector';
      export default function(pi) {
        let monitor, inspector, profileFile;
        const post = (method) => new Promise((resolve,reject) => inspector.post(method,(error,result) => error ? reject(error) : resolve(result)));
        pi.on('session_start', async (event, ctx) => {
          await fs.writeFile(path.join(${JSON.stringify(probes)}, ctx.sessionManager.getSessionId()+'.json'), JSON.stringify({id:ctx.sessionManager.getSessionId(),pid:process.pid,threadId,isMainThread}));
          if (isMainThread && !process.env.PI_AGENT_DEPTH) { monitor=monitorEventLoopDelay({resolution:10}); monitor.enable(); }
        });
        pi.on('session_shutdown', () => { monitor?.disable(); inspector?.disconnect(); });
        pi.registerCommand('bench-reset', {handler: async () => monitor?.reset()});
        pi.registerCommand('bench-profile', {handler: async (label) => {
          if (!monitor || !${JSON.stringify(profileDir ?? "")}) return;
          inspector = new Session(); inspector.connect();
          await post('Profiler.enable'); await post('Profiler.start');
          profileFile = path.join(${JSON.stringify(profileDir ?? "")}, ${JSON.stringify(`${backend}-${count}-`)}+label+'.cpuprofile');
        }});
        pi.registerCommand('bench-stats', {handler: async (_,ctx) => {
          const loop = {maxMs:monitor?.max/1e6,p95Ms:monitor?.percentile(95)/1e6,rss:process.memoryUsage().rss};
          if (inspector) { const {profile} = await post('Profiler.stop'); inspector.disconnect(); inspector=undefined; await fs.writeFile(profileFile,JSON.stringify(profile)); }
          ctx.ui.notify('BENCH_STATS='+JSON.stringify({...loop,profileFile}));
        }});
      }`);
    await fs.writeFile(path.join(agentDir, "pi.jsonc"), JSON.stringify({ agent: { general: { model: "fixture/child" } } }));
    await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } }));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "local-test-only",
      models: ["parent", "child"].map((id) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 2_000_000, maxTokens: 160_000 })),
    } } }));
    pi = spawn(process.execPath, [cli, "--mode", "rpc", "--session-id", "benchmark-parent", "--session-dir", sessions, "--model", "fixture/parent", "--thinking", "off", "--agent-runner", backend],
      { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_AGENT_RUNNER: backend, PI_AGENT_DEPTH: "", PI_AGENT_FORMS: "", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", XDG_CONFIG_HOME: path.join(base, "xdg"), NO_PROXY: "127.0.0.1,localhost" } });
    pi.stderr.on("data", (data) => { stderr += data.toString(); });
    const lines = new JsonlLines((line) => {
      try { receive(JSON.parse(line)); } catch { /* diagnostics */ }
    });
    pi.stdout.on("data", (data) => { bytesReceived += data.length; lines.push(data); });
    pi.stdout.on("end", () => lines.end());
    await request("get_state");
    const baseline = await sampler.sample([pi.pid]);
    for (const label of ["cold", "warm"]) {
      await request("prompt", { message: "/bench-reset" });
      phase = { label, start: performance.now(), arrivals: [] };
      const latency = { startup: [], streaming: [] };
      let probing = true, probePhase = "startup", peak = { total: baseline.total, parent: baseline.parent }, samples = 0;
      const before = records.length, beforeBytes = bytesReceived;
      const settled = event((record) => record.type === "agent_settled");
      const probe = (async () => { while (probing) {
        const kind = probePhase, start = performance.now();
        await request("get_state"); latency[kind].push(performance.now() - start); await sleep(50);
      } })();
      await request("prompt", { message: `BENCH_BATCH=${label}` });
      try {
        const deadline = performance.now() + 45_000;
        while (phase.arrivals.length !== count) {
          assert.ok(performance.now() < deadline, `only ${phase.arrivals.length}/${count} parallel children started: ${stderr}`);
          await sleep(10);
        }
        const allReadyMs = performance.now() - phase.start;
        const meta = (await metadata()).filter((item) => item.id !== "benchmark-parent");
        const pids = [...new Set([pi.pid, ...meta.map((item) => item.pid)])];
        if (backend === "sdk") assert.ok(meta.every((item) => !item.isMainThread && item.pid === pi.pid), "SDK fallback must fail the benchmark");
        else assert.equal(meta.filter((item) => item.isMainThread).length, label === "cold" ? count : count * 2);
        const sample = async () => {
          const current = await sampler.sample(pids); samples++;
          if (current.total > peak.total) peak = current;
        };
        await sample();
        if (profileDir) await request("prompt", { message: `/bench-profile ${label}` });
        probePhase = "streaming";
        let sent = 0;
        const stream = setInterval(() => {
          for (const { res, index } of held.values()) delta(res, `${index}:` + "x".repeat(chunkBytes - `${index}:`.length));
          if (++sent === chunkCount) { clearInterval(stream); streamTimers.delete(stream); for (const { res } of [...held.values()]) finish(res); }
        }, streamIntervalMs);
        streamTimers.add(stream);
        let sampling = true;
        const samplingLoop = (async () => { while (sampling) { await sample(); await sleep(100); } })();
        try { await settled; } finally { sampling = false; await samplingLoop; }
        const ends = records.slice(before).filter((record) => record.type === "tool_execution_end" && record.toolName === "subagent");
        assert.equal(ends.length, count);
        assert.ok(ends.every((record) => !record.isError && record.result?.details?.status === "completed"), "all benchmark tools must complete");
        for (let index = 0; index < count; index++) {
          const result = ends.find((record) => record.toolCallId === `${label}-${index}`)?.result;
          assert.ok(result, "every slot must have its own result");
          const expected = (`${index}:` + "x".repeat(chunkBytes - `${index}:`.length)).repeat(chunkCount);
          const text = result.content[0]?.text;
          assert.equal(text, `<subagent sessionID="${result.details.sessionID}" state="completed">\n${expected}\n</subagent>`, "model output must remain complete");
          const range = result.details.outputRange;
          assert.equal(range ? result.content[range.contentIndex].text.slice(range.start, range.start + range.length) : result.details.output,
            expected, "serialized output metadata must retain the exact expanded display");
        }
        assert.ok(!records.slice(before).some((record) => record.method === "notify" && /SDK runner unavailable/.test(record.message)), "hidden SDK fallback invalidates the comparison");
        if (backend === "sdk") {
          const files = (await fs.readdir(path.join(sessions, ".pi-subagents"), { recursive: true })).filter((file) => file.endsWith(".jsonl"));
          const raw = await Promise.all(files.map((file) => fs.readFile(path.join(sessions, ".pi-subagents", file), "utf8")));
          assert.equal(raw.filter((text) => text.includes('"customType":"subagent-runner"') && text.includes('"backend":"sdk"')).length, label === "cold" ? count : count * 2);
        }
        probing = false; await probe;
        const loop = await stats();
        const row = { backend, children: count, phase: label, firstReadyMs: round(Math.min(...phase.arrivals)), allReadyMs: round(allReadyMs),
          baselineRssMiB: round(baseline.total / 2 ** 20), sampledPeakRssMiB: round(peak.total / 2 ** 20), sampledPeakParentRssMiB: round(peak.parent / 2 ** 20), samples,
          processCount: backend === "sdk" ? 1 : 1 + count, sdkThreadIDs: backend === "sdk" ? [...new Set(meta.map((item) => item.threadId))] : [],
          rpcWireMiB: round((bytesReceived - beforeBytes) / 2 ** 20),
          toolResultMiB: round(ends.reduce((bytes, record) => bytes + Buffer.byteLength(JSON.stringify(record.result)), 0) / 2 ** 20),
          rpc: Object.fromEntries(Object.entries(latency).map(([kind, values]) => [kind, { samples: values.length, p50Ms: round(percentile(values, .5)), p95Ms: round(percentile(values, .95)), maxMs: round(Math.max(...values, 0)) }])),
          eventLoopMaxMs: round(loop.maxMs), eventLoopP95Ms: round(loop.p95Ms), observedElapsedMs: round(performance.now() - phase.start),
          ...(loop.profileFile ? { profileFile: loop.profileFile } : {}) };
        results.push(row); console.log(JSON.stringify(row));
      } finally { probing = false; await probe; }
    }
  } finally {
    for (const timer of streamTimers) clearInterval(timer);
    for (const { res } of held.values()) res.destroy();
    for (const waiter of waiters.splice(0)) clearTimeout(waiter.timer);
    for (const pending of commands.values()) clearTimeout(pending.timer);
    if (pi?.exitCode === null) {
      const closed = new Promise((resolve) => pi.once("close", resolve)); pi.stdin.end();
      let timer; try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("benchmark parent failed to shut down")), 10_000); })]); }
      catch (error) { pi.kill(); throw error; } finally { clearTimeout(timer); }
    }
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
}

let sampler;
try {
  sampler = await createMemorySampler();
  await sampler.sample([process.pid]); // warm the sampler before measurements
  for (const count of counts) for (const backend of backends) await runCase(backend, count, sampler);
  const report = { timestamp: new Date().toISOString(), platform: process.platform, node: process.version, cpus: os.availableParallelism(), source,
    safeguards: safeguards ?? null, fixture: { chunkBytes, chunkCount, streamIntervalMs, bytesPerChild: chunkBytes * chunkCount, rootMode: "rpc", memory: "sampled sum of parent and live child process working sets (SDK worker included once)",
      limitations: "One cold/warm batch per case, not a statistical performance claim; RPC responsiveness is not TUI render/keyboard latency; no shell/MCP work or production extensions; fixture server/sampler memory excluded.",
      ...(profileDir ? { profile: "V8 main-thread CPU sampling during streaming and final handoff; profiler overhead changes timings; worker/child CPU excluded", profileDir } : {}) }, results };
  if (outputFile) { await fs.mkdir(path.dirname(path.resolve(outputFile)), { recursive: true }); await fs.writeFile(outputFile, JSON.stringify(report, null, 2) + "\n"); }
  console.log("PASS real parallel dispatch, cold/warm startup, root RPC responsiveness, sampled aggregate memory, actual SDK metadata, and owner shutdown");
} finally { await sampler?.close(); await fs.rm(root, { recursive: true, force: true }); }
