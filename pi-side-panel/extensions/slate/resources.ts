/**
 * The resources the panel reports and lets the user toggle: extensions, skills,
 * MCP servers, and the tools registered for this session.
 *
 * Listing goes through Pi's own resource resolver (`DefaultPackageManager`), so
 * the widget shows exactly what Pi would load, including which entries are
 * disabled and why. Toggling writes the same settings `pi config` writes:
 * `+path` / `-path` entries in `settings.json` for extensions and skills, and
 * `enabled: false` in the `mcp.json` that defines a server.
 *
 * Changes are saved, not applied: a reload is still what re-reads settings, so
 * the widget never remounts the panel under the user.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { CONFIG_DIR_NAME, DefaultPackageManager, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";

export type ResourceKind = "extensions" | "skills" | "mcp" | "tools";

export type ResourceItem = {
  /** Stable key: the resolved path, or `mcp:<name>` for a server. */
  id: string;
  /** Short name shown in the widget. */
  name: string;
  /** Where it came from, shown as a dim suffix. */
  origin: string;
  enabled: boolean;
  /** False for entries the panel refuses to toggle (built-ins, project scope). */
  toggleable: boolean;
  /** Why a row is not toggleable, shown instead of the origin when set. */
  lockedReason?: string;
  kind: ResourceKind;
};

export type ResourceCatalog = Record<ResourceKind, ResourceItem[]>;

const BUILTIN_EXTENSIONS = ["mcp", "llama.cpp", "codemode", "tool-search"];
const BUILTIN_PREFIX = "builtin:";

/**
 * List every extension, skill, and MCP server the current settings resolve to.
 *
 * Never installs anything: a package source that is not on disk is reported as
 * skipped, so opening the widget cannot start a network fetch.
 */
export async function loadResourceCatalog(options: {
  cwd: string;
  agentDir?: string;
  /**
   * MCP servers other extensions registered for this session. They live in no
   * `mcp.json`, so they are only visible through the host API; they are listed
   * but not toggleable, since the owning extension would re-register them.
   */
  registeredMcpServers?: readonly { name: string }[];
}): Promise<ResourceCatalog> {
  const agentDir = options.agentDir ?? getAgentDir();
  const settings = SettingsManager.create(options.cwd, agentDir);
  const catalog: ResourceCatalog = { extensions: [], skills: [], mcp: [], tools: [] };

  try {
    const manager = new DefaultPackageManager({
      cwd: options.cwd,
      agentDir,
      settingsManager: settings,
      builtinExtensions: BUILTIN_EXTENSIONS,
    });
    const resolved = await manager.resolve(async () => "skip");
    catalog.extensions = resolved.extensions.map((resource) => toItem(resource, "extensions"));
    catalog.skills = resolved.skills.map((resource) => toItem(resource, "skills"));
  } catch {
    /* A broken settings file must not take the panel down with it. */
  }

  catalog.mcp = loadMcpItems(options.cwd, agentDir, options.registeredMcpServers ?? []);
  return catalog;
}

/** Extension, skill, MCP, and tool totals, for the Resources section rows. */
export function countCatalog(catalog: ResourceCatalog): Record<ResourceKind, number> {
  return {
    extensions: catalog.extensions.length,
    skills: catalog.skills.length,
    mcp: catalog.mcp.length,
    tools: catalog.tools.length,
  };
}

function toItem(
  resource: { path: string; enabled: boolean; metadata: { source: string; scope: string; origin: string } },
  kind: "extensions" | "skills",
): ResourceItem {
  const builtin = resource.path.startsWith(BUILTIN_PREFIX);
  const projectScope = resource.metadata.scope === "project";
  return {
    id: resource.path,
    name: builtin ? resource.path.slice(BUILTIN_PREFIX.length) : baseName(resource.path),
    origin: originLabel(resource.metadata.source, projectScope),
    enabled: resource.enabled,
    // Built-in extensions are toggled as `builtin:<name>` in the same
    // `extensions` array, so they are writable too; a project-scoped entry
    // would have to be overridden in the project settings file instead.
    toggleable: !projectScope,
    lockedReason: projectScope ? "project" : undefined,
    kind,
  };
}

