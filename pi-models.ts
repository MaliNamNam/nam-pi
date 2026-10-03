// Global Pi model configuration from <agent-dir>/pi.jsonc.
// Install this file in <agent-dir>/extensions/ (normally ~/.pi/agent/extensions/).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const configPath = join(agentDir, "pi.jsonc");

type ObjectValue = Record<string, unknown>;
function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as ObjectValue;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}
function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label);
}
function positive(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}
function headers(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const entries = Object.entries(object(value, label));
  return Object.fromEntries(entries.map(([key, val]) => [key, string(val, `${label}.${key}`)]));
}
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
// Pi thinking-level map: a string maps the level to a provider value, null hides it.
function thinkingLevelMap(value: unknown, label: string): Record<string, string | null> | undefined {
  if (value === undefined) return undefined;
  const result: Record<string, string | null> = {};
  for (const [level, mapped] of Object.entries(object(value, label))) {
    if (!THINKING_LEVELS.includes(level as (typeof THINKING_LEVELS)[number])) throw new Error(`${label}.${level} is not a thinking level`);
    result[level] = mapped === null ? null : string(mapped, `${label}.${level}`);
  }
  return result;
}

// Remove JSONC comments and trailing commas without changing quoted strings (including URLs).
export function parseJsonc(source: string): unknown {
  let clean = "";
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      clean += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      clean += char;
    } else if (char === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
      const line = source[++i] === "/";
      if (line) {
        while (i + 1 < source.length && source[i + 1] !== "\n") i++;
      } else {
        let closed = false;
        while (i + 1 < source.length) {
          if (source[i] === "*" && source[i + 1] === "/") { i++; closed = true; break; }
          if (source[i] === "\n") clean += "\n";
          i++;
        }
        if (!closed) throw new Error("Unterminated block comment");
      }
    } else {
      clean += char;
    }
  }
  let result = "";
  quoted = false;
  escaped = false;
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (quoted) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      result += char;
    } else if (char === "," && /^[\s]*[}\]]/.test(clean.slice(i + 1))) {
      // Ignore commas before a closing object or array bracket.
    } else result += char;
  }
  return JSON.parse(result);
}

export function buildProviders(config: unknown): Array<[string, ProviderConfig]> {
  const root = object(config, "pi.jsonc");
  const providers = object(root.provider ?? {}, "provider");
  return Object.entries(providers).flatMap(([providerId, raw]) => {
    const label = `provider.${providerId}`;
    const provider = object(raw, label);
    if (provider.models === undefined) return []; // Allows endpoint-only entries, as in OpenCode.
    const models = object(provider.models, `${label}.models`);
    const options = object(provider.options ?? {}, `${label}.options`);
    const baseUrl = string(options.baseURL ?? provider.baseUrl, `${label}.options.baseURL`);
    const apiKey = string(options.apiKey ?? provider.apiKey, `${label}.options.apiKey`);
    const api = optionalString(provider.api, `${label}.api`) ?? "openai-completions";
    const mapped: ProviderModelConfig[] = Object.entries(models).map(([key, rawModel]) => {
      const label = `${providerId}.models.${key}`;
      const model = object(rawModel, label);
      const limit = object(model.limit ?? {}, `${label}.limit`);
      const input = model.input ?? ["text"];
      if (!Array.isArray(input) || !input.length || input.some((v) => v !== "text" && v !== "image")) {
        throw new Error(`${label}.input must contain only text and/or image`);
      }
      if (model.reasoning !== undefined && typeof model.reasoning !== "boolean") throw new Error(`${label}.reasoning must be boolean`);
      const cost = object(model.cost ?? {}, `${label}.cost`);
      for (const [name, value] of Object.entries(cost)) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label}.cost.${name} must be nonnegative`);
      }
      return {
        id: string(model.id ?? key, `${label}.id`),
        name: string(model.name ?? key, `${label}.name`),
        api: optionalString(model.api, `${label}.api`) as ProviderModelConfig["api"],
        reasoning: model.reasoning ?? false,
        thinkingLevelMap: thinkingLevelMap(model.thinkingLevelMap, `${label}.thinkingLevelMap`) as ProviderModelConfig["thinkingLevelMap"],
        input: input as ProviderModelConfig["input"],
        contextWindow: positive(limit.context ?? model.contextWindow, 128000, `${label}.limit.context`),
        maxTokens: positive(limit.output ?? model.maxTokens, 8192, `${label}.limit.output`),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...cost },
        headers: headers(model.headers, `${label}.headers`),
        compat: model.compat as ProviderModelConfig["compat"],
      };
    });
    if (mapped.length === 0) return [];
    return [[providerId, {
      name: optionalString(provider.name, `${label}.name`),
      baseUrl,
      apiKey,
      api: api as ProviderConfig["api"],
      headers: headers(options.headers ?? provider.headers, `${label}.headers`),
      authHeader: options.authHeader as boolean | undefined,
      models: mapped,
    }]];
  });
}

export default function (pi: ExtensionAPI) {
  if (!existsSync(configPath)) return;
  try {
    const providers = buildProviders(parseJsonc(readFileSync(configPath, "utf8")));
    for (const [name, config] of providers) pi.registerProvider(name, config);
  } catch (error) {
    // Never print the file contents (which may contain credentials).
    throw new Error(`Invalid ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
