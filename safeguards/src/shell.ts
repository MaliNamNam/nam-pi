/**
 * Synchronous port of OpenCode v2 ShellParse.scanPortable and its permission
 * prefixes/directory arguments. Uses the upstream scanner, not regex splitting.
 * Source: anomalyco/opencode@0bef0eab678e94a389930a2a1365115fd5a35c69
 * packages/core/src/shell/parse.ts (MIT; see ../LICENSE.opencode).
 */
import os from "node:os";
import path from "node:path";
import { scan as scanBash, scanPowerShell } from "./shell-scan.ts";

export interface ScannedCommand { resource: string; save: string; }
export interface ScanResult { commands: ScannedCommand[]; directories: string[]; }
export interface ScanOptions { cwd: string; toolName?: string; }

const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"]);
const POWERSHELL_PATH_FLAGS = new Set(["-literalpath", "-path"]);
const ARITY: Record<string, number> = {
	cat: 1, cd: 1, chmod: 1, chown: 1, cp: 1, echo: 1, env: 1, export: 1, grep: 1, kill: 1,
	killall: 1, ln: 1, ls: 1, mkdir: 1, mv: 1, ps: 1, pwd: 1, rm: 1, rmdir: 1, sleep: 1,
	source: 1, tail: 1, touch: 1, unset: 1, which: 1,
	aws: 3, az: 3, bazel: 2, brew: 2, bun: 2, "bun run": 3, "bun x": 3, cargo: 2,
	"cargo add": 3, "cargo run": 3, cdk: 2, cf: 2, cmake: 2, composer: 2, consul: 2,
	"consul kv": 3, crictl: 2, deno: 2, "deno task": 3, doctl: 3, docker: 2,
	"docker builder": 3, "docker compose": 3, "docker container": 3, "docker image": 3,
	"docker network": 3, "docker volume": 3, eksctl: 2, "eksctl create": 3, firebase: 2,
	flyctl: 2, gcloud: 3, gh: 3, git: 2, "git config": 3, "git remote": 3, "git stash": 3,
	go: 2, gradle: 2, helm: 2, heroku: 2, hugo: 2, ip: 2, "ip addr": 3, "ip link": 3,
	"ip netns": 3, "ip route": 3, kind: 2, "kind create": 3, kubectl: 2,
	"kubectl kustomize": 3, "kubectl rollout": 3, kustomize: 2, make: 2, mc: 2, "mc admin": 3,
	minikube: 2, mongosh: 2, mysql: 2, mvn: 2, ng: 2, npm: 2, "npm exec": 3, "npm init": 3,
	"npm run": 3, "npm view": 3, npx: 2, nvm: 2, nx: 2, openssl: 2, "openssl req": 3,
	"openssl x509": 3, pip: 2, pipenv: 2, pnpm: 2, "pnpm dlx": 3, "pnpm exec": 3, "pnpm run": 3,
	poetry: 2, podman: 2, "podman container": 3, "podman image": 3, psql: 2, pulumi: 2,
	"pulumi stack": 3, python: 2, pyenv: 2, rake: 2, rbenv: 2, "redis-cli": 2, rustup: 2,
	serverless: 2, sfdx: 3, skaffold: 2, sls: 2, sst: 2, swift: 2, systemctl: 2, terraform: 2,
	"terraform workspace": 3, tmux: 2, turbo: 2, ufw: 2, vault: 2, "vault auth": 3, "vault kv": 3,
	vercel: 2, volta: 2, wp: 2, yarn: 2, "yarn dlx": 3, "yarn run": 3,
};
const PREFIX_LENGTH = Math.max(...Object.values(ARITY));

type Part = { type: string; text: string };

function prefix(tokens: string[]): string[] {
	for (let length = tokens.length; length > 0; length--) {
		const arity = ARITY[tokens.slice(0, length).join(" ")];
		if (arity !== undefined) return tokens.slice(0, arity);
	}
	return tokens.slice(0, 1);
}

function matchesPrefix(resource: string, pattern: string): boolean {
	let escaped = pattern.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*").replace(/\?/g, ".");
	if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";
	return new RegExp(`^${escaped}$`, "s").test(resource.replaceAll("\\", "/"));
}

