import fs from "node:fs/promises";
import path from "node:path";
import { childDiscovery, childSessionDir, listOwnedChildren, type OwnerContext } from "./ownership.ts";

export interface FamilyChild {
	id: string;
	agent: string;
	description?: string;
	status?: "running" | "completed" | "error" | "cancelled";
	file?: string;
	owner: OwnerContext;
	depth: number;
	prefix: string;
}

/** Follow verified parent claims, not arbitrary transcripts or workspace job IDs. */
export async function listSessionFamily(owner: OwnerContext, legacyDir: string): Promise<FamilyChild[]> {
	const seen = new Set([owner.parentID]);
	const family: FamilyChild[] = [];
	const discovery = childDiscovery();
	async function walk(current: OwnerContext, legacySessionDir: string, ancestors: boolean[]): Promise<void> {
		const legacy = { ...current, sessionDir: legacySessionDir };
		const [modern, older] = await Promise.all([listOwnedChildren(current, discovery), listOwnedChildren(legacy, discovery)]);
		const discovered = [
			...modern.map((child) => ({ ...child, owner: current })),
			...older.filter((child) => !modern.some((entry) => entry.id === child.id)).map((child) => ({ ...child, owner: legacy })),
		].filter((child) => !seen.has(child.id));
		// V2 uses updated-descending siblings; transcript mtime is Pi's equivalent.
		const updated = await Promise.all(discovered.map(async (child) => ({ child, time:
			await fs.stat(child.file ?? path.join(child.owner.sessionDir, ".pi-agents-owners", `${child.id}.json`)).then((stat) => stat.mtimeMs).catch(() => 0),
		})));
		const children = updated.sort((a, b) => b.time - a.time || a.child.id.localeCompare(b.child.id)).map((entry) => entry.child);
		for (const [index, child] of children.entries()) {
			if (seen.has(child.id)) continue;
			seen.add(child.id);
			const last = index === children.length - 1;
			const prefix = ancestors.length === 0 ? "" : ancestors.slice(1).map((ancestor) => ancestor ? "   " : "│  ").join("") + (last ? "└─ " : "├─ ");
			family.push({ ...child, depth: ancestors.length + 1, prefix });
			await walk({ cwd: current.cwd, parentID: child.id, parentFile: child.file,
				sessionDir: childSessionDir(child.owner.sessionDir, child.id) }, child.owner.sessionDir, [...ancestors, last]);
		}
	}
	await walk(owner, legacyDir, []);
	return family;
}
