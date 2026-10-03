/**
 * Agent configuration and discovery.
 *
 * Mirrors OpenCode's two configuration paths:
 *
 *   1. JSON — an `agent` map in the config file
 *      (`packages/core/src/config/plugin/agent.ts`)
 *   2. Markdown — files with YAML frontmatter whose filename is the agent name
 *      (`packages/core/src/config/plugin/agent.ts` `decode`, `~/.config/opencode/agents/`)
 *
 * Pi locations, chosen to match Pi conventions while keeping OpenCode's shape:
 *   <agent-dir>/safeguards.json        `agent` map (same file the safeguards extension reads)
 *   <cwd>/.pi/safeguards.json          `agent` map, project scope
 *   <agent-dir>/agents/*.md            user markdown agents
 *   <cwd>/.pi/agents/*.md              project markdown agents
 *
 * Markdown frontmatter accepts OpenCode's fields (`description`, `mode`, `model`,
 * `permission`, `steps`, `hidden`, `disable`, `tools`, `temperature`, `top_p`,
 * `prompt`) plus `name` for the display name.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { BUILTIN_AGENTS, PLAN_LEAVE_REMINDER, PLAN_REMINDER } from "./builtin.ts";
import { allowedPiTools, legacyToolPermissions, normalizePermissions } from "./permissions.ts";
import type { AgentDefinition, AgentMode, AgentSource, DiscoveryOptions, PermissionRule } from "./types.ts";

export { PLAN_LEAVE_REMINDER, PLAN_REMINDER };

// Pi's pi.jsonc is the authoritative user/project agent map.
const CONFIG_FILES = ["settings.json", "safeguards.json", "pi.jsonc"];

/**
 * OpenCode's own config locations.
 *
 * A machine migrated from OpenCode keeps its `agent` map here. It is a
 * fallback: Pi's local pi.jsonc wins when both configure the same agent.
 */
function opencodeConfigFiles(): string[] {
	const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
	return [path.join(xdg, "opencode", "opencode.jsonc"), path.join(xdg, "opencode", "opencode.json")];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function existing(files: string[]): string[] {
	return files.filter((file) => existsSync(file));
}

/** Strip JSONC comments and trailing commas. Mirrors the safeguards loader. */
export function parseJsonc(source: string): unknown {
	let out = "";
	let quoted = false;
	let escaped = false;
	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (quoted) {
			out += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') quoted = false;
			continue;
		}
		if (char === '"') {
			quoted = true;
			out += char;
			continue;
		}
		if (char === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
			const line = source[i + 1] === "/";
			i++;
			if (line) {
				while (i + 1 < source.length && source[i + 1] !== "\n") i++;
			} else {
				let closed = false;
				while (i + 1 < source.length) {
					if (source[i] === "*" && source[i + 1] === "/") {
						i++;
						closed = true;
						break;
					}
					if (source[i] === "\n") out += "\n";
					i++;
				}
				if (!closed) throw new Error("Unterminated block comment");
			}
			continue;
		}
		out += char;
	}

	let clean = "";
	quoted = false;
	escaped = false;
	for (let i = 0; i < out.length; i++) {
		const char = out[i];
		if (quoted) {
			clean += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') quoted = false;
			continue;
		}
		if (char === '"') {
			quoted = true;
			clean += char;
			continue;
		}
		if (char === "," && /^[\s]*[}\]]/.test(out.slice(i + 1))) continue;
		clean += char;
	}
	return JSON.parse(clean);
}

function readJsonc(file: string): unknown {
	return parseJsonc(readFileSync(file, "utf8"));
}

/* ------------------------------------------------------------------ */
/* JSON agent config                                                   */
/* ------------------------------------------------------------------ */

/**
 * Convert one JSON agent entry to a definition.
 *
 * OpenCode's `tools: { write: false }` shorthand is translated the same way
 * OpenCode does it: `false` -> `{ "*": "deny" }`, `true` -> `{ "*": "allow" }`,
 * with `write`/`edit`/`patch` folded into the `edit` permission.
 */
export function jsonAgentToDefinition(
	id: string,
	raw: unknown,
	source: AgentSource,
	filePath?: string,
): AgentDefinition | undefined {
	if (!isRecord(raw)) return undefined;
	if (raw.disabled === true || raw.disable === true) return undefined;

	const permissions = legacyToolPermissions(raw.tools);
	if (raw.permission !== undefined) {
		permissions.push(...normalizePermissions(raw.permission));
	}

	const mode = normalizeMode(raw.mode);
	const prompt = typeof raw.prompt === "string" ? raw.prompt : undefined;
	const system = typeof raw.system === "string" ? raw.system : undefined;

	return {
		id,
		name: typeof raw.name === "string" ? raw.name : titleCase(id),
		description: typeof raw.description === "string" ? raw.description : "",
		mode,
		modeExplicit: raw.mode !== undefined,
		configuredFields: configuredFields(raw),
		hidden: raw.hidden === true,
		systemPrompt: prompt ?? system ?? "",
		tools: toolAllowlist(permissions),
		toolsFromPermissions: true,
		permissions,
		model: typeof raw.model === "string" ? raw.model : undefined,
		thinkingLevel: typeof raw.thinkingLevel === "string" ? raw.thinkingLevel : undefined,
		variant: typeof raw.variant === "string" ? raw.variant : undefined,
		temperature: finiteNumber(raw.temperature),
		topP: finiteNumber(raw.top_p),
		steps: typeof raw.steps === "number" ? raw.steps : typeof raw.maxSteps === "number" ? raw.maxSteps : undefined,
		source,
		filePath,
	};
}

