import assert from "node:assert/strict";
import test from "node:test";
import { JsonlLines } from "./helpers/jsonl-lines.ts";

test("benchmark JSONL framing scans chunks without splitting Unicode separators", () => {
  const lines: string[] = [];
  const reader = new JsonlLines((line: string) => lines.push(line));
  const expected = ['{"text":"😀\u2028\u2029"}', '{"next":true}', ''];
  const bytes = Buffer.from(expected.join("\r\n") + "\n");
  for (const byte of bytes) reader.push(Buffer.from([byte]));
  reader.end();
  assert.deepEqual(lines, expected);
});

test("benchmark JSONL framing emits a multi-megabyte result once and preserves the following response", () => {
  const lines: string[] = [];
  const reader = new JsonlLines((line: string) => lines.push(line));
  const large = JSON.stringify({ text: "x".repeat(8 * 1024 * 1024) });
  for (let start = 0; start < large.length; start += 4096) reader.push(large.slice(start, start + 4096));
  assert.equal(lines.length, 0);
  reader.push('\n{"type":"response"}\n');
  reader.end();
  assert.deepEqual(lines, [large, '{"type":"response"}']);
});

test("benchmark JSONL framing handles coalesced records, CRLF and an unterminated final record", () => {
  const lines: string[] = [];
  const reader = new JsonlLines((line: string) => lines.push(line));
  reader.push("a\r"); reader.push("\nb\nlast"); reader.end(); reader.end();
  assert.deepEqual(lines, ["a", "b", "last"]);
});
