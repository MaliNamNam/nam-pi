import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { SessionManager, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

/** Persisted outside the conversation so child sessions can be checked after restart. */
interface ChildOwner {
	id: string;
	parentID: string;
	parentFile?: string;
	cwd: string;
	agent: string;
	description?: string;
	status?: "running" | "completed" | "error" | "cancelled";
}

export interface OwnerContext {
	cwd: string;
	sessionDir: string;
	parentID: string;
	parentFile?: string;
}

/* Pi's /resume scans only direct .jsonl files in the project session dir.
 * Keep isolated children under it, indexed by their parent, not beside it. */
export function childSessionDir(parentSessionDir: string, parentID: string): string {
	const key = createHash("sha256").update(parentID).digest("hex").slice(0, 20);
	return path.join(parentSessionDir, ".pi-subagents", key);
}

function safeID(id: string): boolean {
	return /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/.test(id);
}

function ownerPath(context: OwnerContext, id: string): string {
	if (!safeID(id)) throw new Error(`Invalid subagent sessionID: ${id}`);
	return path.join(context.sessionDir, ".pi-agents-owners", `${id}.json`);
}

/** Claim a newly generated id before spawning; never overwrite someone else's claim. */
export async function claimChild(context: OwnerContext, id: string, agent: string, description?: string): Promise<void> {
	const file = ownerPath(context, id);
	if (SessionManager.findById(context.cwd, id, context.sessionDir)) {
		throw new Error(`Subagent session ID already exists: ${id}`);
	}
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const owner: ChildOwner = {
		id, parentID: context.parentID, parentFile: context.parentFile,
		cwd: path.resolve(context.cwd), agent,
		...(description ? { description, status: "running" as const } : {}),
	};
	const handle = await fs.open(file, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
	} catch (error) {
		await handle.close();
		await fs.rm(file, { force: true });
		throw error;
	}
	await handle.close();
}

/** Only an exact child of this parent in this workspace/session store may resume. */
export async function findOwnedChild(
	context: OwnerContext, id: string,
): Promise<{ file: string; agent: string } | undefined> {
	if (!safeID(id)) return undefined;
	let owner: ChildOwner;
	try {
		owner = JSON.parse(await fs.readFile(ownerPath(context, id), "utf8")) as ChildOwner;
	} catch {
		return undefined;
	}
	if (
		owner.id !== id || owner.parentID !== context.parentID ||
		owner.parentFile !== context.parentFile ||
		owner.cwd !== path.resolve(context.cwd) || typeof owner.agent !== "string"
	) return undefined;
	// --session-id creates a session if missing. Never continue with that flag:
	// look up the exact persisted file and pass it via --session instead.
	const file = SessionManager.findById(context.cwd, id, context.sessionDir);
	if (!file || path.resolve(path.dirname(file)) !== path.resolve(context.sessionDir)) return undefined;
	return { file, agent: owner.agent };
}

/** Per-discovery indexes: shared legacy stores are scanned once, asynchronously. */
export interface ChildDiscovery {
	claims: Map<string, Promise<ChildOwner[]>>;
	sessions: Map<string, Promise<Map<string, string>>>;
}
export function childDiscovery(): ChildDiscovery { return { claims: new Map(), sessions: new Map() }; }

async function sessionFiles(directory: string): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	const entries = await fs.readdir(directory).catch(() => [] as string[]);
	for (const name of entries) {
		if (!name.endsWith(".jsonl")) continue;
		const file = path.join(directory, name);
		let handle;
		try {
			handle = await fs.open(file, "r");
			const buffer = Buffer.alloc(16 * 1024);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			const header = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0]);
			if (header?.type === "session" && typeof header.id === "string" && !files.has(header.id)) files.set(header.id, file);
		} catch { /* incomplete or unrelated session headers are never adopted */ }
		finally { await handle?.close(); }
	}
	return files;
}

async function readClaims(directory: string): Promise<ChildOwner[]> {
	const claims: ChildOwner[] = [];
	const entries = await fs.readdir(directory).catch(() => [] as string[]);
	for (const entry of entries) {
		if (!entry.endsWith(".json") || !safeID(entry.slice(0, -5))) continue;
		try {
			const owner = JSON.parse(await fs.readFile(path.join(directory, entry), "utf8")) as ChildOwner;
			if (owner?.id === entry.slice(0, -5)) claims.push(owner);
		} catch { /* partial or foreign records are not claims */ }
	}
	return claims;
}

/** List only claims belonging to this parent, including children not yet flushed. */
export interface OwnedChildInfo {
	id: string;
	agent: string;
	file?: string;
	description?: string;
	status?: ChildOwner["status"];
}