function normalizeMode(value: unknown): AgentMode {
	if (value === "primary" || value === "subagent" || value === "all") return value;
	// OpenCode defaults a missing mode to "all".
	return "all";
}

/** Accept only finite numbers; OpenCode validates these as Finite. */
function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

type AgentConfigEntry = AgentDefinition | { id: string; disabled: true };

function configuredFields(raw: Record<string, unknown>, markdown = false): AgentDefinition["configuredFields"] {
	const fields: NonNullable<AgentDefinition["configuredFields"]> = [];
	if (typeof raw.name === "string") fields.push("name");
	if (typeof raw.description === "string") fields.push("description");
	if (typeof raw.hidden === "boolean") fields.push("hidden");
	if (markdown || typeof raw.prompt === "string" || typeof raw.system === "string") fields.push("systemPrompt");
	return fields;
}

function titleCase(id: string): string {
	return id
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((part) => part[0].toUpperCase() + part.slice(1))
		.join(" ");
}

/** Compatibility export; legacy tool rules precede explicit permissions. */
export function toolAllowlist(permissions: PermissionRule[], legacyTools?: unknown): string[] | undefined {
	return allowedPiTools([...legacyToolPermissions(legacyTools), ...permissions]);
}

/* ------------------------------------------------------------------ */
/* Markdown agents                                                     */
/* ------------------------------------------------------------------ */

type Frontmatter = {
	description?: unknown;
	mode?: unknown;
	model?: unknown;
	permission?: unknown;
	tools?: unknown;
	steps?: unknown;
	maxSteps?: unknown;
	hidden?: unknown;
	disable?: unknown;
	disabled?: unknown;
	prompt?: unknown;
	system?: unknown;
	thinkingLevel?: unknown;
	variant?: unknown;
	temperature?: unknown;
	top_p?: unknown;
	name?: unknown;
};

