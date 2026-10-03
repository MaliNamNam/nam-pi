import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { OwnerContext } from "./ownership.ts";

function endpoint(owner: OwnerContext, id: string): string {
	if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/.test(id)) throw new Error("Invalid child session ID");
	return path.join(owner.sessionDir, ".pi-agents-interrupts", `${id}.json`);
}

async function readToken(file: string): Promise<string | undefined> {
	try {
		const token = JSON.parse(await fs.readFile(file, "utf8"))?.token;
		return typeof token === "string" && /^[a-f0-9-]{36}$/.test(token) ? token : undefined;
	} catch { return undefined; }
}

interface Registration {
	file: string;
	token: string;
	active(): boolean;
	interrupt(): Promise<string>;
}

/** Route a request to the process retaining the live handle, never to a saved PID. */
export class ChildInterrupts {
	private readonly registrations = new Map<string, Registration>();
	private timer?: ReturnType<typeof setInterval>;
	private polling = false;
	private disposed = false;

	async register(owner: OwnerContext, id: string, active: () => boolean, interrupt: () => Promise<string>): Promise<void> {
		if (this.disposed) return;
		const file = endpoint(owner, id), token = randomUUID();
		await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		const registration = { file, token, active, interrupt };
		await withFileMutationQueue(file, async () => {
			if (this.disposed) return;
			await fs.writeFile(file, JSON.stringify({ token }), { mode: 0o600 });
			this.registrations.set(id, registration);
		});
		if (this.disposed) { await this.release(registration); return; }
		if (!this.timer) {
			this.timer = setInterval(() => { void this.poll().catch(() => {}); }, 200);
			this.timer.unref();
		}
	}

	async poll(): Promise<void> {
		if (this.disposed || this.polling) return;
		this.polling = true;
		try {
			for (const [id, registration] of this.registrations) {
				if (!registration.active()) {
					this.registrations.delete(id);
					await this.release(registration);
					continue;
				}
				const request = `${registration.file}.${registration.token}.cancel`;
				const pending = await fs.readFile(request, "utf8").catch(() => "");
				if (pending !== "pending" || this.disposed || this.registrations.get(id) !== registration || !registration.active()) continue;
				const message = await registration.interrupt().catch(() => `Unable to interrupt ${id}`);
				await fs.writeFile(request, JSON.stringify({ message }), { mode: 0o600 });
			}
		} finally {
			this.polling = false;
			if (!this.registrations.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
		}
	}

	private async release(registration: Registration): Promise<void> {
		await withFileMutationQueue(registration.file, async () => {
			if (await readToken(registration.file) === registration.token) await fs.rm(registration.file, { force: true });
		});
	}
	async dispose(): Promise<void> {
		this.disposed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		const registrations = [...this.registrations.values()];
		this.registrations.clear();
		await Promise.all(registrations.map((registration) => this.release(registration)));
	}
}

/** A per-run nonce prevents an old request from interrupting a later continuation. */
export async function requestChildInterrupt(owner: OwnerContext, id: string, timeout = 5000): Promise<string> {
	const file = endpoint(owner, id);
	const token = await readToken(file);
	if (!token) return `Cannot safely interrupt ${id}: its owning process is unavailable`;
	const request = `${file}.${token}.cancel`;
	try {
		await fs.writeFile(request, "pending", { flag: "wx", mode: 0o600 });
	} catch { return `Cannot request interrupt for ${id}: another request is pending or its owner is unavailable`; }
	try {
		const until = Date.now() + timeout;
		do {
			try {
				const reply = JSON.parse(await fs.readFile(request, "utf8"));
				if (typeof reply?.message === "string") return reply.message;
			} catch { /* the owner has not acknowledged the request yet */ }
			await new Promise((resolve) => setTimeout(resolve, 50));
		} while (Date.now() < until);
		return `Cannot safely interrupt ${id}: its owning process did not acknowledge the request`;
	} finally { await fs.rm(request, { force: true }); }
}
