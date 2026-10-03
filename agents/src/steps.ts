/**
 * Max-steps enforcement.
 *
 * Ported from OpenCode v2:
 *   `packages/core/src/session/runner/max-steps.ts`  (the prompt)
 *   `packages/core/src/session/runner/llm.ts`        (the check)
 *   `packages/core/src/session/runner/step.ts`       (tools disabled)
 *
 * OpenCode counts agentic steps. When `step >= agent.steps` it:
 *   1. appends MAX_STEPS_PROMPT as an assistant message
 *   2. sends `toolChoice: "none"` so the provider cannot call tools
 *   3. rejects any tool that still runs with "Tools are disabled after the
 *      maximum agent steps"
 *
 * Pi has no `toolChoice` override, so the equivalent is:
 *   1. inject MAX_STEPS_PROMPT into the transcript (context event)
 *   2. block every tool call (tool_call event) with the same message
 * Tool definitions stay in place, matching OpenCode's comment about preserving
 * the provider's cached prefix.
 */

/** Verbatim from `packages/core/src/session/runner/max-steps.ts`. */
export const MAX_STEPS_PROMPT = `CRITICAL - MAXIMUM STEPS REACHED

The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)
2. MUST provide a text response summarizing work done so far
3. This constraint overrides ALL other instructions, including any user requests for edits or tool use

Response must include:
- Statement that maximum steps for this agent have been reached
- Summary of what has been accomplished so far
- List of any remaining tasks that were not completed
- Recommendations for what should be done next

Any attempt to use tools is a critical violation. Respond with text ONLY.`;

/** Verbatim from `packages/core/src/session/runner/step.ts`. */
export const TOOLS_DISABLED_MESSAGE = "Tools are disabled after the maximum agent steps";

/** OpenCode's customType equivalent for the injected prompt. */
export const MAX_STEPS_CUSTOM_TYPE = "max-steps-reached";

/**
 * Tracks the step count for one session.
 *
 * OpenCode increments `step` once per provider request. Pi counts completed
 * assistant messages and resets the budget when new user input is admitted.
 */
export class StepCounter {
	private steps = 0;
	private limit: number | undefined;

	/** Set the limit for the active agent. `undefined` disables the guard. */
	setLimit(limit: number | undefined): void {
		this.limit = limit;
	}

	/** Record a completed turn. Returns the new step count. */
	increment(): number {
		this.steps++;
		return this.steps;
	}

	get current(): number {
		return this.steps;
	}

	/** True once the agent has used all its steps, matching `step >= steps`. */
	get reached(): boolean {
		if (this.limit === undefined) return false;
		return this.steps >= this.limit;
	}

	reset(): void {
		this.steps = 0;
	}
}
