/**
 * Provider request shaping.
 *
 * OpenCode lets an agent carry sampling options that are "passed through
 * directly to the provider as model options" (`temperature`, `top_p`, and any
 * other provider-specific key). Pi has no per-agent equivalent in its config,
 * but `before_provider_request` exposes the outgoing payload, so those values
 * can be injected there.
 *
 * This covers both directions of a dispatch:
 *   - the parent, when the user runs a session as a configured agent
 *   - the child, which receives the agent's options from the parent
 */

import type { AgentDefinition } from "./types.ts";

/** Provider options an agent may carry, as OpenCode passes them through. */
export interface ProviderOptions {
	temperature?: number;
	topP?: number;
}

/**
 * Collect the provider options an agent declares.
 *
 * Non-finite values are dropped rather than forwarded: a definition can be
 * built by hand (or by a merge) without passing through the config parser, and
 * NaN or Infinity in a provider payload is a request error.
 */
export function providerOptions(agent: AgentDefinition | undefined): ProviderOptions {
	if (!agent) return {};
	const options: ProviderOptions = {};
	if (typeof agent.temperature === "number" && Number.isFinite(agent.temperature)) {
		options.temperature = agent.temperature;
	}
	if (typeof agent.topP === "number" && Number.isFinite(agent.topP)) {
		options.topP = agent.topP;
	}
	return options;
}

export function hasProviderOptions(options: ProviderOptions): boolean {
	return options.temperature !== undefined || options.topP !== undefined;
}

/**
 * Apply the options to an outgoing provider payload.
 *
 * Returns a new object so the caller can return it as the replacement payload,
 * which is how Pi expects `before_provider_request` handlers to modify a
 * request. The payload is `unknown` because each provider shapes it
 * differently; only plain objects are touched.
 */
export function applyProviderOptions(payload: unknown, options: ProviderOptions): unknown {
	if (!hasProviderOptions(options)) return payload;
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;

	const next = { ...(payload as Record<string, unknown>) };
	// OpenCode's `temperature` is the wire field name; `top_p` uses the
	// provider-native snake_case spelling, as OpenCode's passthrough does.
	if (options.temperature !== undefined) next.temperature = options.temperature;
	if (options.topP !== undefined) next.top_p = options.topP;
	return next;
}

/**
 * Parse provider options sent by the parent to a child.
 *
 * Same base64 JSON channel as the permission ruleset, so the child applies
 * exactly the values its agent declared.
 */
export function decodeProviderOptions(encoded: string | boolean | undefined): ProviderOptions {
	if (typeof encoded !== "string" || !encoded) return {};
	try {
		const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const record = parsed as Record<string, unknown>;
		const options: ProviderOptions = {};
		if (typeof record.temperature === "number" && Number.isFinite(record.temperature)) {
			options.temperature = record.temperature;
		}
		if (typeof record.topP === "number" && Number.isFinite(record.topP)) {
			options.topP = record.topP;
		}
		return options;
	} catch {
		return {};
	}
}

/** Encode provider options for the child process. */
export function encodeProviderOptions(options: ProviderOptions): string | undefined {
	if (!hasProviderOptions(options)) return undefined;
	return Buffer.from(JSON.stringify(options), "utf8").toString("base64");
}
