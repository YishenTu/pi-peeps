/**
 * Native delivery contract tests.
 *
 * These drive the real ResultDelivery through a real Pi AgentSession and
 * extension runtime (fake provider, in-memory stores, temp dirs). They cover
 * the behaviors the Peeps extension depends on:
 *   - a busy result steers at the native boundary with exact custom text
 *   - an idle result automatically starts a provider call with no user prompt
 *   - Stop holds later results until an ordinary interactive prompt drains them
 *   - a native clearQueue loss leaves the queued notice unconfirmed, never resent
 *   - the startup/shutdown fence closes delivery against late results
 *
 * Provider-facing role and transcript role are asserted separately, and the
 * custom body is compared exactly (Unicode, whitespace, no truncation).
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { RESULT_TYPE } from "../src/delivery.ts";
import { createScene, latch, textOf, toOutcome } from "./fixtures/native-harness.ts";

let networkAttempts = 0;
globalThis.fetch = (() => {
  networkAttempts++;
  return Promise.reject(new Error("NETWORK DISABLED IN NATIVE DELIVERY TEST"));
}) as typeof fetch;

const TIMEOUT_MS = 30_000;

function noticeContent(id: string, status: string, body: string): string {
  return "[Peeps automated result \u2014 " + id + " \u2014 " + status + "]\n" + body;
}

test("busy result steers at the boundary with the exact custom text", { timeout: TIMEOUT_MS }, async (t) => {
  const gate = latch();
  const scene = await createScene(t, { plans: [{ gate, text: "parent-working" }, { text: "parent-after-notice" }] });
  const body = "FINAL_CHILD_RESPONSE: fixed auth\nExact punctuation: <>& \u4e2d\u6587 \u2705\n  keep trailing  ";
  const run = scene.run("run-busy", body);

  const turn = scene.session.prompt("Do parent work.");
  await gate.entered.promise;

  assert.equal(scene.session.isIdle, false, "precondition: the parent turn is busy");
  scene.offer(run);

  assert.equal(scene.sent.length, 1, "busy result is handed to native steering immediately");
  assert.deepEqual(scene.sent[0]?.options, { deliverAs: "steer", triggerTurn: true });
  assert.equal(scene.requests.length, 1, "the notice must not enter the in-flight request");
  assert.equal(
    scene.requests[0]?.messages.some((message) => textOf(message).includes("FINAL_CHILD_RESPONSE")),
    false,
  );

  gate.release.resolve();
  await turn;

  assert.equal(scene.requests.length, 2, "the notice pins one boundary request");
  const expected = noticeContent("run-busy", "answer", body);
  const delivered = scene.requests[1]?.messages.filter((message) => textOf(message) === expected) ?? [];
  assert.equal(delivered.length, 1, "exactly one provider-facing copy");
  assert.equal(delivered[0]?.role, "user", "provider sees the custom notice as a user-role message");

  const notices = scene.notices();
  assert.equal(notices.length, 1, "transcript keeps one native custom message");
  assert.equal(notices[0]?.role, "custom", "transcript role stays custom");
  assert.equal(notices[0]?.customType, RESULT_TYPE);
  assert.equal(notices[0]?.content, expected, "transcript text is exact and untruncated");
  assert.equal(notices[0]?.content, scene.sent[0]?.message.content, "sent and appended text are identical");
  assert.equal(run.delivery, "appended", "settled reconcile confirms the native append");
});

test("idle result automatically starts a provider call without a user prompt", { timeout: TIMEOUT_MS }, async (t) => {
  const scene = await createScene(t);
  const body = "IDLE_FINAL: \u4f60\u597d \u2705  exact";
  const run = scene.run("run-idle", body);

  await scene.session.prompt("Initial prompt.");
  assert.equal(scene.requests.length, 1);
  assert.equal(scene.inputSources.length, 1, "only the initial ordinary prompt");
  const settles = scene.settles;

  scene.offer(run);
  await scene.waitFor(() => scene.requests.length === 2, "automatic idle provider call");
  await scene.waitFor(() => scene.settles > settles, "settle after the wake");

  assert.equal(scene.inputSources.length, 1, "the automatic wake did not fabricate user input");
  assert.equal(scene.starts, 2, "a real agent run started from the notice alone");

  const expected = noticeContent("run-idle", "answer", body);
  const delivered = scene.requests[1]?.messages.filter((message) => textOf(message) === expected) ?? [];
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.role, "user");
  assert.equal(scene.notices().length, 1);
  assert.equal(scene.notices()[0]?.content, expected);
  assert.equal(run.delivery, "appended");
});

test("Stop holds later results until an interactive prompt drains them as nextTurn", { timeout: TIMEOUT_MS }, async (t) => {
  const gate = latch();
  const scene = await createScene(t, { plans: [{ gate, text: "working" }, { text: "resumed" }] });
  const body = "STOPPED-THEN-RESUMED";

  const turn = scene.session.prompt("Work until stopped.");
  await gate.entered.promise;
  await scene.session.abort();
  await turn;
  assert.equal(scene.session.isIdle, true);

  const run = scene.run("run-held", body);
  scene.offer(run);

  assert.equal(scene.sent.length, 0, "held result is not handed to native delivery while stopped");
  assert.equal(run.delivery, "held");
  assert.equal(scene.requests.length, 1, "a held result never wakes the provider on its own");

  await scene.session.prompt("Continue please.");

  assert.equal(scene.sent.length, 1, "the ordinary prompt drains exactly one held notice");
  assert.deepEqual(scene.sent[0]?.options, { deliverAs: "nextTurn", triggerTurn: false });
  const expected = noticeContent("run-held", "answer", body);
  const delivered = scene.requests[1]?.messages.filter((message) => textOf(message) === expected) ?? [];
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.role, "user");
  assert.equal(scene.notices().length, 1);
  assert.equal(scene.notices()[0]?.content, expected);
  assert.equal(run.delivery, "appended");
});

test("native clearQueue loss leaves a queued notice unconfirmed and never resent", { timeout: TIMEOUT_MS }, async (t) => {
  const gate = latch();
  const scene = await createScene(t, { plans: [{ gate }, { text: "resumed" }] });
  const body = "LOST-IN-NATIVE-QUEUE";
  const run = scene.run("run-lost", body);

  const turn = scene.session.prompt("Parent working.");
  await gate.entered.promise;
  scene.offer(run);
  assert.equal(scene.sent.length, 1);
  assert.equal(run.delivery, "queued");

  // Known host caveat (#9886): clearQueue drops the custom steer message without
  // reporting it, and Pi does not restore or resend it. Peeps records it as
  // unconfirmed rather than fabricating a second delivery.
  const cleared = scene.session.clearQueue();
  assert.equal(cleared.steering.length, 0, "custom results are invisible to the text queue report");
  assert.equal(cleared.followUp.length, 0);
  gate.release.resolve();
  await turn;

  assert.equal(run.delivery, "unconfirmed", "a settled queued notice absent from the branch is unconfirmed");
  assert.equal(scene.requests.length, 1, "the cleared notice never reached the provider");
  assert.equal(scene.notices().length, 0, "the cleared notice is not in the transcript");

  await scene.session.prompt("Continue after loss.");
  assert.equal(scene.sent.length, 1, "an unconfirmed notice is never resent automatically");
  assert.equal(scene.requests.length, 2);
  assert.equal(
    scene.requests[1]?.messages.some((message) => textOf(message).includes("LOST-IN-NATIVE-QUEUE")),
    false,
  );
  assert.equal(run.delivery, "unconfirmed");
});

test("startup wires delivery for the session and shutdown closes it against late results", { timeout: TIMEOUT_MS }, async (t) => {
  const scene = await createScene(t);
  assert.equal(scene.wiredOnLoad, false, "nothing is wired at extension load");

  await scene.session.prompt("Hello.");
  const delivery = scene.delivery;
  assert.ok(delivery, "session_start creates the delivery");
  assert.equal(scene.owner, scene.sessionId, "delivery is owned by the real session id");

  const sentBefore = scene.sent.length;
  const requestsBefore = scene.requests.length;
  await scene.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });

  assert.equal(scene.delivery, undefined, "shutdown clears the wired delivery");
  const late = scene.run("run-late", "TOO-LATE");
  delivery.offer(toOutcome(late), null);
  delivery.reconcile(true);
  await scene.tick();

  assert.equal(late.delivery, "none", "a closed delivery ignores late results");
  assert.equal(scene.sent.length, sentBefore, "no late native send after shutdown");
  assert.equal(scene.requests.length, requestsBefore, "no late provider wake after shutdown");
});

after(() => {
  assert.equal(networkAttempts, 0, "the native delivery tests must never touch the network");
});
