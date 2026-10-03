import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchWildcard } from "./permissions.ts";
import type { PermissionRule } from "./types.ts";

export interface PermissionPath {
	absolute: string;
	canonical: string;
	canonicalCwd: string;
	/** Logical and physical spellings are separate checks; either can deny. */
	groups: string[][];
}
const WINDOWS = process.platform === "win32";
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const slash = (value: string): string => value.split(path.sep).join("/");

function windowsComponent(value: string): string | undefined {
	const colon = value.indexOf(":");
	const base = (colon < 0 ? value : value.slice(0, colon)).replace(/[ .]+$/, "");
	if (value && !base || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\.|$)/i.test(base)) return undefined;
	return base + (colon < 0 ? "" : value.slice(colon));
}

function windowsFilePath(value: string): string | undefined {
	const root = path.win32.parse(value).root;
	const components = value.slice(root.length).split("\\").map(windowsComponent);
	return components.some((component) => component === undefined) ? undefined : root + components.join("\\");
}

/** Match Pi's built-in resolveToCwd, including its read filename recovery. */
export function resolveToolPath(cwd: string, raw: string, read = false): string | undefined {
	try {
		if (raw.includes("\0")) return undefined;
		let value = raw.replace(UNICODE_SPACES, " ");
		if (value.startsWith("@")) value = value.slice(1);
		if (WINDOWS && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) {
			const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(value);
			if (drive) value = `${drive[1].toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
		}
		if (value === "~") value = os.homedir();
		else if (value.startsWith("~/") || WINDOWS && value.startsWith("~\\")) value = path.join(os.homedir(), value.slice(2));
		if (value.startsWith("file://")) value = fileURLToPath(value);
		// Device/verbatim paths do not have ordinary filesystem normalization.
		// Never authorize them as if they were a file underneath the workspace.
		if (WINDOWS && /^[\\/]{2}[?.][\\/]/.test(value)) return undefined;
		const absolute = WINDOWS ? windowsFilePath(path.resolve(cwd, value)) : path.resolve(cwd, value);
		if (!absolute) return undefined;
		if (!read || fs.existsSync(absolute)) return absolute;
		const amPm = absolute.replace(/ (AM|PM)\./gi, "\u202f$1.");
		const nfd = absolute.normalize("NFD");
		const curly = absolute.replace(/'/g, "\u2019");
		return [amPm, nfd, curly, nfd.replace(/'/g, "\u2019")].find((candidate) => fs.existsSync(candidate)) ?? absolute;
	} catch { return undefined; }
}

/** Resolve existing ancestors and dangling links; ambiguity fails closed. */
export function canonicalPath(value: string, seen = new Set<string>()): string | undefined {
	let current = path.resolve(value);
	const missing: string[] = [];
	while (true) {
		try {
			const real = fs.realpathSync.native(current);
			if (missing.length && !fs.statSync(real).isDirectory()) return undefined;
			return path.resolve(real, ...missing);
		}
		catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") return undefined;
		}
		try {
			const stat = fs.lstatSync(current);
			if (stat.isSymbolicLink()) {
				const key = WINDOWS ? current.toLowerCase() : current;
				if (seen.has(key) || seen.size >= 40) return undefined;
				seen.add(key);
				const target = path.resolve(path.dirname(current), fs.readlinkSync(current));
				const resolved = canonicalPath(target, seen);
				return resolved ? path.resolve(resolved, ...missing) : undefined;
			}
			return undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		missing.unshift(path.basename(current));
		current = parent;
	}
}

export function insideRelative(root: string, absolute: string): string | undefined {
	const relative = path.relative(root, absolute);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
		? slash(relative || ".") : undefined;
}

function aliases(absolute: string, cwd: string, realCwd: string): string[] {
	const relative = insideRelative(cwd, absolute) ?? insideRelative(realCwd, absolute);
	return [...new Set(relative === undefined ? [slash(absolute)] : [
		relative, slash(absolute), slash(path.resolve(cwd, relative)), slash(path.resolve(realCwd, relative)),
	])];
}

function streamBase(absolute: string): string {
	if (!WINDOWS) return absolute;
	const separator = Math.max(absolute.lastIndexOf("\\"), absolute.lastIndexOf("/"));
	const colon = absolute.indexOf(":", separator + 1);
	return colon > separator ? absolute.slice(0, colon) : absolute;
}

export function resolvePermissionPath(cwd: string, raw: string, read = false): PermissionPath | undefined {
	const absolute = resolveToolPath(cwd, raw, read);
	const canonicalCwd = canonicalPath(cwd);
	if (!absolute || !canonicalCwd) return undefined;
	// NTFS alternate streams inherit the base file's protection, including links.
	const base = streamBase(absolute);
	const realBase = canonicalPath(base);
	if (!realBase) return undefined;
	const canonical = realBase + absolute.slice(base.length);
	const logical = [...new Set([...aliases(absolute, cwd, canonicalCwd), ...aliases(base, cwd, canonicalCwd)])];
	const physical = [...new Set([...aliases(canonical, cwd, canonicalCwd), ...aliases(realBase, cwd, canonicalCwd)])];
	const groups = [logical];
	if (logical.length !== physical.length || logical.some((alias, index) => alias !== physical[index])) groups.push(physical);
	return { absolute, canonical, canonicalCwd, groups };
}

/** Only normalize literal pattern prefixes: never collapse wildcard/.. semantics. */
export function normalizePathPattern(pattern: string): string {
	let value = pattern.replaceAll("\\", "/");
	if (value === "~" || value === "$HOME") value = slash(os.homedir());
	else if (value.startsWith("~/")) value = `${slash(os.homedir())}/${value.slice(2)}`;
	else if (value.startsWith("$HOME/")) value = `${slash(os.homedir())}/${value.slice(6)}`;
	const wildcard = value.search(/[?*]/);
	const end = wildcard < 0 ? value.length : value.lastIndexOf("/", wildcard) + 1;
	const prefix = value.slice(0, end);
	if (prefix) {
		let normalized = WINDOWS ? path.win32.normalize(prefix).replaceAll("\\", "/") : path.posix.normalize(prefix);
		if (WINDOWS) {
			// Rule prefixes are lexical, never realpathed: an attacker must not be
			// able to widen a grant by replacing its directory with a symlink.
			normalized = normalized.split("/").map((component, index) =>
				component === "." || component === ".." || index === 0 && /^[a-z]:$/i.test(component)
					? component : component.replace(/[ .]+$/, "")).join("/");
		}
		value = (normalized === "./" ? "" : normalized) + value.slice(end);
	}
	return WINDOWS ? value.toLowerCase() : value;
}

/** Aliases of one spelling are matched together, preserving last-match-wins. */
export function evaluatePath(action: string, resources: readonly string[], rules: readonly PermissionRule[]): {
	effect: "allow" | "ask" | "deny"; rule?: PermissionRule;
} {
	for (let index = rules.length - 1; index >= 0; index--) {
		const rule = rules[index];
		if (!matchWildcard(action, rule.action)) continue;
		const pattern = normalizePathPattern(rule.resource);
		if (resources.some((resource) => matchWildcard(WINDOWS ? resource.toLowerCase() : resource, pattern))) {
			return { effect: rule.effect, rule };
		}
	}
	return { effect: "ask" };
}
