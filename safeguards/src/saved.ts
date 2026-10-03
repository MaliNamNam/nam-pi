/**
 * Persistent "always allow" grants.
 *
 * Mirrors OpenCode's `PermissionSaved`: approved patterns are stored per project
 * so a later session does not ask again. Stored as JSON at
 * `<agent-dir>/safeguards-allow.json`.
 *
 * Saved rules can only ever produce `allow`. Explicit `deny` rules from config
 * are evaluated first and always win, so a stale grant cannot unlock something
 * the user has since denied.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Rule, Ruleset } from "./types.ts";

interface StoreFile {
	version: 1;
	projects: Record<string, Rule[]>;
}

const STORE_VERSION = 1;

function storePath(): string {
	return join(getAgentDir(), "safeguards-allow.json");
}

function emptyStore(): StoreFile {
	return { version: STORE_VERSION, projects: {} };
}

function readStore(): StoreFile {
	const file = storePath();
	if (!existsSync(file)) return emptyStore();
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object") return emptyStore();
		const record = parsed as Partial<StoreFile>;
		if (record.version !== STORE_VERSION || !record.projects) return emptyStore();
		return { version: STORE_VERSION, projects: record.projects };
	} catch {
		return emptyStore();
	}
}

function writeStore(store: StoreFile): void {
	const file = storePath();
	try {
		mkdirSync(dirname(file), { recursive: true });
		const temporary = `${file}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, "utf8");
		renameSync(temporary, file);
	} catch {
		// A failed write must never break a tool call. The grant simply does not persist.
	}
}

export class SavedPermissions {
	private store: StoreFile;
	private readonly projectId: string;

	constructor(projectId: string) {
		this.projectId = projectId;
		this.store = readStore();
	}

	rules(): Ruleset {
		return this.store.projects[this.projectId] ?? [];
	}

	has(action: string, resource: string): boolean {
		const rules = this.rules();
		for (let index = rules.length - 1; index >= 0; index--) {
			const rule = rules[index];
			if (rule.action !== action) continue;
			if (rule.resource === resource) return true;
		}
		return false;
	}

	/** Add grants. Returns the rules that were actually new. */
	add(action: string, resources: string[]): Ruleset {
		const current = this.store.projects[this.projectId] ?? [];
		const added: Ruleset = [];
		for (const resource of resources) {
			if (!resource) continue;
			if (current.some((rule) => rule.action === action && rule.resource === resource)) continue;
			const rule: Rule = { action, resource, effect: "allow" };
			current.push(rule);
			added.push(rule);
		}
		if (added.length === 0) return [];
		this.store.projects[this.projectId] = current;
		writeStore(this.store);
		return added;
	}

	/** Remove one grant. Returns true when something was removed. */
	remove(action: string, resource: string): boolean {
		const current = this.store.projects[this.projectId] ?? [];
		const next = current.filter((rule) => !(rule.action === action && rule.resource === resource));
		if (next.length === current.length) return false;
		this.store.projects[this.projectId] = next;
		writeStore(this.store);
		return true;
	}

	/** Clear every grant for this project. Returns how many were removed. */
	clear(): number {
		const current = this.store.projects[this.projectId] ?? [];
		if (current.length === 0) return 0;
		this.store.projects[this.projectId] = [];
		writeStore(this.store);
		return current.length;
	}
}