function loadMarkdownDir(dir: string, source: AgentSource): AgentConfigEntry[] {
	if (!existsSync(dir)) return [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}

	const agents: AgentConfigEntry[] = [];
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".md")) continue;
		const filePath = path.join(dir, entry);
		try {
			if (!statSync(filePath).isFile()) continue;
		} catch {
			continue;
		}

		let content: string;
		try {
			content = readFileSync(filePath, "utf8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Frontmatter>(content);
		const id = entry.replace(/\.md$/, "");
		const data = frontmatter as Frontmatter;
		if (data.disable === true || data.disabled === true) { agents.push({ id, disabled: true }); continue; }

		const permissions = legacyToolPermissions(data.tools);
		if (data.permission !== undefined) permissions.push(...normalizePermissions(data.permission));

		agents.push({
			id,
			name: typeof data.name === "string" ? data.name : titleCase(id),
			description: typeof data.description === "string" ? data.description : "",
			mode: normalizeMode(data.mode),
			modeExplicit: data.mode !== undefined,
			configuredFields: configuredFields(data, true),
			hidden: data.hidden === true,
			systemPrompt: body.trim(),
			tools: toolAllowlist(permissions),
			toolsFromPermissions: true,
			permissions,
			model: typeof data.model === "string" ? data.model : undefined,
			thinkingLevel: typeof data.thinkingLevel === "string" ? data.thinkingLevel : undefined,
			variant: typeof data.variant === "string" ? data.variant : undefined,
			temperature: finiteNumber(data.temperature),
			topP: finiteNumber(data.top_p),
			steps:
				typeof data.steps === "number" ? data.steps : typeof data.maxSteps === "number" ? data.maxSteps : undefined,
			source,
			filePath,
		});
	}
	return agents;
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

function findNearestProjectAgentsDir(cwd: string): string | null {
	let current = path.resolve(cwd);
	const root = path.parse(current).root;
	while (true) {
		const candidate = path.join(current, ".pi", "agents");
		if (existsSync(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current || current === root) return null;
		current = parent;
	}
}

/** Load the `agent` map from a config file. */
function loadJsonAgents(file: string, source: AgentSource): AgentConfigEntry[] {
	let raw: unknown;
	try {
		raw = readJsonc(file);
	} catch {
		return [];
	}
	if (!isRecord(raw)) return [];
	const map = raw.agent;
	if (!isRecord(map)) return [];

	const agents: AgentConfigEntry[] = [];
	for (const [id, entry] of Object.entries(map)) {
		if (isRecord(entry) && (entry.disable === true || entry.disabled === true)) {
			agents.push({ id, disabled: true });
			continue;
		}
		const definition = jsonAgentToDefinition(id, entry, source, file);
		if (definition) agents.push(definition);
	}
	return agents;
}

export interface DiscoveryResult {
	agents: AgentDefinition[];
	/** Directories that were scanned, for diagnostics. */
	scanned: string[];
}

export function discoverAgents(options: DiscoveryOptions): DiscoveryResult {
	const agentDir = getAgentDir();
	const scope = options.agentScope ?? "user";
	// `user` loads only the agent directory; `project` only the workspace; `both`
	// loads the agent directory and then the workspace over it.
	const includeUser = scope === "user" || scope === "both";
	const includeProject = scope === "project" || scope === "both";
	const scanned: string[] = [];

	// Later entries override earlier ones by id.
	const byId = new Map<string, AgentDefinition>();
	const add = (entries: AgentConfigEntry[]) => {
		for (const entry of entries) {
			if ("disabled" in entry) byId.delete(entry.id);
			else byId.set(entry.id, mergeOverBuiltin(byId.get(entry.id), entry));
		}
	};

	// 1. Built-ins (OpenCode parity). Experimental agents are opt-in.
	add(BUILTIN_AGENTS.filter((agent) => !agent.experimental || options.experimental));

	// User OpenCode config is a migration fallback; Pi's own files take priority.
	if (includeUser) {
		for (const file of existing([
			...opencodeConfigFiles(),
			...CONFIG_FILES.map((name) => path.join(agentDir, name)),
		])) {
			scanned.push(file);
			add(loadJsonAgents(file, "user"));
		}
	}
	// User Markdown overrides user JSON, but never a project-local override.
	if (includeUser) {
		const dir = path.join(agentDir, "agents");
		scanned.push(dir);
		add(loadMarkdownDir(dir, "user"));
	}
	if (includeProject) {
		for (const file of existing(CONFIG_FILES.map((name) => path.join(options.cwd, ".pi", name)))) {
			scanned.push(file);
			add(loadJsonAgents(file, "project"));
		}
		const dir = findNearestProjectAgentsDir(options.cwd);
		if (dir) {
			scanned.push(dir);
			add(loadMarkdownDir(dir, "project"));
		}
	}

	// 4. Extra configured paths, lowest precedence after built-ins.
	for (const extra of options.paths ?? []) {
		const resolved = path.isAbsolute(extra) ? extra : path.resolve(options.cwd, extra);
		scanned.push(resolved);
		add(loadMarkdownDir(resolved, "user"));
	}

	// V2 permits description-less agents; the listing supplies fallback text.
	return { agents: [...byId.values()], scanned };
}

/**
 * Apply a config entry over an earlier definition (the exported historical
 * name is retained). V2 updates only supplied fields for custom agents too.
 * Omitted fields preserve earlier values; explicit false/empty text wins.
 * Permission rules append in source order, preserving last-match-wins.
 */
export function mergeOverBuiltin(
	base: AgentDefinition | undefined,
	override: AgentDefinition,
): AgentDefinition {
	if (!base) return override;
	const permissions = [...base.permissions, ...override.permissions];
	// Plan's explicit role cap is independent of its dynamic plan-directory grant.
	const toolsFromPermissions = base.toolsFromPermissions === false ? false :
		(override.toolsFromPermissions ?? base.toolsFromPermissions);
	const explicit = (field: NonNullable<AgentDefinition["configuredFields"]>[number]) =>
		override.configuredFields ? override.configuredFields.includes(field) : field === "hidden" || !!override[field];
	return {
		...base,
		...override,
		// Keep the built-in identity and description unless the config replaces them.
		name: explicit("name") ? override.name : base.name,
		description: explicit("description") ? override.description : base.description,
		hidden: explicit("hidden") ? override.hidden : base.hidden,
		systemPrompt: explicit("systemPrompt") ? override.systemPrompt : base.systemPrompt,
		model: override.model ?? base.model,
		thinkingLevel: override.thinkingLevel ?? base.thinkingLevel,
		variant: override.variant ?? base.variant,
		temperature: override.temperature ?? base.temperature,
		topP: override.topP ?? base.topP,
		steps: override.steps ?? base.steps,
		toolsFromPermissions,
		tools: toolsFromPermissions ? toolAllowlist(permissions) :
			(base.toolsFromPermissions === false && override.toolsFromPermissions ? base.tools : override.tools ?? base.tools),
		// An omitted mode keeps the built-in's; an explicit one wins.
		mode: override.modeExplicit ? override.mode : base.mode,
		// Merge rules so a partial override cannot drop the built-in guards.
		permissions,
		// The built-in keeps its identity; the override only supplies values.
		source: override.source,
		filePath: override.filePath,
	};
}

/** Subagents available for dispatch, sorted by id. */
export function subagents(agents: AgentDefinition[]): AgentDefinition[] {
	return agents
		.filter((agent) => agent.mode !== "primary")
		.toSorted((left, right) => left.id.localeCompare(right.id));
}

/** Primary agents selectable by the user. */
export function primaryAgents(agents: AgentDefinition[]): AgentDefinition[] {
	return agents
		.filter((agent) => agent.mode !== "subagent" && !agent.hidden)
		.toSorted((left, right) => left.id.localeCompare(right.id));
}
