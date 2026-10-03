import type { LiveInputUpdate } from "./live-input.ts";

/** Admission is not completion: input can be consumed by a child extension. */
export type InputDisposition = "queued" | "handled";

/** Serialize admission (not whole runs), and revoke on abort, settlement or failure. */
export class ChildInput {
	private open = true;
	private tail: Promise<unknown> = Promise.resolve();
	private readonly accept: (text: string, update?: LiveInputUpdate, signal?: AbortSignal) => Promise<InputDisposition>;
	private readonly live: () => boolean;
	constructor(accept: ChildInput["accept"], live: ChildInput["live"]) { this.accept = accept; this.live = live; }
	close(): void { this.open = false; }
	steer(text: string, signal?: AbortSignal, update?: LiveInputUpdate): Promise<InputDisposition> {
		const task = this.tail.catch(() => {}).then(async () => {
			if (!this.open || !this.live()) throw new Error("This child run no longer accepts input; wait for its result before continuing");
			if (signal?.aborted) throw new Error("Child input cancelled before admission");
			if (!text.trim() || Buffer.byteLength(text, "utf8") > 1024 * 1024) throw new Error("Child input must be nonempty and at most 1 MiB");
			// Once sent, a lost acknowledgement is uncertain. Never automatically
			// replay it or create another writer, even if the caller cancels.
			return this.accept(text, update, signal);
		});
		this.tail = task;
		return task;
	}
}
