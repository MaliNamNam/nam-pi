import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface PermissionCheck { action: string; resource: string; }
export interface PermissionForm { kind: "permission"; tool: string; reason: string; checks: PermissionCheck[]; }
export interface QuestionPrompt { header: string; question: string; options: Array<{ label: string; description: string }>; multiple?: boolean; }
export interface QuestionForm { kind: "question"; questions: QuestionPrompt[]; }
export type FormPayload = PermissionForm | QuestionForm;
export interface FormRequest { id: string; sessionID: string; payload: FormPayload; interactionID?: string; }
export type RejectionReason = "declined" | "unavailable" | "timeout" | "cancelled";
export interface FormReply { reply: "once" | "always" | "reject"; answers?: string[][]; reason?: RejectionReason; }
const REJECT: FormReply = { reply: "reject", reason: "unavailable" };
const CANCELLED: FormReply = { reply: "reject", reason: "cancelled" };
const DECLINED: FormReply = { reply: "reject", reason: "declined" };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SESSION = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
const LEASE_MS = 3000;

async function fresh(file: string): Promise<boolean> {
	return fs.stat(file).then((stat) => Date.now() - stat.mtimeMs < LEASE_MS).catch(() => false);
}
function validRequest(value: FormRequest, id: string): boolean {
	const form = value?.payload;
	if (value?.id !== id || typeof value.sessionID !== "string" || !SESSION.test(value.sessionID) ||
		(value.interactionID !== undefined && (typeof value.interactionID !== "string" || !UUID.test(value.interactionID)))) return false;
	if (form?.kind === "question") return Array.isArray(form.questions) && form.questions.length > 0 && form.questions.every((question) =>
		typeof question?.header === "string" && typeof question.question === "string" &&
		(question.multiple === undefined || typeof question.multiple === "boolean") && Array.isArray(question.options) &&
		question.options.every((option) => typeof option?.label === "string" && typeof option.description === "string"));
	return form?.kind === "permission" && typeof form.tool === "string" && typeof form.reason === "string" &&
		Array.isArray(form.checks) && form.checks.length > 0 && form.checks.every((check) =>
			typeof check?.action === "string" && typeof check.resource === "string");
}

export function permissionKey(check: PermissionCheck): string { return JSON.stringify([check.action, check.resource]); }
function validReply(reply: FormReply, payload: FormPayload): boolean {
	if (reply?.reply === "reject") return reply.reason === undefined || ["declined", "unavailable", "timeout", "cancelled"].includes(reply.reason);
	if (payload.kind === "permission") return reply?.reply === "once" || reply?.reply === "always";
	return reply?.reply === "once" && Array.isArray(reply.answers) && reply.answers.length === payload.questions.length &&
		reply.answers.every((answer, index) => Array.isArray(answer) && answer.length > 0 &&
			(payload.questions[index].multiple || answer.length === 1) && answer.every((value) => typeof value === "string" && value.trim()));
}

