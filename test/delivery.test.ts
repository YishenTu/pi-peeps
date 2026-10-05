import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Report, RunView } from "../src/contracts.ts";
import { ResultDelivery, RESULT_TYPE } from "../src/delivery.ts";

const makeRun = (id = "run"): RunView => ({
  id, label: "test", task: "work", status: "idle", model: { provider: "fake", id: "fake" },
  thinking: "off", createdAt: 0, activity: "Idle", reports: 1, delivery: "none",
  finalText: "  exact\n\nfinal\u2028text  ", transcript: { items: [], version: 0 },
});
const outcome = (run: RunView): Report =>
  ({ runId: run.id, seq: run.reports, status: "answer", text: run.finalText ?? "" });
function setup() {
  const sent: Parameters<ExtensionAPI["sendMessage"]>[] = [];
  const entries: SessionEntry[] = [];
  const runs = new Map<string, RunView>();
  let active = true;
  const delivery = new ResultDelivery({
    owner: "owner", active: () => active, branch: () => entries,
    send: (...args) => { sent.push(args); },
    update: (id, _seq, state) => { const run = runs.get(id); if (run) run.delivery = state; },
  });
  return { delivery, sent, entries, runs, deactivate: () => { active = false; },
    offer: (run = makeRun()) => { runs.set(run.id, run); delivery.offer(outcome(run), null); return run; } };
}
test("normal result uses native custom steer + automatic idle wake, exact body, dedup", () => {
  const h = setup();
  const run = h.offer();
  assert.deepEqual(h.sent[0]?.[1], { deliverAs: "steer", triggerTurn: true });
  const notice = h.sent[0]![0];
  assert.equal(notice.customType, RESULT_TYPE);
  assert.equal(notice.display, true);
  assert.equal(notice.content, "[Peeps automated result — run — answer]\n" + run.finalText);
  assert.equal(run.delivery, "queued"); // void send is not an acknowledgement
  h.delivery.offer(outcome(run), null);
  assert.equal(h.sent.length, 1);
});
test("Stop holds later outcomes; interactive input alone does not wake; accepted human preflight drains nextTurn", () => {
  const h = setup();
  const controller = new AbortController();
  h.delivery.watch(controller.signal);
  controller.abort();
  const run = h.offer();
  assert.equal(run.delivery, "held");
  h.delivery.input("interactive");
  assert.equal(h.sent.length, 0);
  h.delivery.input("extension");
  h.delivery.beforeAgentStart();
  assert.equal(h.sent.length, 0);
  h.delivery.input("interactive");
  h.delivery.beforeAgentStart();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0]?.[1], { deliverAs: "nextTurn", triggerTurn: false });
  h.offer(makeRun("next"));
  assert.deepEqual(h.sent[1]?.[1], { deliverAs: "steer", triggerTurn: true });
});
test("queued notices absent on settle are unconfirmed and never blindly resent", () => {
  const h = setup();
  const run = h.offer();
  h.delivery.reconcile(true);
  assert.equal(run.delivery, "unconfirmed");
  h.delivery.input("interactive");
  h.delivery.beforeAgentStart();
  assert.equal(h.sent.length, 1);
  const notice = h.sent[0]![0];
  h.entries.push({ type: "custom_message", id: "entry", parentId: null,
    timestamp: new Date().toISOString(), ...notice });
  h.delivery.reconcile();
  assert.equal(run.delivery, "appended");
});
test("branch/owner fence suppresses delivery; close prevents late wake", () => {
  const h = setup();
  h.deactivate();
  assert.equal(h.offer().delivery, "suppressed");
  assert.equal(h.sent.length, 0);
  h.delivery.close();
  h.offer(makeRun("late"));
  assert.equal(h.sent.length, 0);
});
test("old abort listeners removed and closed delivery cannot resume", () => {
  const h = setup();
  const old = new AbortController(), current = new AbortController();
  h.delivery.watch(old.signal);
  h.delivery.watch(current.signal);
  old.abort();
  h.offer();
  assert.equal(h.sent.length, 1);
  current.abort();
  h.offer(makeRun("held"));
  h.delivery.close();
  h.delivery.input("interactive");
  h.delivery.beforeAgentStart();
  assert.equal(h.sent.length, 1);
});
test("each report is its own notice, deduplicated and confirmed by sequence", () => {
  const h = setup();
  const run = h.offer();
  const second: Report = { ...outcome(run), seq: 2, text: "second answer" };
  h.delivery.offer(second, null);
  h.delivery.offer(second, null);
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1]![0].content, "[Peeps automated result — run — answer]\nsecond answer");
  assert.equal((h.sent[1]![0].details as { seq?: number }).seq, 2);
  h.entries.push({ type: "custom_message", id: "entry2", parentId: null, timestamp: new Date().toISOString(), ...h.sent[1]![0] });
  const states: [number, string][] = [];
  const tracked = new ResultDelivery({
    owner: "owner", active: () => true, branch: () => h.entries,
    send: () => {}, update: (_id, seq, state) => { states.push([seq, state]); },
  });
  tracked.offer(outcome(run), null);
  tracked.offer(second, null);
  tracked.reconcile(true);
  assert.deepEqual(states, [[1, "queued"], [2, "queued"], [1, "unconfirmed"], [2, "appended"]]);
});
test("no-answer and failure reports are labelled and keep their exact explanation", () => {
  const h = setup();
  const run = makeRun();
  h.delivery.offer({ ...outcome(run), status: "no-answer", text: "The run ended without a final answer (stop reason: length)." }, null);
  h.delivery.offer({ ...outcome(run), seq: 2, status: "failed", text: "Child exited (code 1, signal null)." }, null);
  assert.deepEqual(h.sent.map(([notice]) => notice.content), [
    "[Peeps automated result — run — no-answer]\nThe run ended without a final answer (stop reason: length).",
    "[Peeps automated result — run — failed]\nChild exited (code 1, signal null).",
  ]);
});
