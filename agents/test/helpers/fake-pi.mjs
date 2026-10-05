// RPC transport fixture only: no agent runtime, provider requests, or credentials.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const continuation = args.includes("--session");
const sessionDir = option("--session-dir");
const file = continuation ? option("--session") : path.join(sessionDir, `${option("--session-id")}.jsonl`);
const saved = continuation ? fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
const id = continuation ? saved[0].id : option("--session-id");
let timer, previous = saved.at(-1)?.id ?? null, update;
let model = option("--model"), thinkingLevel = option("--thinking"), tasks = 0;
const configurations = [];
const modelStateFile = path.join(process.cwd(), `fixture-model-${id}.json`);
const writeModelState = () => fs.writeFileSync(modelStateFile, JSON.stringify({ id, pid: process.pid, model, thinkingLevel, tasks, configurations }));
const emit = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const appendEntry = (entry) => {
	fs.mkdirSync(sessionDir, { recursive: true });
	if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: process.cwd() }) + "\n");
	const entryID = randomUUID().slice(0, 8);
	fs.appendFileSync(file, JSON.stringify({ ...entry, id: entryID, parentId: previous, timestamp: new Date().toISOString() }) + "\n");
	previous = entryID;
};
const append = (message) => appendEntry({ type: "message", message });
const received = () => JSON.stringify({
	cwd: process.cwd(), configCwd: process.env.PI_AGENT_CONFIG_CWD,
	permissions: option("--agent-permissions"), model,
	formRoute: process.env.PI_AGENT_FORMS,
	prompt: fs.readFileSync(option("--system-prompt"), "utf8"), continuation,
});
function task(message) {
	const value = JSON.parse(message.slice(message.indexOf("{")));
	fs.writeFileSync(path.join(process.cwd(), "fixture-edits.txt"), value.text);
	fs.writeFileSync(path.join(process.cwd(), "fixture-received.json"), received());
	append({ role: "user", content: message, timestamp: Date.now() });
	tasks++; writeModelState();
	emit({ type: "tool_execution_start", toolCallId: "fixture-write", toolName: "write", args: { path: "fixture-edits.txt" } });
	const finish = () => {
		if (update) emit({ type: "entry_appended", entry: { type: "custom", customType: "subagent-live-applied", data: { sessionID: id, id: update.id, agent: update.update.agent.id } } });
		const result = { role: "assistant", content: [{ type: "text", text: `Fixture wrote ${value.text}` }], stopReason: "stop", timestamp: Date.now() };
		append(result); emit({ type: "message_end", message: result });
		emit({ type: "agent_settled" });
	};
	clearTimeout(timer);
	timer = setTimeout(finish, value.delay ?? 0);
}
const lines = readline.createInterface({ input: process.stdin, terminal: false });
lines.on("line", (line) => {
	const input = JSON.parse(line);
	const reply = (data = {}) => emit({ type: "response", id: input.id, command: input.type, success: true, data });
	if (input.type === "get_state") {
		const identity = path.join(process.cwd(), `fixture-session-identity-${id}.txt`);
		reply({ sessionId: fs.existsSync(identity) ? fs.readFileSync(identity, "utf8") : id, steeringMode: "one-at-a-time", isStreaming: !!timer });
	} else if (input.type === "set_model") {
		if (fs.existsSync(path.join(process.cwd(), `fixture-reject-model-${id}`))) {
			emit({ type: "response", id: input.id, command: input.type, success: false, error: "Fixture rejected model update" }); return;
		}
		model = `${input.provider}/${input.modelId}`;
		configurations.push({ type: input.type, model }); writeModelState();
		appendEntry({ type: "model_change", provider: input.provider, modelId: input.modelId });
		reply({ provider: input.provider, id: input.modelId });
	} else if (input.type === "set_thinking_level") {
		thinkingLevel = input.level;
		configurations.push({ type: input.type, thinkingLevel }); writeModelState();
		appendEntry({ type: "thinking_level_change", thinkingLevel }); reply();
	} else if (input.type === "get_commands") reply({ commands: [{ name: "agent-live-prepare" }] });
	else if (input.type === "prompt" && input.message.startsWith("/agent-live-prepare ")) {
		const encoded = input.message.split(" ")[2];
		update = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
		emit({ type: "entry_appended", entry: { type: "custom", customType: "subagent-live-prepared", data: { sessionID: id, id: update.id, ok: true } } });
		reply({ disposition: "handled" });
	} else if (input.type === "prompt" || input.type === "steer") {
		emit({ type: "agent_start" });
		task(input.message);
		reply({ disposition: input.type === "steer" ? "queued" : "started" });
	} else if (input.type === "abort" || input.type === "clear_queue") reply();
	else emit({ type: "response", id: input.id, command: input.type, success: false, error: `Unsupported fixture command: ${input.type}` });
});
lines.on("close", () => { clearTimeout(timer); process.exitCode = 0; });
process.on("SIGTERM", () => { clearTimeout(timer); process.exit(0); });