/** A session-owned root UI queue; fresh leases discard forms from exited child runs. */
export class FormHost {
	readonly route: string;
	private readonly directory: string;
	private timer?: ReturnType<typeof setInterval>;
	private disposed = false;
	private polling = false;
	private active?: { id: string; aborter: AbortController };
	private count = 0;
	private readonly approved = new Set<string>();
	/** Declines are scoped to a requesting execution, never its later turns/siblings. */
	private readonly declined = new Set<string>();
	private group(request: FormRequest): string | undefined {
		return request.interactionID ? JSON.stringify([request.sessionID, request.interactionID]) : undefined;
	}
	private readonly handled = new Set<string>();
	private constructor(directory: string, privateHandler: (request: FormRequest, signal: AbortSignal) => Promise<FormReply>,
		privateOwners: () => Promise<Set<string>>, privateVisible: () => boolean) {
		this.directory = directory;
		this.route = JSON.stringify({ directory });
		this.handler = privateHandler; this.owners = privateOwners; this.visible = privateVisible;
	}
	private readonly handler: (request: FormRequest, signal: AbortSignal) => Promise<FormReply>;
	private readonly owners: () => Promise<Set<string>>;
	private readonly visible: () => boolean;
	get pendingCount(): number { return this.count; }
	get isShowing(): boolean { return !!this.active; }
	static async create(directory: string, handler: FormHost["handler"], owners: FormHost["owners"], visible = () => true): Promise<FormHost> {
		const host = new FormHost(path.join(directory, ".pi-agents-forms", randomUUID()), handler, owners, visible);
		await fs.mkdir(host.directory, { recursive: true, mode: 0o700 });
		await fs.writeFile(path.join(host.directory, "lease"), "", { mode: 0o600 });
		host.timer = setInterval(() => { void host.poll().catch(() => {}); }, 150);
		host.timer.unref();
		return host;
	}
	private async poll(): Promise<void> {
		if (this.disposed || this.polling) return;
		this.polling = true;
		try {
			await fs.utimes(path.join(this.directory, "lease"), new Date(), new Date());
			const files = await fs.readdir(this.directory);
			let owners: Set<string> | undefined;
			const pending: FormRequest[] = [];
			const live = new Set<string>();
			for (const file of files) {
				const id = file.replace(/\.request$/, "");
				if (!file.endsWith(".request") || !UUID.test(id) || !await fresh(path.join(this.directory, file))) continue;
				let request: FormRequest;
				try {
					if ((await fs.stat(path.join(this.directory, file))).size > 128 * 1024) continue;
					request = JSON.parse(await fs.readFile(path.join(this.directory, file), "utf8"));
				} catch { continue; }
				if (validRequest(request, id)) owners ??= await this.owners();
				if (!validRequest(request, id) || !owners?.has(request.sessionID)) {
					await fs.writeFile(path.join(this.directory, `${id}.reply`), JSON.stringify(REJECT), { mode: 0o600 });
					continue;
				}
				live.add(id);
				const group = this.group(request);
				if (group && this.declined.has(group)) {
					if (!this.handled.has(id)) {
						this.handled.add(id);
						await fs.writeFile(path.join(this.directory, `${id}.reply`), JSON.stringify(DECLINED), { mode: 0o600 });
					}
					continue;
				}
				// Client cleanup may remove the reply just before the request file.
				// A call ID must never open a second dialog during that window.
				if (this.handled.has(id)) continue;
				if (await fs.access(path.join(this.directory, `${id}.reply`)).then(() => true).catch(() => false)) continue;
				if (request.payload.kind === "permission" && request.payload.checks.every((check) => this.approved.has(permissionKey(check)))) {
					this.handled.add(id);
					await fs.writeFile(path.join(this.directory, `${id}.reply`), JSON.stringify({ reply: "once" }), { mode: 0o600 });
					continue;
				}
				pending.push(request);
			}
			// Permission prompts take precedence over question forms, as in V2.
			pending.sort((a, b) => Number(b.payload.kind === "permission") - Number(a.payload.kind === "permission"));
			this.count = pending.length;
			if (this.active && !live.has(this.active.id)) this.active.aborter.abort();
			if (this.disposed || this.active || !this.visible() || !pending.length) return;
			const request = pending[0], active = { id: request.id, aborter: new AbortController() };
			this.handled.add(request.id);
			this.active = active;
			void this.handler(request, active.aborter.signal).catch(() => REJECT).then(async (reply) => {
				if (!this.disposed && !active.aborter.signal.aborted && await fresh(path.join(this.directory, `${request.id}.request`))) {
					if (!validReply(reply, request.payload)) reply = REJECT;
					const group = this.group(request);
					if (reply.reply === "reject" && reply.reason === "declined" && group) this.declined.add(group);
					const file = path.join(this.directory, `${request.id}.reply`);
					await fs.writeFile(file, JSON.stringify(reply), { mode: 0o600 });
					if (reply.reply === "always" && request.payload.kind === "permission") {
						// Save only after the still-live caller accepts this exact reply.
						// An exited/cancelled caller cannot leave a grant for later runs.
						const until = Date.now() + LEASE_MS;
						do {
							if (this.disposed || active.aborter.signal.aborted || !await fresh(path.join(this.directory, `${request.id}.request`))) break;
							if (await fs.readFile(path.join(this.directory, `${request.id}.ack`), "utf8").catch(() => "") === "accepted") {
								for (const check of request.payload.checks) if (check.action !== "question") this.approved.add(permissionKey(check));
								await fs.writeFile(file, JSON.stringify({ ...reply, saved: true }), { mode: 0o600 });
								break;
							}
							await new Promise((resolve) => setTimeout(resolve, 50));
						} while (Date.now() < until);
					}
				}
			}).catch(() => {}).finally(() => { if (this.active === active) this.active = undefined; });
		} finally { this.polling = false; }
	}
	async dispose(): Promise<void> {
		this.disposed = true;
		if (this.timer) clearInterval(this.timer);
		this.active?.aborter.abort();
		this.count = 0;
		// This exact nonce directory was created by this host; never remove its parent.
		await fs.rm(this.directory, { recursive: true, force: true });
	}
}

/** Replies are bound to a fresh root route and a random per-call ID, never a saved PID. */
export async function requestForm(route: string | undefined, sessionID: string, payload: FormPayload,
	signal?: AbortSignal, timeout = 60_000, interactionID?: string): Promise<FormReply> {
	let directory: string;
	try {
		directory = JSON.parse(route ?? "")?.directory;
		if (typeof directory !== "string" || !path.isAbsolute(directory) || !UUID.test(path.basename(directory)) || !SESSION.test(sessionID)) return REJECT;
	} catch { return REJECT; }
	if (signal?.aborted) return CANCELLED;
	if (!await fresh(path.join(directory, "lease"))) return REJECT;
	const id = randomUUID(), request = path.join(directory, `${id}.request`), reply = path.join(directory, `${id}.reply`);
	const acknowledgement = path.join(directory, `${id}.ack`);
	if (!validRequest({ id, sessionID, payload, interactionID }, id) || JSON.stringify(payload).length > 120 * 1024) return REJECT;
	const temporary = `${request}.tmp`;
	try {
		await fs.writeFile(temporary, JSON.stringify({ id, sessionID, payload, interactionID }), { flag: "wx", mode: 0o600 });
		await fs.rename(temporary, request);
		const until = Date.now() + timeout;
		do {
			if (signal?.aborted) return CANCELLED;
			if (!await fresh(path.join(directory, "lease"))) return REJECT;
			try {
				const response = JSON.parse(await fs.readFile(reply, "utf8"));
				if (validReply(response, payload) && !signal?.aborted) {
					if (response.reply !== "always" || response.saved) return { reply: response.reply, ...(response.answers ? { answers: response.answers } : {}), ...(response.reason ? { reason: response.reason } : {}) };
					await fs.writeFile(acknowledgement, "accepted", { mode: 0o600 });
				}
			} catch { /* wait for the root UI */ }
			await fs.utimes(request, new Date(), new Date());
			await new Promise((resolve) => setTimeout(resolve, 100));
		} while (Date.now() < until);
		return { reply: "reject", reason: "timeout" };
	} catch { return signal?.aborted ? CANCELLED : REJECT; }
	finally { await Promise.all([request, reply, temporary, acknowledgement].map((file) => fs.rm(file, { force: true }).catch(() => {}))); }
}