export async function listOwnedChildren(context: OwnerContext, discovery = childDiscovery()): Promise<OwnedChildInfo[]> {
	const directory = path.join(context.sessionDir, ".pi-agents-owners");
	if (!discovery.claims.has(directory)) discovery.claims.set(directory, readClaims(directory));
	const owners = (await discovery.claims.get(directory)!).filter((owner) => owner.parentID === context.parentID &&
		owner.parentFile === context.parentFile && owner.cwd === path.resolve(context.cwd) && typeof owner.agent === "string");
	if (!owners.length) return [];
	if (!discovery.sessions.has(context.sessionDir)) discovery.sessions.set(context.sessionDir, sessionFiles(context.sessionDir));
	const files = await discovery.sessions.get(context.sessionDir)!;
	return owners.map((owner) => ({ id: owner.id, agent: owner.agent, ...(files.has(owner.id) ? { file: files.get(owner.id) } : {}),
		...(typeof owner.description === "string" ? { description: owner.description } : {}),
		...(["running", "completed", "error", "cancelled"].includes(owner.status ?? "") ? { status: owner.status } : {}),
	})).toSorted((a, b) => a.id.localeCompare(b.id));
}

/** Relocate a settled, verified legacy child so it disappears from /resume. */
export async function migrateOwnedChild(from: OwnerContext, to: OwnerContext, id: string): Promise<boolean> {
	if (from.parentID !== to.parentID || from.parentFile !== to.parentFile ||
		path.resolve(from.cwd) !== path.resolve(to.cwd)) return false;
	const owned = await findOwnedChild(from, id);
	if (!owned || await findOwnedChild(to, id) || SessionManager.findById(to.cwd, id, to.sessionDir)) return false;
	await fs.mkdir(to.sessionDir, { recursive: true, mode: 0o700 });
	const destination = path.join(to.sessionDir, path.basename(owned.file));
	const newClaim = ownerPath(to, id);
	await fs.mkdir(path.dirname(newClaim), { recursive: true, mode: 0o700 });
	try { await fs.access(newClaim); return false; } catch { /* no destination claim */ }
	try { await fs.access(destination); return false; } catch { /* no destination session */ }
	try {
		await fs.rename(owned.file, destination);
		await fs.rename(ownerPath(from, id), newClaim);
	} catch (error) {
		// Retain the old claim if the second rename fails. Best-effort rollback;
		// an unclaimed moved session is never silently adopted.
		try { await fs.rename(destination, owned.file); } catch { /* require manual recovery */ }
		throw error;
	}
	return true;
}

const ownerWrites = new Map<string, Promise<void>>();

/** Queue before SDK realpath registration too: on Windows that lookup can briefly lock a rename target. */
async function serializeOwnerWrite(file: string, write: () => Promise<void>): Promise<void> {
	const key = process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
	const work = (ownerWrites.get(key) ?? Promise.resolve()).catch(() => {}).then(write);
	ownerWrites.set(key, work);
	try { await work; } finally { if (ownerWrites.get(key) === work) ownerWrites.delete(key); }
}

/** Keep applied-role receipts and lifecycle status in one atomic root-owned update sequence. */
async function mutateOwner(context: OwnerContext, id: string, update: (owner: ChildOwner) => Promise<ChildOwner> | ChildOwner, current = () => true): Promise<void> {
	const file = ownerPath(context, id);
	await serializeOwnerWrite(file, () => withFileMutationQueue(file, async () => {
		if (!current()) return;
		const owner = JSON.parse(await fs.readFile(file, "utf8")) as ChildOwner;
		if (!owner || owner.id !== id || owner.parentID !== context.parentID || owner.parentFile !== context.parentFile ||
			owner.cwd !== path.resolve(context.cwd)) throw new Error("Child ownership changed");
		const updated = await update(owner);
		if (!current()) return;
		const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(temporary, JSON.stringify(updated) + "\n", { flag: "wx", mode: 0o600 });
			if (current()) await fs.rename(temporary, file);
		} finally { await fs.rm(temporary, { force: true }); }
	}));
}

/** Record a verified switch; late live receipts can revoke their generation before commit. */
export async function switchChildAgent(context: OwnerContext, id: string, agent: string, current?: () => boolean): Promise<void> {
	await mutateOwner(context, id, async (owner) => {
		if (!await findOwnedChild(context, id)) throw new Error(`Subagent session ${id} is no longer owned by this session`);
		return { ...owner, agent };
	}, current);
}

/** Persist UI state without changing ownership, including failed children with no transcript. */
export async function setChildStatus(context: OwnerContext, id: string, status: NonNullable<ChildOwner["status"]>): Promise<void> {
	await mutateOwner(context, id, (owner) => ({ ...owner, status }));
}

/** A failed launch must not leave an ID reserved forever. */
export async function forgetChild(context: OwnerContext, id: string): Promise<void> {
	await fs.rm(ownerPath(context, id), { force: true });
}
