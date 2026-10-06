/**
 * Pi translations of OpenCode v2's built-ins (`packages/core/src/plugin/agent.ts`).
 *
 * Descriptions and the Explore prompt follow OpenCode's source. Tool sets,
 * Plan's writable directory, the experimental Scout, and subprocess transport
 * differ where Pi has no direct equivalent.
 *
 * OpenCode's built-ins:
 *   build      primary   default agent, all tools
 *   plan       primary   read-only planning (defined in plugin/plan.ts)
 *   general    subagent  full tool access, multi-step work
 *   explore    subagent  read-only codebase search
 *   scout      subagent  external docs/dependency research (experimental)
 *   compaction primary   hidden, system
 *   title      primary   hidden, system
 *   summary    primary   hidden, system
 */

import type { AgentDefinition } from "./types.ts";
import { builtinScout } from "./scout.ts";

/** Verbatim from OpenCode `packages/core/src/plugin/agent.ts`. */
const PROMPT_EXPLORE = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use Glob for broad file pattern matching
- Use Grep for searching file contents with regex
- Use Read when you know the specific file path you need to read
- Adapt your search approach based on the thoroughness level specified by the caller
- Return file paths as absolute paths in your final response
- For clear communication, avoid using emojis
- Do not create any files, or run bash commands that modify the user's system state in any way

Complete the user's search request efficiently and report your findings clearly.`;

/**
 * OpenCode's Plan mode reminder, verbatim from `packages/core/src/plugin/plan.ts`.
 *
 * OpenCode injects this as a `<system-reminder>` user message on entering Plan
 * mode; it does NOT set `agent.system`, so the base system prompt stays intact.
 * The `directory` placeholder is the plan directory.
 */
export const PLAN_LEAVE_REMINDER = `<system-reminder>
You are NO LONGER in Plan mode. The previous Plan restrictions no longer apply. Any Plan mode instructions from earlier in this conversation are no longer active.
</system-reminder>`;

export const PLAN_REMINDER = (directory: string) => `<system-reminder>
You are in Plan mode. Discuss the plan with the user directly in the conversation. Do not create or update plan files unless the user explicitly asks you to; when they do, write them only in:
${directory}

Do not modify any other files or ask a subagent to do so.

You remain in Plan mode until the user switches agents. If the user asks you to implement changes, do not do so. Tell them they need to switch agents.
</system-reminder>`;

/**
 * OpenCode's built-in agents.
 *
 * `tools` is the Pi translation of OpenCode's permission ruleset: OpenCode
 * denies `*` then allows specific actions, which maps exactly to a Pi tool
 * allowlist.
 */
export const BUILTIN_AGENTS: AgentDefinition[] = [
	{
		id: "build",
		toolsFromPermissions: true,
		name: "Build",
		description: "The default agent. Executes tools based on configured permissions.",
		mode: "primary",
		hidden: false,
		systemPrompt: "",
		// OpenCode's shared defaults are applied when evaluating calls in index.ts.
		tools: undefined,
		permissions: [{ action: "question", resource: "*", effect: "allow" }],
	},
	{
		id: "plan",
		toolsFromPermissions: false,
		name: "Plan",
		description: "Read-only agent for exploring the codebase and planning work before implementation.",
		mode: "primary",
		hidden: false,
		// OpenCode's Plan sets no system prompt; it injects PLAN_REMINDER instead.
		systemPrompt: "",
		// Edit denies apply to other paths; index.ts grants only the plan directory.
		// Edits are offered for the plan directory only; per-call rules reject all others.
		tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "questionnaire", "webfetch", "websearch"],
		permissions: [
			{ action: "question", resource: "*", effect: "allow" },
			{ action: "edit", resource: "*", effect: "deny" },
		],
	},
	{
		id: "general",
		toolsFromPermissions: true,
		name: "General",
		description:
			"General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.",
		mode: "subagent",
		hidden: false,
		systemPrompt: "",
		// Agent-specific rules; OpenCode's baseline is applied in index.ts.
		tools: undefined,
		permissions: [
			{ action: "question", resource: "*", effect: "deny" },
			{ action: "subagent", resource: "*", effect: "deny" },
			// Pi addition: pi-vcc's context recall (unknown child tools need a named allow).
			{ action: "vcc_recall", resource: "*", effect: "allow" },
		],
	},
	{
		id: "explore",
		toolsFromPermissions: true,
		name: "Explore",
		description:
			'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.',
		mode: "subagent",
		hidden: false,
		systemPrompt: PROMPT_EXPLORE,
		// Deny * then allow read-only actions; Pi's list action is an addition.
		tools: ["read", "grep", "find", "ls", "webfetch", "websearch"],
		permissions: [
			{ action: "*", resource: "*", effect: "deny" },
			{ action: "grep", resource: "*", effect: "allow" },
			{ action: "glob", resource: "*", effect: "allow" },
			{ action: "webfetch", resource: "*", effect: "allow" },
			{ action: "websearch", resource: "*", effect: "allow" },
			{ action: "read", resource: "*", effect: "allow" },
		// OpenCode v2 has no separate list tool: its `read` accepts "File or
		// directory to read" and lists directory entries. Pi splits that into
		// `read` (files only, EISDIR on directories) and `ls`. The ruleset below
		// grants `ls` here to preserve the
		// capability `read` provides upstream.
			{ action: "list", resource: "*", effect: "allow" },
			{ action: "read", resource: "*.env", effect: "ask" },
			{ action: "read", resource: "*.env.*", effect: "ask" },
			{ action: "read", resource: "*.env.example", effect: "allow" },
			{ action: "subagent", resource: "*", effect: "deny" },
			// Pi addition: pi-vcc's context recall.
			{ action: "vcc_recall", resource: "*", effect: "allow" },
			// V2 merges this after the deny-all, so outside paths ask rather than deny.
			{ action: "external_directory", resource: "*", effect: "ask" },
		],
	},
	builtinScout(),
];
