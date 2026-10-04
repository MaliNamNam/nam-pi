// Separate-process allocation fixture, not a Pi child or model-backed agent.
import { createWorktree } from "../../src/worktrees.ts";

let controller;
process.on("message", async (message) => {
	if (message.type === "abort") { controller?.abort(); return; }
	if (message.type !== "create" || controller) return;
	controller = new AbortController();
	const pending = createWorktree(message.workspace, controller.signal);
	process.send({ type: "started" });
	try {
		await pending;
		process.send({ type: "done", ok: true });
	} catch (error) {
		process.send({ type: "done", ok: false, error: error instanceof Error ? error.message : String(error) });
	} finally { process.disconnect(); }
});
process.send({ type: "ready" });
