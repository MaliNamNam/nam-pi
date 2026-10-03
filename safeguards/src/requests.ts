/**
 * Maps Pi tool calls to OpenCode permission requests.
 *
 * Pi tool -> OpenCode permission:
 *   read                 -> read
 *   edit                 -> edit
 *   write                -> edit
 *   grep                 -> grep
 *   find                 -> glob
 *   ls                   -> list
 *   bash / powershell    -> bash
 *   any tool + external  -> external_directory
 *   repeated tool calls  -> doom_loop
 */

import path from "node:path";
import {
	canonicalPath,
	isDirectory,
	type Check,
	type SafeguardEngine,
	type ToolRequest,
	truncate,
} from "./engine.ts";
import { globPrefix, toPosix } from "./rules.ts";

/** Tools that take a single path parameter named `path`. */
const PATH_TOOLS: Record<string, string> = {
	read: "read",
	edit: "edit",
	write: "edit",
	grep: "grep",
	find: "glob",
	ls: "list",
};

export interface BuildContext {
	engine: SafeguardEngine;
	toolName: string;
	input: Record<string, unknown>;
}

export function isPathTool(toolName: string): boolean {
	return toolName in PATH_TOOLS;
}

/** Build the request for a path-taking tool. Returns undefined when unsupported. */
export function buildPathRequest(context: BuildContext): ToolRequest | undefined {
	const { engine, toolName, input } = context;
	const action = PATH_TOOLS[toolName];
	if (!action) return undefined;

	const rawPath = stringValue(input.path);
	const checks: Check[] = [];
	const lines: string[] = [];

	if (action === "edit") {
		const target = resolveTarget(engine, rawPath, false);
		if (target.external) {
			const external = engine.externalCheck(target.absolute, target.grant);
			if (external) checks.push(external);
		}
		checks.push({ action: "edit", resources: [target.resource], save: ["*"] });
		lines.push(`Path: ${engine.displayPath(target.absolute)}`);
		const diff = diffPreview(input);
		return {
			toolName,
			checks,
			title: `Edit ${engine.displayPath(target.absolute)}`,
			lines,
			diff,
		};
	}

	if (action === "read") {
		const target = resolveTarget(engine, rawPath, false);
		if (target.external) {
			const external = engine.externalCheck(target.absolute, target.grant);
			if (external) checks.push(external);
		}
		checks.push({ action: "read", resources: [target.resource], save: ["*"] });
		return {
			toolName,
			checks,
			title: `Read ${engine.displayPath(target.absolute)}`,
			lines: [`Path: ${engine.displayPath(target.absolute)}`],
		};
	}

	if (action === "grep" || action === "glob" || action === "list") {
		const target = resolveTarget(engine, rawPath, true);
		if (target.external) {
			const external = engine.externalCheck(target.absolute, target.grant);
			if (external) checks.push(external);
		}
		const pattern = stringValue(input.pattern) || stringValue(input.query) || "*";
		checks.push({ action, resources: [pattern], save: ["*"] });
		const label = action === "grep" ? "Grep" : action === "glob" ? "Glob" : "List";
		return {
			toolName,
			checks,
			title: `${label} "${pattern}"`,
			lines: [
				`Pattern: ${pattern}`,
				`Path: ${engine.displayPath(target.absolute)}`,
			],
		};
	}

	return undefined;
}

/** Build the request for the shell tools. */
export function buildShellRequest(context: BuildContext): ToolRequest | undefined {
	const { engine, toolName, input } = context;
	if (toolName !== "bash" && toolName !== "powershell") return undefined;
	const command = stringValue(input.command);
	if (!command) return undefined;
	return engine.shellRequest(command, toolName);
}

/** Build the request for any tool that touches an external path (covers extension tools). */
export function buildGenericPathRequest(context: BuildContext): ToolRequest | undefined {
	const { engine, toolName, input } = context;
	const rawPath = pathValue(input);
	if (!rawPath) return undefined;
	const target = resolveTarget(engine, rawPath, true);
	if (!target.external) return undefined;
	const external = engine.externalCheck(target.absolute, target.grant);
	if (!external) return undefined;
	return {
		toolName,
		checks: [external],
		title: `Access ${engine.displayPath(target.absolute)}`,
		lines: [`Path: ${target.absolute}`, `Working directory: ${engine.cwd}`],
	};
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function pathValue(input: Record<string, unknown>): string {
	for (const key of ["path", "file_path", "filePath", "filepath", "target", "directory", "dir"]) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return "";
}

interface Target {
	absolute: string;
	resource: string;
	grant: string;
	/** True when the path is outside the working directory. */
	external: boolean;
}

/**
 * Resolve a tool path. Search tools treat their path as a directory, file tools
 * as a file, which selects the right external-directory boundary.
 */
function resolveTarget(engine: SafeguardEngine, rawPath: string, preferDirectory: boolean): Target {
	const input = rawPath.trim() || ".";
	const resolved = engine.resolvePath(input);
	if (!resolved.external) return { ...resolved, external: false };

	const absolute = canonicalPath(resolved.absolute);
	const directory = preferDirectory || isDirectory(absolute);
	const boundary = directory ? absolute : path.dirname(absolute);
	return { ...engine.resolvePath(boundary), external: true };
}

/** Extract a diff or patch preview from edit/write inputs. */
function diffPreview(input: Record<string, unknown>): string | undefined {
	const direct = input.diff ?? input.patch ?? input.patchText;
	if (typeof direct === "string" && direct.trim()) return truncate(direct, 4000);

	const edits = input.edits;
	if (Array.isArray(edits)) {
		const parts: string[] = [];
		for (const entry of edits.slice(0, 8)) {
			if (!entry || typeof entry !== "object") continue;
			const record = entry as Record<string, unknown>;
			const oldText = stringValue(record.oldText);
			const newText = stringValue(record.newText);
			if (!oldText && !newText) continue;
			parts.push(
				[
					`- ${truncate(firstLine(oldText), 120)}`,
					`+ ${truncate(firstLine(newText), 120)}`,
				].join("\n"),
			);
		}
		if (parts.length > 0) return truncate(parts.join("\n"), 4000);
	}

	const content = stringValue(input.content);
	if (content) {
		const preview = content.split("\n").slice(0, 12).join("\n");
		return truncate(`+ ${preview.split("\n").join("\n+ ")}`, 4000);
	}
	return undefined;
}

function firstLine(value: string): string {
	const line = value.split("\n").find((item) => item.trim().length > 0) ?? "";
	return line.trim();
}

/** Glob root used for external-directory grants on search tools. */
export function searchGrant(absolute: string): string {
	return toPosix(path.join(globPrefix(absolute), "*"));
}
