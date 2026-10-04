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
const emit = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const append = (message) => {
	fs.mkdirSync(sessionDir, { recursive: true });
	if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: process.cwd() }) + "\n");
	const entryID = randomUUID().slice(0, 8);
	fs.appendFileSync(file, JSON.stringify({ type: "message", id: entryID, parentId: previous, timestamp: new Date().toISOString(), message }) + "\n");
	previous = entryID;
};
const received = () => JSON.stringify({
	cwd: process.cwd(), configCwd: process.env.PI_AGENT_CONFIG_CWD,
	permissions: option("--agent-permissions"), model: option("--model"),
	formRoute: process.env.PI_AGENT_FORMS,
	prompt: fs.readFileSync(option("--system-prompt"), "utf8"), continuation,
});
function task(message) {
	const value = JSON.parse(message.slice(message.indexOf("{")));
	fs.writeFileSync(path.join(process.cwd(), "fixture-edits.txt"), value.text);
	fs.writeFileSync(path.join(process.cwd(), "fixture-received.json"), received());
	append({ role: "user", content: message, timestamp: Date.now() });
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
	if (input.type === "get_state") reply({ sessionId: id, steeringMode: "one-at-a-time" });
	else if (input.type === "get_commands") reply({ commands: [{ name: "agent-live-prepare" }] });
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
	else reply();
});
lines.on("close", () => { clearTimeout(timer); process.exitCode = 0; });
process.on("SIGTERM", () => { clearTimeout(timer); process.exit(0); });
