/**
 * Scout subagent — EXPERIMENTAL, matching OpenCode v2.
 *
 * Status note: OpenCode v2 documents Scout (`packages/web/src/content/docs/agents.mdx`)
 * and gates it behind `OPENCODE_EXPERIMENTAL_SCOUT`, but ships no implementation:
 * there is no Scout entry in `packages/core/src/plugin/agent.ts`, no `scout` key in
 * the config schema, and no source file for it. The description below is copied
 * from the docs; the prompt is written to match that documented behavior.
 *
 * In OpenCode this agent clones dependencies into a managed cache so the model can
 * inspect upstream source without touching the workspace. Pi has no managed cache,
 * so the equivalent is a scratch directory under the agent dir. Set
 * `safeguards.experimental.scout: false` (or `OPENCODE_EXPERIMENTAL_SCOUT=0`) to
 * disable it, mirroring OpenCode's default of off.
 */

import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition } from "./types.ts";

/** Scratch directory for cloned dependencies, outside the workspace. */
export function scoutCacheDir(): string {
	return path.join(getAgentDir(), "cache", "scout");
}

/** OpenCode's documented Scout description, verbatim. */
const DESCRIPTION =
	"A read-only agent for external docs and dependency research. Use this when you need to clone a dependency repository into OpenCode's managed cache, inspect library source, or cross-reference local code against upstream implementations without modifying your workspace.";

/**
 * The Scout system prompt.
 *
 * The cache directory is interpolated rather than described, because the agent
 * must clone into a specific place: OpenCode's managed cache has no Pi
 * equivalent, so this is the scratch directory the ruleset also grants.
 */
export const scoutPrompt = (cacheDir: string) => `You are a dependency research specialist. You investigate external libraries and cross-reference them against local code.

Your strengths:
- Locating and cloning dependency repositories into a scratch cache
- Reading upstream source to answer questions about library behavior
- Cross-referencing installed versions against upstream implementations
- Checking official documentation and changelogs

Guidelines:
- Clone repositories only into this scratch cache directory, never into the workspace:
  ${cacheDir}
- Use Glob to find files and Grep to search contents within the cloned source
- Use Read when you know the specific file path you need
- Use WebFetch and WebSearch for official documentation, release notes, and changelogs
- Match the version you are investigating to the one the project actually depends on; check lockfiles and manifests first
- Return file paths as absolute paths in your final response
- For clear communication, avoid using emojis
- Do not modify the workspace: no file edits, and no bash commands that change the user's system state beyond the scratch cache

Report your findings clearly, distinguishing what upstream source actually shows from what documentation claims.`;

/**
 * Built from OpenCode's documented behavior. The permission ruleset is the
 * Explore ruleset plus shell access for `git clone` into the cache, since
 * cloning is the defining capability of this agent.
 *
 * A function rather than a constant so the prompt names the real cache path.
 */
export function builtinScout(): AgentDefinition {
	const cacheDir = scoutCacheDir().replaceAll("\\", "/");
	return {
	id: "scout",
	toolsFromPermissions: true,
	name: "Scout",
	description: DESCRIPTION,
	mode: "subagent",
	hidden: false,
	experimental: true,
	systemPrompt: scoutPrompt(cacheDir),
	// Needs bash for git clone, and read/grep/glob for inspecting the result.
	tools: ["read", "grep", "find", "ls", "bash", "webfetch", "websearch"],
	permissions: [
		{ action: "*", resource: "*", effect: "deny" },
		{ action: "grep", resource: "*", effect: "allow" },
		{ action: "glob", resource: "*", effect: "allow" },
		{ action: "webfetch", resource: "*", effect: "allow" },
		{ action: "websearch", resource: "*", effect: "allow" },
		{ action: "read", resource: "*", effect: "allow" },
		// Pi splits OpenCode's directory-reading `read` into `read` + `ls`.
		{ action: "list", resource: "*", effect: "allow" },
		{ action: "read", resource: "*.env", effect: "ask" },
		{ action: "read", resource: "*.env.*", effect: "ask" },
		{ action: "read", resource: "*.env.example", effect: "allow" },
		// Only clone/fetch into the scratch cache; everything else is denied.
		{ action: "bash", resource: "*", effect: "deny" },
		{ action: "bash", resource: "git clone *", effect: "allow" },
		{ action: "bash", resource: "git fetch *", effect: "allow" },
		{ action: "bash", resource: "git log *", effect: "allow" },
		{ action: "bash", resource: "git show *", effect: "allow" },
		{ action: "bash", resource: "git diff *", effect: "allow" },
		{ action: "subagent", resource: "*", effect: "deny" },
	],
	};
}
