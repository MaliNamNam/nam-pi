import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const artifacts = [
	".pi-worktrees/child/source.ts",
	"nested/sessions/.pi-worktrees/child/source.ts",
	"nested/sessions/.pi-subagents/parent/child.jsonl",
	"nested/sessions/.pi-agents-owners/child.json",
	"nested/sessions/.pi-agents-forms/host/request.json",
	"nested/sessions/.pi-agents-interrupts/child.json",
	"nested/sessions/.pi-agents-shells/shell.json",
	"nested/project/.pi/agents/jobs/child.jsonl",
];
const sources = [
	"agents/src/worktrees.ts",
	"agents/docs/worktrees.md",
	"agents/test/helpers/fake-pi.mjs",
	"agents/test/worktree-dispatch.test.ts",
	"agents/test/worktrees.test.ts",
	"test/worktree-ui.test.mjs",
];
function ignored(paths) {
	try {
		return execFileSync("git", ["check-ignore", "--no-index", "--stdin"], {
			cwd, input: `${paths.join("\n")}\n`, encoding: "utf8", windowsHide: true,
		}).trim().split(/\r?\n/).filter(Boolean);
	} catch (error) {
		if (error.status === 1) return [];
		throw error;
	}
}

test("generated worktrees, child sessions and permission transport state are ignored at any depth", () => {
	assert.deepEqual(ignored(artifacts), artifacts);
});

test("worktree implementation, documentation and regression tests remain commit-eligible", () => {
	assert.deepEqual(ignored(sources), []);
});