function originLabel(source: string, project: boolean): string {
  if (source === "builtin") return "builtin";
  const where = project ? "project" : "user";
  if (source === "auto") return where;
  if (source === "local") return `${where} settings`;
  return source;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const last = parts[parts.length - 1] ?? path;
  // A directory extension (agents/, safeguards/) is named by its folder.
  if (last === "index.ts" || last === "index.js") return parts[parts.length - 2] ?? last;
  if (last === "SKILL.md") return parts[parts.length - 2] ?? last;
  return last.replace(/\.(ts|js)$/, "");
}

// --- MCP servers -----------------------------------------------------------

type McpEntry = { name: string; config: { enabled?: boolean } };

/**
 * MCP servers come from `mcp.json` files, not from the settings arrays, so they
 * are read directly. Registered servers (owned by an extension) cannot be
 * toggled from here: their config lives in the extension, not a file.
 */
function loadMcpItems(
  cwd: string,
  agentDir: string,
  registered: readonly { name: string }[],
): ResourceItem[] {
  const items = new Map<string, ResourceItem>();
  const globalPath = join(agentDir, "mcp.json");
  const projectPath = join(cwd, CONFIG_DIR_NAME, "mcp.json");
  for (const [path, scope] of [[globalPath, "user"], [projectPath, "project"]] as const) {
    for (const entry of readMcpFile(path)) {
      items.set(entry.name, {
        id: `mcp:${entry.name}`,
        name: entry.name,
        origin: mcpOriginLabel(scope),
        enabled: entry.config.enabled !== false,
        toggleable: scope === "user",
        lockedReason: scope === "project" ? "project" : undefined,
        kind: "mcp",
      });
    }
  }
  // A file server overrides a registered one of the same name, so only add the
  // registered names that no file already claimed.
  for (const server of registered) {
    if (!server?.name || items.has(server.name)) continue;
    items.set(server.name, {
      id: `mcp:${server.name}`,
      name: server.name,
      origin: "extension",
      enabled: true,
      toggleable: false,
      lockedReason: "extension",
      kind: "mcp",
    });
  }
  return [...items.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function readMcpFile(path: string): McpEntry[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, McpEntry["config"]> };
    if (!parsed || typeof parsed !== "object" || !parsed.mcpServers || typeof parsed.mcpServers !== "object") return [];
    return Object.entries(parsed.mcpServers).map(([name, config]) => ({ name, config }));
  } catch {
    return [];
  }
}

// --- Tools -----------------------------------------------------------------

/**
 * The slice of Pi's `ToolInfo` the widget needs. Structural, so tests can pass
 * plain objects instead of importing host types.
 */
export type ToolSummary = {
  name: string;
  exposure?: string;
  namespace?: { name: string };
  sourceInfo?: { path: string; source: string; scope: string };
};

/**
 * One row per registered tool, with the active set as the enabled state.
 *
 * Tools are not resolved from files the way the other kinds are: the session's
 * tool registry is their only source of truth, so the host passes
 * `pi.getAllTools()` and `pi.getActiveTools()` in. A tool re-registered mid
 * session (MCP connecting, a tool_search activation) simply shows up the next
 * time the host re-reads the registry.
 *
 * Only tools a `defaultTools` entry can actually control are toggleable: the
 * built-in base tools and the tools registered inactive, like `codemode` and
 * `tool_search`. Extension tools re-activate on every registration, so a
 * saved `-name` would be silently ignored next session — those lock, and the
 * extension itself is what to toggle instead. MCP tools lock because a server
 * row in the MCPs widget is their control surface, and `hidden` tools lock
 * because `setActiveTools` cannot activate them at all.
 */
