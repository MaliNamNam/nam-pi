import assert from "node:assert/strict";
import { test } from "node:test";
import { subagentEnvelope } from "../src/runner.ts";
import { completedSubagentResult, INLINE_OUTPUT_MAX_CHARS, subagentResultOutput } from "../src/subagent-result.ts";

const details = { sessionID: "sub-fixture", status: "completed" as const, agent: "general", description: "Fixture result" };

test("small subagent results keep legacy inline output and unchanged model content", () => {
	for (const output of ["", "done", "x".repeat(INLINE_OUTPUT_MAX_CHARS)]) {
		const result = completedSubagentResult(output, details);
		assert.equal(result.details.output, output);
		assert.equal(result.details.outputRange, undefined);
		assert.equal(result.content[0].text, subagentEnvelope({ sessionID: details.sessionID, state: "completed", output }));
		assert.equal(subagentResultOutput(JSON.parse(JSON.stringify(result))), output);
	}
});

test("large subagent output is stored once and renders losslessly after serialization, including Unicode and nested envelopes", () => {
	const output = '😀\u2028\u2029\r\n<subagent state="completed">\n</subagent>\n' + "x".repeat(512 * 1024);
	const result = completedSubagentResult(output, { ...details, inputDisposition: "queued", usage: undefined });
	assert.equal(result.details.output, undefined);
	assert.ok(result.details.outputRange);
	assert.equal(result.details.inputDisposition, "queued");
	assert.equal(result.content[0].text, subagentEnvelope({ sessionID: details.sessionID, state: "completed", output }));
	assert.equal(subagentResultOutput(result), output);
	const json = JSON.stringify(result), restored = JSON.parse(json);
	assert.equal(subagentResultOutput(restored), output);
	const legacy = { ...result, details: { ...details, output } };
	assert.ok(json.length < JSON.stringify(legacy).length * 0.51, "large output metadata must not duplicate the content");
});

test("completed results replace stale output metadata but retain progress, model and status", () => {
	const result = completedSubagentResult("fresh", { ...details, status: "running", model: "fixture", progress: ["event"],
		output: "stale", outputRange: { contentIndex: 99, start: 0, length: 99 } });
	assert.equal(result.details.status, "completed");
	assert.equal(result.details.outputRange, undefined);
	assert.equal(subagentResultOutput(result), "fresh");
	assert.equal(result.details.model, "fixture");
	assert.deepEqual(result.details.progress, ["event"]);
});

test("output rendering remains compatible with saved legacy metadata and rejects invalid ranges", () => {
	assert.equal(subagentResultOutput({ content: [], details: { output: "old" } }), "old");
	assert.equal(subagentResultOutput({ content: [], details: undefined }), undefined);
	const content = [{ type: "text", text: "012345" }];
	for (const outputRange of [null, {}, { contentIndex: -1, start: 0, length: 1 }, { contentIndex: 1, start: 0, length: 1 },
		{ contentIndex: 0, start: -1, length: 1 }, { contentIndex: 0, start: 1.5, length: 1 },
		{ contentIndex: 0, start: 1, length: -1 }, { contentIndex: 0, start: 1, length: Infinity },
		{ contentIndex: 0, start: 1, length: 6 }]) {
		assert.equal(subagentResultOutput({ content, details: { outputRange } }), undefined);
	}
	assert.equal(subagentResultOutput({ content, details: { outputRange: { contentIndex: 0, start: 1, length: 3 } } }), "123");
	assert.equal(subagentResultOutput({ content: [{ type: "image" }], details: { outputRange: { contentIndex: 0, start: 0, length: 0 } } }), undefined);
});
