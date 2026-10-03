import fs from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { forgetDetachedResult, type DetachedRun, type PiEvent, type RunOptions, type RunResult, type Usage } from "./runner.ts";

interface ChildOutput { settled: boolean; cancelled?: boolean; output: string; error?: string; usage: Usage; model?: string; }

/**
 * Await an owned child while following its file-backed event stream.
 * Ctrl+B relinquishes the wait, not the child. Its stdout already belongs to a
 * file, so the same child can continue while the parent handles another turn.
 */
export async function awaitForeground(
	run: DetachedRun, options: RunOptions, readResult: (file: string) => Promise<ChildOutput>,
): Promise<RunResult> {
	const sessionID = options.sessionID!;
	return new Promise<RunResult>((resolve) => {
		let finished = false;
		let aborted = false;
		let movedToBackground = false;
		let position = 0;
		let buffer = "";
		let reading: Promise<void> | undefined;
		let escalation: ReturnType<typeof setTimeout> | undefined;
		const decoder = new StringDecoder("utf8");
		const processLine = (line: string): void => {
			let event: PiEvent;
			try { event = JSON.parse(line) as PiEvent; } catch { return; }
			if (!event || typeof event !== "object" || !event.type) return;
			if (!movedToBackground) try { options.onEvent?.(event); } catch { /* a stale UI must not leave a child untracked */ }
		};
		const readProgress = (): Promise<void> => {
			if (reading) return reading;
			reading = (async () => {
				let handle;
				try {
					handle = await fs.open(run.outputPath, "r");
					const size = (await handle.stat()).size;
					while (position < size) {
						const bytes = Buffer.alloc(Math.min(size - position, 64 * 1024));
						const { bytesRead } = await handle.read(bytes, 0, bytes.length, position);
						if (!bytesRead) break;
						position += bytesRead;
						buffer += decoder.write(bytes.subarray(0, bytesRead));
						for (let end; (end = buffer.indexOf("\n")) !== -1;) {
							processLine(buffer.slice(0, end));
							buffer = buffer.slice(end + 1);
						}
					}
				} catch { /* retry partial or temporarily inaccessible output */ }
				finally { await handle?.close(); }
			})().finally(() => { reading = undefined; });
			return reading;
		};
		const timer = setInterval(() => { if (!finished) void readProgress(); }, 50);
		const cleanup = (): void => {
			clearInterval(timer);
			if (escalation) clearTimeout(escalation);
			options.signal?.removeEventListener("abort", abort);
			options.backgroundSignal?.removeEventListener("abort", background);
			run.child.removeListener("close", closed);
		};
		const finish = async (backgrounded: boolean, code: number): Promise<void> => {
			if (finished) return;
			finished = true;
			movedToBackground = backgrounded && !aborted;
			cleanup();
			if (movedToBackground) {
				resolve({ sessionID, status: "running", detached: run, output: "", exitCode: 0,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, stderr: "" });
				return;
			}
			try {
				await readProgress();
				await readProgress(); // collect bytes written while the previous read was in flight
				const result = await readResult(run.outputPath);
				const status = aborted || result.cancelled ? "cancelled" : code !== 0 || result.error ? "error" : "completed";
				let error = result.error;
				if (status === "error" && !error) {
					const raw = await fs.readFile(run.outputPath, "utf8").catch(() => "");
					error = raw.split("\n").filter((line) => line.trim() && !line.trim().startsWith("{")).slice(-5).join("\n") || `Subagent exited with code ${code}`;
				}
				resolve({ sessionID, status, output: result.output, error, exitCode: code, usage: result.usage, model: result.model, stderr: "" });
				forgetDetachedResult(run.outputPath);
				await fs.rm(run.outputPath, { force: true }).catch(() => {});
			} catch (error) {
				resolve({ sessionID, status: "error", output: "", exitCode: 1, error: String(error), stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } });
			}
		};
		function abort(): void {
			if (finished) return;
			aborted = true;
			run.child.kill("SIGTERM");
			if (!finished) escalation = setTimeout(() => {
				if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
			}, 5000);
		}
		function background(): void { if (!aborted) void finish(true, 0); }
		function closed(code: number | null): void { void finish(false, code ?? 1); }
		run.child.once("close", closed);
		options.signal?.addEventListener("abort", abort, { once: true });
		options.backgroundSignal?.addEventListener("abort", background, { once: true });
		if (options.signal?.aborted) abort();
		else if (options.backgroundSignal?.aborted) background();
		if (!finished && (run.child.exitCode !== null || run.child.signalCode !== null)) closed(run.child.exitCode);
	});
}