export function loadToolItems(tools: readonly ToolSummary[], activeNames: readonly string[]): ResourceItem[] {
  const active = new Set(activeNames);
  return [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => {
      const path = tool.sourceInfo?.path ?? "";
      const source = tool.sourceInfo?.source ?? "";
      // Built-in tools carry a synthetic `builtin:<name>` path that names the
      // tool itself; an extension's tools carry the extension's path instead.
      const isBuiltinTool = source === "builtin" && path === `builtin:${tool.name}`;
      const hidden = tool.exposure === "hidden";
      // Tools registered inactive (`codemode`, `tool_search`) are exactly what
      // a `defaultTools` entry exists to control, so they stay toggleable even
      // though an extension registers them.
      const inactiveByExposure = tool.exposure === "codemode" || tool.exposure === "deferred";
      const isMcpTool = Boolean(tool.namespace?.name?.startsWith("mcp__"));
      const toggleable = !hidden && !isMcpTool && (isBuiltinTool || inactiveByExposure);
      // Not toggleable and not hidden can only be extension ownership: either
      // the tool came from an extension file or it belongs to an MCP server.
      const lockedReason = hidden ? "hidden" : toggleable ? undefined : "extension";
      return {
        id: isBuiltinTool ? `builtin:${tool.name}` : `tool:${tool.name}`,
        name: tool.name,
        origin: toolOriginLabel(tool),
        enabled: active.has(tool.name),
        toggleable,
        lockedReason,
        kind: "tools" as const,
      };
    });
}

function toolOriginLabel(tool: ToolSummary): string {
  // An MCP namespace (`mcp__docs`) says more than the extension that registered it.
  if (tool.namespace?.name) return tool.namespace.name;
  const info = tool.sourceInfo;
  if (!info) return "unknown";
  if (info.source === "builtin" && info.path === `builtin:${tool.name}`) return "builtin";
  if (info.path.startsWith("<sdk:")) return "sdk";
  // An extension tool's path names the extension, which reads better than its
  // discovery source; `baseName` also resolves `index.ts` to its folder.
  if (info.path && !info.path.startsWith("builtin:")) return baseName(info.path);
  return info.source;
}

/** The tool a tool-kind item id names: the name itself for non-built-ins. */
function toolNameOf(id: string): string {
  if (id.startsWith("tool:")) return id.slice("tool:".length);
  if (id.startsWith(BUILTIN_PREFIX)) return id.slice(BUILTIN_PREFIX.length);
  return id;
}

// --- Toggling --------------------------------------------------------------

/**
 * Write one toggle and return the item with its new state.
 *
 * Extensions and skills become `+path` / `-path` entries in the user
 * `settings.json`, matching `pi config`. MCP servers get `enabled: false`
 * (removed when enabled again) in the user `mcp.json`. Tools become `+name` /
 * `-name` entries in the user `defaultTools`, the same setting `--tools`
 * overrides and `/reload` re-reads.
 *
 * The files are edited in place rather than through `SettingsManager`: that
 * manager batches writes behind a promise queue and tracks which fields the
 * running session changed, neither of which is useful here, where a toggle has
 * to be on disk before the user can run `/reload`. Merging into the parsed JSON
 * keeps every unrelated setting exactly as the user wrote it.
 */
export function toggleResourceItem(
  item: ResourceItem,
  options: { cwd: string; agentDir?: string },
): ResourceItem {
  const next = { ...item, enabled: !item.enabled };
  if (!item.toggleable) return item;
  const agentDir = options.agentDir ?? getAgentDir();

  if (item.kind === "mcp") {
    writeMcpEnabled(join(agentDir, "mcp.json"), item.name, next.enabled);
    return next;
  }

  if (item.kind === "tools") {
    writeDefaultToolsEntry(join(agentDir, "settings.json"), toolNameOf(item.id), next.enabled);
    return next;
  }

  const key = item.kind === "extensions" ? "extensions" : "skills";
  const pattern = resourcePattern(item.id, agentDir, options.cwd);
  writeSettingsPattern(join(agentDir, "settings.json"), key, pattern, next.enabled);
  return next;
}

