import { subagentEnvelope } from "./runner.ts";
import type { SubagentToolDetails } from "./progress.ts";

/** Keep small-result metadata compatible; large text belongs in content once. */
export const INLINE_OUTPUT_MAX_CHARS = 64 * 1024;

export interface OutputRange {
	/** UTF-16 string offsets into an existing text content block, not byte offsets. */
	contentIndex: number;
	start: number;
	length: number;
}

export function completedSubagentResult<T extends SubagentToolDetails>(output: string, details: T): {
	content: { type: "text"; text: string }[];
	details: Omit<T, "status" | "output" | "outputRange"> & { status: "completed"; output?: string; outputRange?: OutputRange };
} {
	const text = subagentEnvelope({ sessionID: details.sessionID, state: "completed", output });
	const { status: _previousStatus, output: _previousOutput, outputRange: _previousRange, ...metadata } = details;
	return {
		content: [{ type: "text" as const, text }],
		details: {
			...metadata,
			status: "completed" as const,
			...(output.length <= INLINE_OUTPUT_MAX_CHARS
				? { output }
				: { outputRange: { contentIndex: 0, start: text.indexOf("\n") + 1, length: output.length } }),
		},
	};
}

/** Resolve new compact metadata and legacy saved results without I/O or XML parsing. */
export function subagentResultOutput(result: { content: readonly { type: string; text?: string }[]; details?: unknown }): string | undefined {
	if (!result.details || typeof result.details !== "object") return undefined;
	const details = result.details as Partial<SubagentToolDetails>;
	if (typeof details.output === "string") return details.output;
	const range = details.outputRange;
	if (!range || typeof range !== "object" || !Number.isSafeInteger(range.contentIndex) || range.contentIndex < 0 ||
		!Number.isSafeInteger(range.start) || range.start < 0 || !Number.isSafeInteger(range.length) || range.length < 0) return undefined;
	const part = result.content[range.contentIndex];
	if (part?.type !== "text" || typeof part.text !== "string" || range.start + range.length > part.text.length) return undefined;
	return part.text.slice(range.start, range.start + range.length);
}
