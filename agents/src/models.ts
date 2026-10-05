/**
 * Model reference parsing.
 *
 * Ported from OpenCode v2's `Model.Ref` (`packages/schema/src/model.ts`):
 *
 *   parse("providerID/modelID")            -> { providerID, id }
 *   parse("providerID/modelID#variant")    -> { providerID, id, variant }
 *
 * and its validation in `tool/plugin/subagent.ts` (`resolveModel`), which
 * rejects an unknown model or an unavailable variant with a specific message.
 */

export interface ModelRef {
	providerID: string;
	id: string;
	variant?: string;
}

export class ModelRefError extends Error {}

/**
 * Parse `providerID/modelID` or `providerID/modelID#variant`.
 *
 * The rules match OpenCode's `Ref.parse`: a provider segment is required, the
 * id must be non-empty, and a variant must be non-empty and contain no `#`.
 */
export function parseModelRef(input: string): ModelRef {
	const providerEnd = input.indexOf("/");
	if (providerEnd <= 0) throw new ModelRefError(`Invalid model reference: ${input}`);

	const providerID = input.slice(0, providerEnd);
	const variantStart = input.indexOf("#", providerEnd + 1);
	const id = input.slice(providerEnd + 1, variantStart === -1 ? undefined : variantStart);
	const variant = variantStart === -1 ? undefined : input.slice(variantStart + 1);

	if (!id || providerID.includes("#") || (variant !== undefined && (!variant || variant.includes("#")))) {
		throw new ModelRefError(`Invalid model reference: ${input}`);
	}

	return { providerID, id, ...(variant ? { variant } : {}) };
}

/** OpenCode's message for a malformed reference. */
export function invalidModelMessage(input: string): string {
	return `Invalid model "${input}". Use "providerID/modelID" or "providerID/modelID#variant".`;
}

/** OpenCode's message when the model is not in the catalog. */
export function unavailableModelMessage(ref: ModelRef): string {
	return `Model "${ref.providerID}/${ref.id}" is not available. Use the models tool to see what is available.`;
}

/** OpenCode's message when the variant does not exist for the model. */
export function unavailableVariantMessage(ref: ModelRef, variants: string[]): string {
	if (variants.length === 0) {
		return `Model "${ref.providerID}/${ref.id}" has no variants. Omit the variant.`;
	}
	return `Variant "${ref.variant}" is not available for "${ref.providerID}/${ref.id}". Available: ${variants.join(", ")}.`;
}

/**
 * Translate an OpenCode model reference to Pi's `--model` syntax.
 *
 * Pi expresses a thinking level as a `:level` suffix, while OpenCode uses a
 * `#variant` suffix on the model. Variants that name a Pi thinking level map
 * across; anything else is dropped, because Pi has no equivalent axis.
 */
const PI_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Match Pi's supported thinking levels for the selected model. */
export function supportedPiVariants(model: {
	reasoning: boolean;
	thinkingLevelMap?: Partial<Record<string, string | null>>;
}): string[] {
	if (!model.reasoning) return ["off"];
	return [...PI_THINKING_LEVELS].filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		return mapped !== null && (level !== "xhigh" && level !== "max" || mapped !== undefined);
	});
}

export function clampPiVariant(model: Parameters<typeof supportedPiVariants>[0], level: string): string {
	const available = supportedPiVariants(model);
	const levels = [...PI_THINKING_LEVELS], index = levels.indexOf(level);
	if (index < 0) return available[0] ?? "off";
	return levels.slice(index).find((candidate) => available.includes(candidate)) ??
		levels.slice(0, index).reverse().find((candidate) => available.includes(candidate)) ?? "off";
}

export function selectChildModel(input: {
	agent: { id: string; model?: string; thinkingLevel?: string; variant?: string };
	parentModel?: string;
	parentThinking?: string;
	explicitModel?: string;
	explicitThinking?: string;
	/** Previous child agent on continuation; absent for a new session. */
	previousAgent?: string;
}): { model?: string; thinkingLevel?: string } {
	const { agent, previousAgent } = input;
	const continuing = previousAgent !== undefined;
	const switched = continuing && previousAgent !== agent.id;
	const inline = agent.model?.match(/^(.*)[#:]([^#:]+)$/);
	const inlineThinking = inline && PI_THINKING_LEVELS.has(inline[2]) ? inline[2] : undefined;
	const agentModel = inlineThinking ? inline![1] : agent.model;
	const agentThinking = agent.thinkingLevel ?? (agentModel ? agent.variant ?? inlineThinking : undefined);
	const model = input.explicitModel ?? (continuing
		? (switched ? agentModel : undefined)
		: agentModel ?? input.parentModel);
	const thinkingLevel = input.explicitModel
		? (input.explicitThinking ?? (continuing ? undefined : input.parentThinking))
		: continuing
			? (switched ? agentThinking : undefined)
			: agentThinking ?? input.parentThinking;
	return { model, thinkingLevel };
}

export function toPiModelArgument(ref: ModelRef): { model: string; thinkingLevel?: string } {
	const model = `${ref.providerID}/${ref.id}`;
	if (ref.variant && PI_THINKING_LEVELS.has(ref.variant)) {
		return { model, thinkingLevel: ref.variant };
	}
	return { model };
}