export function scan(command: string, options: ScanOptions): ScanResult {
	const powershell = options.toolName === "powershell";
	const result = powershell ? scanPowerShell(command) : scanBash(command);
	if (result.kind === "opaque") throw new Error(`Shell scanner cannot analyze command: ${result.reason}`);
	const output: ScanResult = { commands: [], directories: [] };
	for (const item of result.commands) {
		if (item.declaration) continue;
		const words = item.redirectWordCount === undefined ? item.rawWords : item.rawWords.slice(0, item.redirectWordCount);
		if (powershell && item.statementHead && /^foreach(?:-|$)/i.test(words[0] ?? "")) continue;
		const name = powershell ? words[0]?.toLowerCase() : words[0];
		if (CWD.has(name)) {
			output.directories.push(...directoryArgs(words.flatMap((text): Part[] => {
				const parameter = powershell ? /^(-(?:literalpath|path)):(.*)$/i.exec(text) : undefined;
				if (parameter) return [{ type: "command_parameter", text: parameter[1] }, { type: "word", text: parameter[2] }];
				return [{ type: powershell && text.startsWith("-") ? "command_parameter" : "word", text }];
			}), powershell, options.cwd));
			continue;
		}
		const selected = prefix(words.slice(0, PREFIX_LENGTH));
		const conventional = `${selected.join(" ")} *`;
		const end = item.wordEnds?.[selected.length - 1];
		const save = !powershell || end === undefined || matchesPrefix(item.resource, conventional)
			? conventional
			: (() => {
				const boundary = item.wordEnds?.find((value) => value >= end && (value >= item.resource.length || /\s/.test(item.resource[value]))) ?? end;
				const separator = /^\s+(?:`(?:\r\n|\r|\n)\s*)?/.exec(item.resource.slice(boundary))?.[0];
				return `${item.resource.slice(0, boundary)}${separator ?? " "}*`;
			})();
		output.commands.push({ resource: item.resource, save });
	}
	// OpenCode resolves each directory against the invocation cwd, not a guessed
	// runtime cwd (conditional commands and subshells need not execute).
	output.directories = output.directories.map((directory) => path.resolve(options.cwd, directory));
	return output;
}

function directoryArgs(command: Part[], powershell: boolean, cwd: string): string[] {
	if (!powershell) return command.slice(1).filter((part) => !part.text.startsWith("-"))
		.map((part) => directoryArgument(part.text, powershell, cwd)).filter((part): part is string => part !== undefined);
	const directories: string[] = [];
	let nextPath = false;
	for (const part of command.slice(1)) {
		if (nextPath) {
			const value = directoryArgument(part.text, powershell, cwd);
			if (value) directories.push(value);
			nextPath = false;
			continue;
		}
		if (part.type === "command_parameter") { nextPath = POWERSHELL_PATH_FLAGS.has(part.text.toLowerCase()); continue; }
		const value = directoryArgument(part.text, powershell, cwd);
		if (value) directories.push(value);
	}
	return directories;
}

function environment(key: string): string | undefined {
	if (process.platform !== "win32") return process.env[key];
	const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase());
	return name ? process.env[name] : undefined;
}

function directoryArgument(value: string, powershell: boolean, cwd: string): string | undefined {
	const quote = value[0];
	let text = (quote === '"' || quote === "'") && value.at(-1) === quote ? value.slice(1, -1) : value;
	if (powershell) text = text
		.replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => environment(key) ?? "")
		.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => environment(key) ?? "")
		.replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => {
			if (key.toUpperCase() === "HOME") return os.homedir();
			if (key.toUpperCase() === "PWD") return cwd;
			return process.env.PSHOME ?? "$PSHOME";
		});
	if (text.includes("$") || text.includes("`") || text.startsWith("(")) return undefined;
	if (text === "~") return os.homedir();
	if (text.startsWith("~/") || (process.platform === "win32" && text.startsWith("~\\"))) return path.join(os.homedir(), text.slice(2));
	return text;
}
