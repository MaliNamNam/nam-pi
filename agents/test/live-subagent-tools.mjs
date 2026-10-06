// Live child loadout/permission check: a real RPC parent dispatches real Pi
// children against a local mock model. No real provider or credentials.
// Run: node test/live-subagent-tools.mjs  (PI_AGENT_RUNNER=sdk is also supported)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlLines } from "./helpers/jsonl-lines.ts";

const source = fileURLToPath(new URL("../", import.meta.url));
const cli = process.env.PI_CLI ?? path.join(process.env.APPDATA ?? "", "npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const backend = process.env.PI_AGENT_RUNNER === "sdk" ? "sdk" : "process";
const safeguards = process.env.PI_SAFEGUARDS_EXTENSION_DIR;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-live-subagent-tools-"));
const agentDir = path.join(root, "agent"), cwd = path.join(root, "work"), outside = path.join(root, "outside"), sessions = path.join(root, "sessions");
const outsideFile = path.join(outside, "secret-notes.txt");
const declared = new Map(), childResults = new Map();
// Each child calls these in order, then reports. Explore's outside read must ask.
const steps = {
  explore: [["read", { path: outsideFile }], ["web_access", { input: "query" }], ["vcc_recall", { input: "query" }]],
  general: [["web_access", { input: "query" }], ["vcc_recall", { input: "query" }]],
};
const records = [], waiters = [], commands = new Map();
let pi, stderr = "", sequence = 0;

const send = (res, delta, finish) => {
  res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
    choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
    choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
  res.end("data: [DONE]\n\n");
};
const call = (res, id, name, args) => send(res, { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
const text = (res, content) => send(res, { content }, "stop");
const toolText = (message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content);

const server = http.createServer(async (req, res) => {
  try {
    let raw = ""; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const all = JSON.stringify(body.messages);
    const tools = (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name);
    const last = body.messages.at(-1);
    if (body.model === "child") {
      const role = /CHILD_ROLE=(explore|general)/.exec(all)?.[1];
      assert.ok(role, "child prompt carries its role marker");
      if (!declared.has(role)) declared.set(role, tools);
      const results = body.messages.filter((message) => message.role === "tool").map(toolText);
      childResults.set(role, results);
      const next = steps[role][results.length];
      if (next) return call(res, `${role}-${results.length}`, next[0], next[1]);
      return text(res, `${role.toUpperCase()}_DONE`);
    }
    if (last.role === "tool") return text(res, "PARENT_DONE");
    const prompt = body.messages.findLast((message) => message.role === "user" && JSON.stringify(message.content).includes("PARENT_TASK="));
    const role = /PARENT_TASK=(explore|general)/.exec(JSON.stringify(prompt?.content))?.[1];
    assert.ok(role, "parent prompt carries a task marker");
    return call(res, `dispatch-${role}`, "subagent", { agent: role, description: `Check ${role} tools`, prompt: `CHILD_ROLE=${role}` });
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
function request(type, extras = {}) {
  const id = `request-${sequence++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { commands.delete(id); reject(new Error(`RPC ${type} timed out: ${stderr.slice(-3000)}`)); }, 45_000);
    commands.set(id, { resolve, reject, timer }); pi.stdin.write(JSON.stringify({ id, type, ...extras }) + "\n");
  });
}
function event(accept, label) {
  return new Promise((resolve, reject) => {
    const waiter = { accept, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1);
      reject(new Error(`${label} timed out: ${stderr.slice(-3000)}; recent=${JSON.stringify(records.slice(-6)).slice(-3000)}`)); }, 60_000) };
    waiters.push(waiter);
  });
}
async function dispatch(role, onDialog) {
  const settled = event((record) => record.type === "agent_settled", `${role} settle`);
  const dialogs = [];
  const watcher = (async () => { while (true) {
    const dialog = await event((record) => record.type === "extension_ui_request" && record.method === "select" || record.type === "agent_settled", `${role} dialog`);
    if (dialog.type === "agent_settled") return;
    dialogs.push(dialog);
    pi.stdin.write(JSON.stringify({ type: "extension_ui_response", id: dialog.id, ...onDialog(dialog) }) + "\n");
  } })();
  await request("prompt", { message: `PARENT_TASK=${role}` });
  await settled; await watcher;
  const end = records.findLast((record) => record.type === "tool_execution_end" && record.toolCallId === `dispatch-${role}`);
  assert.ok(end, `${role} dispatch finished: ${stderr.slice(-2000)}`);
  return { dialogs, end };
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
  // Stand-ins named like the installed web/context tools; no network access.
  await fs.writeFile(path.join(agentDir, "extensions", "tool-stubs.ts"), `import { Type } from "typebox";
    export default function (pi) {
      for (const name of ["web_access", "vcc_recall"]) pi.registerTool({ name, label: name, description: name + " fixture",
        parameters: Type.Object({ input: Type.Optional(Type.String()) }), execute: async () => ({ content: [{ type: "text", text: name }] }) });
    }`);
  await fs.mkdir(cwd, { recursive: true }); await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(outsideFile, "OUTSIDE_CONTENT");
  await fs.writeFile(path.join(agentDir, "pi.jsonc"), JSON.stringify({ agent: { explore: { model: "fixture/child" }, general: { model: "fixture/child" } } }));
  await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "local-test-only",
    models: ["parent", "child"].map((id) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 })),
  } } }));
  pi = spawn(process.execPath, [cli, "--mode", "rpc", "--session-id", "tools-parent", "--session-dir", sessions, "--model", "fixture/parent", "--thinking", "off", "--agent-runner", backend],
    { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_AGENT_RUNNER: backend,
      PI_AGENT_DEPTH: "", PI_AGENT_FORMS: "", PI_AGENT_ID: "", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", XDG_CONFIG_HOME: path.join(root, "xdg"), NO_PROXY: "127.0.0.1,localhost" } });
  pi.stderr.on("data", (data) => { stderr += data.toString(); });
  const lines = new JsonlLines((line) => { try { receive(JSON.parse(line)); } catch { /* diagnostics */ } });
  pi.stdout.on("data", (data) => lines.push(data));
  pi.stdout.on("end", () => lines.end());
  await request("get_state");

  // Explore: read-only search tools plus web/context tools, never shell or edits.
  const explore = await dispatch("explore", (dialog) => ({ value: dialog.options.find((option) => option === "Allow once") }));
  const exploreTools = declared.get("explore") ?? [];
  for (const name of ["read", "grep", "find", "ls", "web_access", "vcc_recall"]) assert.ok(exploreTools.includes(name), `explore declares ${name}: ${exploreTools}`);
  for (const name of ["bash", "powershell", "edit", "write", "subagent"]) assert.ok(!exploreTools.includes(name), `explore omits ${name}: ${exploreTools}`);
  // An outside read asks at the root instead of being denied in the child.
  const exploreResults = childResults.get("explore") ?? [];
  assert.equal(explore.dialogs.length, 1, `explore outside read asks once: ${exploreResults}`);
  assert.match(explore.dialogs[0].title, /External directory requires approval/);
  assert.match(exploreResults[0] ?? "", /OUTSIDE_CONTENT/, "approved outside read returns the file");
  assert.match(exploreResults[1] ?? "", /web_access/, "explore can run web_access");
  assert.match(exploreResults[2] ?? "", /vcc_recall/, "explore can run vcc_recall");
  assert.equal(explore.end.isError, false);

  // General: full loadout including the web/context tools.
  const general = await dispatch("general", () => ({ cancelled: true }));
  const generalTools = declared.get("general") ?? [];
  for (const name of ["read", "bash", "edit", "write", "web_access", "vcc_recall"]) assert.ok(generalTools.includes(name), `general declares ${name}: ${generalTools}`);
  assert.ok(!generalTools.includes("subagent"), "general cannot nest subagents");
  const generalResults = childResults.get("general") ?? [];
  assert.match(generalResults[0] ?? "", /web_access/, `general can run web_access: ${generalResults}`);
  assert.match(generalResults[1] ?? "", /vcc_recall/, `general can run vcc_recall: ${generalResults}`);
  assert.equal(general.dialogs.length, 0);
  assert.equal(general.end.isError, false);
  console.log(`PASS (${backend}${safeguards ? "+safeguards" : ""}) explore tools=${exploreTools.join(",")}; general tools=${generalTools.join(",")}; outside read asked at root`);
} finally {
  if (pi?.exitCode === null) {
    const closed = new Promise((resolve) => pi.once("close", resolve)); pi.stdin.end();
    let timer; try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("parent failed to shut down")), 10_000); })]); }
    catch (error) { pi.kill(); throw error; } finally { clearTimeout(timer); }
  }
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
