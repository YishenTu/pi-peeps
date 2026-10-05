import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DeliveryStatus, Report } from "../src/contracts.ts";
import { ResultDelivery, RESULT_TYPE, IDLE_QUIET_MS, IDLE_CAP_MS, type ResultDetails, type DeliveryHost } from "../src/delivery.ts";

const report = (runId = "run", seq = 1): Report =>
  ({ runId, seq, status: "answer", text: "  exact\n\nfinal\u2028text  " });
const block = (r: Report) => `[Peeps automated result — ${r.runId} — ${r.status}]\n${r.text}`;
function setup(t: TestContext, timing?: { quietMs?: number; capMs?: number }) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent: Parameters<ExtensionAPI["sendMessage"]>[] = [];
  const entries: SessionEntry[] = [];
  const states = new Map<string, DeliveryStatus>();
  const inactive = new Set<string | null>();
  let idle = true;
  const host: DeliveryHost = {
    owner: "owner", active: anchor => !inactive.has(anchor), isIdle: () => idle, branch: () => entries,
    send: (...args) => { sent.push(args); },
    update: (id, seq, state) => { states.set(`${id}#${seq}`, state); },
  };
  const delivery = new ResultDelivery(host, timing);
  t.after(() => delivery.close());
  return { delivery, host, sent, entries, states, inactive,
    idle: (value: boolean) => { idle = value; },
    advance: (ms = IDLE_QUIET_MS) => t.mock.timers.tick(ms),
    offer: (r = report(), anchor: string | null = null) => { delivery.offer(r, anchor); return r; },
    append: (details: unknown) => entries.push({ type: "custom_message", id: `entry-${entries.length}`, parentId: null,
      timestamp: new Date().toISOString(), customType: RESULT_TYPE, display: true, content: "notice", details }),
  };
}
test("idle singleton keeps exact native notice, steer + triggerTurn, and dedup", t => {
  const h = setup(t);
  const r = h.offer();
  h.offer(r);
  assert.equal(h.sent.length, 0);
  h.advance();
  assert.deepEqual(h.sent[0]?.[1], { deliverAs: "steer", triggerTurn: true });
  const notice = h.sent[0]![0];
  assert.equal(notice.customType, RESULT_TYPE);
  assert.equal(notice.display, true);
  assert.equal(notice.content, block(r));
  assert.deepEqual(notice.details, { owner: "owner", results: [{ runId: "run", seq: 1, status: "answer", sessionFile: undefined }] });
  assert.equal(h.states.get("run#1"), "queued");
  h.offer(r);
  h.advance(IDLE_CAP_MS);
  assert.equal(h.sent.length, 1);
});
test("busy reports flush as one notice at turn_end; later reports form the next batch", t => {
  const h = setup(t);
  h.idle(false);
  const first = h.offer();
  const second = h.offer(report("two"));
  h.advance(IDLE_CAP_MS * 2);
  assert.equal(h.sent.length, 0);
  h.delivery.flush(); // turn_end
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]![0].content, [first, second].map(block).join("\n\n"));
  const third = h.offer(report("three"));
  assert.equal(h.sent.length, 1);
  h.delivery.flush();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1]![0].content, block(third));
});
test("idle quiet window resets for new reports but not duplicate reports", t => {
  const h = setup(t);
  const first = h.offer();
  h.advance(800);
  const second = h.offer(report("two"));
  h.advance(800);
  h.offer(second);
  h.advance(199);
  assert.equal(h.sent.length, 0);
  h.advance(1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]![0].content, [first, second].map(block).join("\n\n"));
});
test("idle cap flushes a continuous stream five seconds after the first report", t => {
  const h = setup(t);
  h.offer();
  for (let i = 1; i <= 6; i++) { h.advance(800); h.offer(report(`run-${i}`)); }
  h.advance(199);
  assert.equal(h.sent.length, 0);
  h.advance(1);
  assert.equal(h.sent.length, 1);
  assert.equal((h.sent[0]![0].details as ResultDetails).results.length, 7);
  h.offer(report("next"));
  h.advance(999);
  assert.equal(h.sent.length, 1);
  h.advance(1);
  assert.equal(h.sent.length, 2, "the next batch gets fresh timers");
});
test("idle timing is injectable", t => {
  const h = setup(t, { quietMs: 10, capMs: 25 });
  h.offer();
  h.advance(9);
  assert.equal(h.sent.length, 0);
  h.advance(1);
  assert.equal(h.sent.length, 1);
});
test("idle timers do not flush into a parent that became busy", t => {
  const h = setup(t);
  h.offer();
  h.idle(false);
  h.advance(IDLE_CAP_MS);
  assert.equal(h.sent.length, 0);
  h.idle(true);
  h.delivery.reconcile(true);
  h.delivery.flush(); // agent_settled fallback, no turn_end
  assert.equal(h.sent.length, 1);
  assert.equal(h.states.get("run#1"), "queued");
});
for (const source of ["interactive", "rpc"] as const) {
  test(`Stop holds buffered and later reports; only accepted ${source} prompt releases one nextTurn`, t => {
    const h = setup(t);
    const controller = new AbortController();
    h.delivery.watch(controller.signal);
    const first = h.offer();
    controller.abort();
    const second = h.offer(report("two"));
    assert.equal(h.states.get("run#1"), "held");
    assert.equal(h.states.get("two#1"), "held");
    h.advance(IDLE_CAP_MS * 2);
    h.delivery.flush();
    h.delivery.reconcile(true);
    h.delivery.input(source);
    assert.equal(h.sent.length, 0, "input alone is insufficient");
    h.delivery.input("extension");
    h.delivery.beforeAgentStart();
    assert.equal(h.sent.length, 0);
    h.delivery.input(source);
    h.delivery.beforeAgentStart();
    assert.equal(h.sent.length, 1);
    assert.deepEqual(h.sent[0]?.[1], { deliverAs: "nextTurn", triggerTurn: false });
    assert.equal(h.sent[0]![0].content, [first, second].map(block).join("\n\n"));
    h.offer(report("next"));
    h.advance();
    assert.deepEqual(h.sent[1]?.[1], { deliverAs: "steer", triggerTurn: true });
  });
}
test("per-item anchors are checked at flush, including held release; all suppressed sends nothing", t => {
  const h = setup(t);
  h.offer(report("one"), "a");
  const second = h.offer(report("two"), "b");
  h.inactive.add("a");
  h.advance();
  assert.equal(h.states.get("one#1"), "suppressed");
  assert.equal(h.states.get("two#1"), "queued");
  assert.equal(h.sent[0]![0].content, block(second));
  const controller = new AbortController();
  controller.abort();
  h.delivery.watch(controller.signal);
  h.offer(report("three"), "b");
  h.inactive.add("b");
  h.delivery.input("rpc");
  h.delivery.beforeAgentStart();
  assert.equal(h.states.get("three#1"), "suppressed");
  assert.equal(h.sent.length, 1);
});
test("close cancels timers, drops the buffer, and prevents late wake or held release", t => {
  const h = setup(t);
  h.offer();
  h.delivery.close();
  h.advance(IDLE_CAP_MS * 2);
  h.offer(report("late"));
  h.delivery.input("interactive");
  h.delivery.beforeAgentStart();
  h.delivery.flush();
  assert.equal(h.sent.length, 0);
  assert.equal(h.states.size, 0);
});
test("old abort listeners are removed", t => {
  const h = setup(t);
  const old = new AbortController(), current = new AbortController();
  h.delivery.watch(old.signal);
  h.delivery.watch(current.signal);
  old.abort();
  h.offer();
  h.advance();
  assert.equal(h.sent.length, 1);
  current.abort();
  h.offer(report("held"));
  assert.equal(h.states.get("held#1"), "held");
});
test("batch reconcile confirms each report by sequence; unconfirmed reports are never resent", t => {
  const h = setup(t);
  h.offer();
  const second = h.offer(report("run", 2));
  h.offer(second);
  h.advance();
  h.delivery.reconcile(true);
  assert.equal(h.states.get("run#1"), "unconfirmed");
  assert.equal(h.states.get("run#2"), "unconfirmed");
  h.delivery.input("interactive");
  h.delivery.beforeAgentStart();
  h.advance(IDLE_CAP_MS);
  assert.equal(h.sent.length, 1);
  h.append(h.sent[0]![0].details);
  h.delivery.reconcile();
  assert.equal(h.states.get("run#1"), "appended");
  assert.equal(h.states.get("run#2"), "appended");
});
test("reconcile accepts legacy details and ignores other owners and malformed batch items", t => {
  const h = setup(t);
  h.offer();
  h.offer(report("run", 2));
  h.offer(report("run", 3));
  h.advance();
  h.append({ owner: "owner", runId: "run", seq: 1, status: "answer" });
  h.append({ owner: "other", results: [{ runId: "run", seq: 2 }] });
  h.append({ owner: "owner", results: [null, {}, { runId: "run", seq: "2" }, { runId: "run", seq: 3 }] });
  h.delivery.reconcile(true);
  assert.equal(h.states.get("run#1"), "appended");
  assert.equal(h.states.get("run#2"), "unconfirmed");
  assert.equal(h.states.get("run#3"), "appended");
});
test("no-answer and failure reports keep their labels and exact explanation inside a batch", t => {
  const h = setup(t);
  const first = h.offer({ ...report(), status: "no-answer", text: " No answer (length).\n" });
  const second = h.offer({ ...report("run", 2), status: "failed", text: "Child exited (code 1)." });
  h.advance();
  assert.equal(h.sent[0]![0].content, [first, second].map(block).join("\n\n"));
});
test("synchronous send failure marks every item failed and never retries", t => {
  const h = setup(t);
  const send = t.mock.method(h.host, "send", () => { throw new Error("host failed"); });
  h.offer();
  h.offer(report("two"));
  h.advance();
  assert.equal(h.states.get("run#1"), "failed");
  assert.equal(h.states.get("two#1"), "failed");
  h.delivery.flush();
  assert.equal(send.mock.callCount(), 1);
});