function stripPattern(entry: string): string {
  return entry.startsWith("+") || entry.startsWith("-") || entry.startsWith("!") ? entry.slice(1) : entry;
}

/** Auto-discovered resources resolve under the agent dir, not the project. */
function baseDirFor(path: string, agentDir: string, cwd: string): string {
  const projectDir = join(cwd, CONFIG_DIR_NAME);
  if (path.startsWith(projectDir)) return projectDir;
  return agentDir;
}

/**
 * The pattern `pi config` would write for an auto-discovered resource: its path
 * relative to the base directory its settings entries resolve against.
 *
 * Exported so the extension and the tests agree on the exact string, since a
 * wrong pattern is a silently ignored toggle rather than an error.
 */
export function resourcePattern(path: string, agentDir: string, cwd: string): string {
  if (path.startsWith(BUILTIN_PREFIX)) return path;
  return relative(baseDirFor(path, agentDir, cwd), path).split(sep).join("/");
}

/**
 * Add `+pattern` or `-pattern` to one settings array, replacing this resource's
 * earlier pattern so a path toggled twice does not accumulate entries.
 *
 * The enabled form is `+`, not a bare path: a bare path is also how a user
 * *adds* a resource, and `-` must be able to override a force-include, so
 * writing `+` keeps the intent explicit in both directions.
 */
function writeSettingsPattern(path: string, key: "extensions" | "skills", pattern: string, enabled: boolean): void {
  const parsed = readJsonObject(path);
  const current = Array.isArray(parsed[key]) ? (parsed[key] as unknown[]).filter((entry): entry is string => typeof entry === "string") : [];
  const next = current.filter((entry) => stripPattern(entry) !== pattern);
  next.push(`${enabled ? "+" : "-"}${pattern}`);
  parsed[key] = next;
  writeJson(path, parsed);
}

/**
 * Add `+name` / `-name` to the user `defaultTools` array.
 *
 * The array may also hold plain names, which replace the built-in defaults
 * before the modifiers apply in list order, so appending a modifier is correct
 * for both shapes: `-read` removes it from either the defaults or a replacement
 * list, and `+codemode` adds it to either. An earlier entry for the same tool
 * is replaced rather than stacked, like the other settings toggles.
 */
function writeDefaultToolsEntry(path: string, name: string, enabled: boolean): void {
  const parsed = readJsonObject(path);
  const current = Array.isArray(parsed.defaultTools)
    ? (parsed.defaultTools as unknown[]).filter((entry): entry is string => typeof entry === "string")
    : [];
  const next = current.filter((entry) => stripPattern(entry) !== name);
  next.push(`${enabled ? "+" : "-"}${name}`);
  parsed.defaultTools = next;
  writeJson(path, parsed);
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path}: expected an object`);
  }
  return parsed as Record<string, unknown>;
}

/** Rewrite a JSON file with its original indentation. */
function writeJson(path: string, value: unknown): void {
  const text = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const indent = (text && /^([ \t]+)\S/m.exec(text)?.[1]) || "  ";
  writeFileSync(path, `${JSON.stringify(value, null, indent)}\n`);
}

function writeMcpEnabled(path: string, name: string, enabled: boolean): void {
  const parsed = readJsonObject(path);
  const servers = parsed.mcpServers;
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
    throw new Error(`${path}: expected an "mcpServers" object`);
  }
  const server = (servers as Record<string, unknown> | undefined)?.[name];
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    throw new Error(`${path} does not define MCP server "${name}"`);
  }
  if (enabled) delete (server as { enabled?: boolean }).enabled;
  else (server as { enabled?: boolean }).enabled = false;
  writeJson(path, parsed);
}

/** The label used for an MCP server's origin: its defining file's scope. */
export function mcpOriginLabel(scope: string): string {
  return scope === "project" ? "project" : "user";
}
