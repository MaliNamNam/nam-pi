import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { requestForm, type FormPayload } from "../src/forms.ts";

async function pendingForm(t: TestContext, payload: FormPayload) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "pi-forms-test-"));
  const directory = path.join(parent, randomUUID());
  await fs.mkdir(directory);
  const lease = path.join(directory, "lease");
  await fs.writeFile(lease, "");
  const controller = new AbortController();
  const interactionID = randomUUID();
  let settled = false;
  const reply = requestForm(JSON.stringify({ directory }), "root", payload, controller.signal, interactionID).then((value) => {
    settled = true;
    return value;
  });
  t.after(async () => {
    controller.abort();
    await reply;
    await fs.rm(parent, { recursive: true, force: true });
  });
  let request: string | undefined;
  for (let attempt = 0; attempt < 100 && !request; attempt++) {
    request = (await fs.readdir(directory)).find((file) => file.endsWith(".request"));
    if (!request) await delay(10);
  }
  assert.ok(request, "form request was published");
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, request), "utf8")).interactionID, interactionID);
  await delay(150);
  const now = Date.now();
  const later = new Date(now + 600_000);
  await fs.utimes(lease, later, later);
  t.mock.timers.enable({ apis: ["Date"], now });
  t.mock.timers.tick(600_000);
  await delay(250);
  return { directory, lease, request, reply, controller, settled: () => settled };
}

const permission: FormPayload = {
  kind: "permission", tool: "read", reason: "External directory",
  checks: [{ action: "external_directory", resource: "/outside" }],
};
const question: FormPayload = {
  kind: "question", questions: [{ header: "Choice", question: "Which option?", options: [{ label: "A", description: "First" }] }],
};

for (const payload of [permission, question]) {
  test(`${payload.kind} forms wait beyond the former deadline and accept a response`, { timeout: 5000 }, async (t) => {
    const form = await pendingForm(t, payload);
    assert.equal(form.settled(), false, "AFK time must not resolve the form");
    const response = { reply: "once", ...(payload.kind === "question" ? { answers: [["A"]] } : {}) };
    await fs.writeFile(path.join(form.directory, form.request.replace(/\.request$/, ".reply")), JSON.stringify(response));
    assert.deepEqual(await form.reply, response);
    assert.deepEqual((await fs.readdir(form.directory)).filter((file) => file !== "lease"), []);
  });
}

test("a waiting form can still be cancelled after the former deadline", { timeout: 5000 }, async (t) => {
  const form = await pendingForm(t, question);
  assert.equal(form.settled(), false);
  form.controller.abort();
  assert.deepEqual(await form.reply, { reply: "reject", reason: "cancelled" });
  assert.deepEqual((await fs.readdir(form.directory)).filter((file) => file !== "lease"), []);
});

test("a waiting form rejects when its host disappears", { timeout: 5000 }, async (t) => {
  const form = await pendingForm(t, permission);
  assert.equal(form.settled(), false);
  await fs.rm(form.lease);
  assert.deepEqual(await form.reply, { reply: "reject", reason: "unavailable" });
  assert.deepEqual(await fs.readdir(form.directory), []);
});
