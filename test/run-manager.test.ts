import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { mkdtemp, mkdir, writeFile, truncate, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { RpcCommand, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import type { ChildConnection, ChildExit, Report, RpcIncoming } from "../src/contracts.ts";
import { RunManager, type Resume } from "../src/run-manager.ts";
import { readArchive, MAX_ARCHIVE_BYTES, type RunRecord } from "../src/archive.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const model = { provider: "fake", id: "scripted" };
const defaults = { model, thinking: "off" as const };
const answer = (text = " exact\n answer \n", stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
  role: "assistant", content: [{ type: "text", text }], api: "fake", provider: "fake", model: "scripted",
  stopReason, timestamp: Date.now(), usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
class FakeChild implements ChildConnection {
  events = new Set<(event: RpcIncoming) => void>();
  exits = new Set<(exit: ChildExit) => void>();
  commands: RpcCommand[] = [];
  ui: RpcExtensionUIResponse[] = [];
  started = false;
  closed = false;
  pendingMessageCount = 0;
  handler?: (command: RpcCommand) => Promise<unknown>;
  start() { this.started = true; }
  async request(command: RpcCommand): Promise<unknown> {
    this.commands.push(command);
    if (this.handler) return this.handler(command);
    return command.type === "get_state"
      ? { model, thinkingLevel: "off", isStreaming: false, isCompacting: false, pendingMessageCount: this.pendingMessageCount }
      : { disposition: "started" };
  }
  async respondToUi(response: RpcExtensionUIResponse) { this.ui.push(response); }
  onEvent(listener: (event: RpcIncoming) => void) { this.events.add(listener); return () => { this.events.delete(listener); }; }
  onExit(listener: (exit: ChildExit) => void) { this.exits.add(listener); return () => { this.exits.delete(listener); }; }
  async close() { this.closed = true; }
  diagnostics() { return ""; }
  emit(event: RpcIncoming) { for (const fn of this.events) fn(event); }
  /** One whole agent run, as Pi emits it. */
  complete(text?: string, stop?: AssistantMessage["stopReason"]) {
    this.emit({ type: "agent_start" });
    this.emit({ type: "message_end", message: answer(text, stop) });
    this.emit({ type: "agent_settled" });
  }
}
interface SetupOptions {
  make?: () => FakeChild;
  launched?: Promise<void>;
  /** Children report a persisted session, as under a saved parent session. */
  persistent?: boolean;
  idleCloseMs?: number;
  history?: RunRecord[];
  readArchive?: (path: string) => Promise<readonly AgentMessage[]>;
}
function setup(options: SetupOptions = {}) {
  const children: FakeChild[] = [], reports: Report[] = [], records: RunRecord[] = [], warnings: string[] = [];
  const launches: (Resume | undefined)[] = [];
  const archive: AgentMessage[] = [{ role: "user", content: "earlier task", timestamp: 1 }, answer("earlier answer")];
  const manager = new RunManager({
    owner: "owner",
    async createChild(_run, resume) {
      await options.launched;
      launches.push(resume);
      const connection = options.make?.() ?? new FakeChild();
      children.push(connection);
      const session = options.persistent ? { sessionFile: "/fake/child.jsonl", sessionId: "child-session" } : {};
      return { connection, validateState: () => ({ thinking: "off", ...session }) };
    },
    readArchive: options.readArchive ?? (async () => archive), record: record => records.push(record),
    report: report => reports.push(report), warn: message => warnings.push(message),
    idleCloseMs: options.idleCloseMs,
  }, options.history);
  return { manager, children, reports, records, warnings, launches };
}
async function flush() { await tick(); await tick(); }
const prompts = (child: FakeChild) =>
  child.commands.filter(c => c.type === "prompt").map(c => [c.message, c.streamingBehavior]);

test("spawn is immediate and unbounded; each quiet point reports the exact answer once and the child idles", async () => {
  const { manager, children, reports } = setup();
  const first = manager.spawn({ task: "one" }, defaults, "anchor");
  assert.equal(first.status, "starting");
  const second = manager.spawn({ task: "two" }, defaults, "anchor");
  assert.equal(second.status, "starting");
  await flush();
  assert.equal(children.length, 2);
  children[0]!.complete();
  await flush();
  assert.equal(first.status, "idle");
  assert.equal(first.finalText, " exact\n answer \n");
  assert.deepEqual(reports, [{ runId: first.id, seq: 1, status: "answer", text: " exact\n answer \n", sessionFile: undefined }]);
  assert.equal(children[0]!.closed, false, "an idle child keeps its process and context");
  await manager.close();
  assert.equal(first.status, "closed");
  assert.equal(first.error, undefined);
  assert.equal(second.status, "closed");
  assert.match(second.error!, /while it was working/);
  assert.equal(children[0]!.closed, true);
  assert.equal(reports.length, 1, "teardown reports nothing");
});

test("messages are native steering prompts whatever the child is doing; several can feed one answer", async () => {
  const { manager, children, reports } = setup();
  const run = manager.spawn({ task: "initial" }, defaults, null);
  await flush();
  const child = children[0]!;
  child.emit({ type: "agent_start" });
  assert.equal(run.status, "working");
  await manager.send(run.id, "also check X");
  await manager.send(run.id, "and Y");
  child.emit({ type: "message_end", message: answer("covered X and Y") });
  child.emit({ type: "agent_settled" });
  await flush();
  assert.deepEqual(reports.map(r => [r.seq, r.status, r.text]), [[1, "answer", "covered X and Y"]]);

  await manager.send(run.id, "now Z"); // Idle: the same call starts new work.
  child.complete("did Z");
  await flush();
  assert.equal(run.status, "idle");
  assert.equal(run.finalText, "did Z");
  assert.deepEqual(reports.map(r => [r.seq, r.text]), [[1, "covered X and Y"], [2, "did Z"]]);
  assert.deepEqual(prompts(child), [["initial", "steer"], ["also check X", "steer"], ["and Y", "steer"], ["now Z", "steer"]]);
  assert.ok(!child.commands.some(c => c.type === "steer"), "raw steer can strand input");
  await manager.close();
});

test("a message sent while the child starts is admitted after the task", async () => {
  const child = new FakeChild();
  let launch!: () => void;
  const { manager } = setup({ make: () => child, launched: new Promise<void>(resolve => { launch = resolve; }) });
  const run = manager.spawn({ task: "task" }, defaults, null);
  const sending = manager.send(run.id, "early message");
  launch();
  await sending;
  assert.deepEqual(prompts(child), [["task", "steer"], ["early message", "steer"]]);
  await assert.rejects(manager.send(run.id, "  "), /empty/);
  await manager.close();
  await assert.rejects(manager.send(run.id, "late"), /owner is closed/);
});

test("agent_end isn't final; a retry's settled answer is reported", async () => {
  const { manager, children, reports } = setup();
  const run = manager.spawn({ task: "retry" }, defaults, null);
  await flush();
  children[0]!.emit({ type: "agent_start" });
  children[0]!.emit({ type: "message_end", message: answer("partial", "error") });
  children[0]!.emit({ type: "agent_end", messages: [answer("partial", "error")], willRetry: true });
  await flush();
  assert.equal(reports.length, 0);
  children[0]!.emit({ type: "agent_start" });
  children[0]!.complete("recovered");
  await flush();
  assert.equal(run.status, "idle");
  assert.deepEqual(reports.map(r => [r.status, r.text]), [["answer", "recovered"]]);
  await manager.close();
});

for (const reason of ["length", "error", "aborted", "toolUse", "deferred"] as const) {
  test(`stop reason ${reason} reports no answer and leaves the child usable`, async () => {
    const { manager, children, reports } = setup();
    const run = manager.spawn({ task: "work" }, defaults, null);
    await flush();
    children[0]!.complete("partial", reason);
    await flush();
    assert.equal(run.status, "idle");
    assert.equal(run.finalText, undefined);
    assert.deepEqual(reports.map(r => r.status), ["no-answer"]);
    assert.match(reports[0]!.text, new RegExp(reason));
    assert.deepEqual(manager.answer(run.id), { text: "", kind: "unavailable" });
    await manager.close();
  });
}

test("blocking dialogs are cancelled and fail the child, never auto-approved", async () => {
  const { manager, children, reports } = setup();
  const run = manager.spawn({ task: "permissions" }, defaults, null);
  await flush();
  children[0]!.emit({ type: "extension_ui_request", id: "dialog", method: "confirm", title: "Trust?", message: "Yes?" });
  await flush();
  assert.equal(run.status, "failed");
  assert.match(run.error!, /interaction_required/);
  assert.deepEqual(children[0]!.ui, [{ type: "extension_ui_response", id: "dialog", cancelled: true }]);
  assert.deepEqual(reports.map(r => r.status), ["failed"]);
  await manager.close();
});

test("close is idempotent, aborts only working children, and reports nothing; shutdown fences reports", async () => {
  const { manager, children, reports } = setup();
  const working = manager.spawn({ task: "active" }, defaults, null);
  const idle = manager.spawn({ task: "other" }, defaults, null);
  await flush();
  children[0]!.emit({ type: "agent_start" });
  children[1]!.complete("done");
  await flush();
  await manager.closeChild(idle.id);
  await manager.closeChild(idle.id);
  assert.equal(idle.status, "closed");
  assert.equal(idle.error, undefined);
  assert.equal(children[1]!.closed, true);
  assert.ok(!children[1]!.commands.some(c => c.type === "abort"), "an idle child has nothing to abort");
  await manager.closeChild(working.id);
  assert.match(working.error!, /while working/);
  assert.ok(children[0]!.commands.some(c => c.type === "abort"));
  assert.equal(reports.length, 1, "closing reports nothing");

  const fresh = setup();
  const run = fresh.manager.spawn({ task: "late" }, defaults, null);
  await flush();
  fresh.children[0]!.emit({ type: "agent_start" });
  const closing = fresh.manager.close();
  assert.equal(fresh.manager.closed, true);
  fresh.children[0]!.complete("late");
  await closing;
  assert.equal(run.status, "closed");
  assert.equal(fresh.reports.length, 0);
  assert.throws(() => fresh.manager.spawn({ task: "new" }, defaults, null), /closed/);
  await manager.close();
});

test("a child exit fails and is reported, including from idle; stranded input fails", async () => {
  const first = setup();
  const run = first.manager.spawn({ task: "crash" }, defaults, null);
  await flush();
  first.children[0]!.complete("answer");
  await flush();
  for (const fn of first.children[0]!.exits) fn({ code: 0, signal: null });
  await flush();
  assert.equal(run.status, "failed");
  assert.match(run.error!, /Child exited/);
  assert.deepEqual(first.reports.map(r => [r.seq, r.status]), [[1, "answer"], [2, "failed"]]);
  await assert.rejects(first.manager.send(run.id, "more"), /cannot resume: its parent session is ephemeral/);
  await first.manager.close();

  const second = setup();
  const other = second.manager.spawn({ task: "queue" }, defaults, null);
  await flush();
  second.children[0]!.pendingMessageCount = 1;
  second.children[0]!.complete();
  await flush();
  assert.match(other.error!, /undelivered input/);
  await second.manager.close();
});

test("failure reports carry a bounded diagnostics tail after cleanup", async () => {
  const child = new FakeChild();
  child.diagnostics = () => "x".repeat(8000) + "Useful startup failure";
  const h = setup({ make: () => child });
  const run = h.manager.spawn({ task: "crash" }, defaults, null);
  await flush();
  for (const exit of child.exits) exit({ code: 1, signal: null });
  await flush();
  assert.match(run.error!, /Useful startup failure/);
  assert.ok(run.error!.length < 4300);
  assert.equal(h.reports[0]!.text, run.error);
  await h.manager.close();
});

test("restored history closes live children, keeps delivery honest, and never replays", async () => {
  const history = (["idle", "working"] as const).map((status, i) => ({
    version: 1 as const, owner: "owner", anchor: null,
    run: { id: String(i), label: "old", task: "old", status, model, thinking: "off" as const, createdAt: 0,
      activity: status, reports: 1, delivery: (i ? "held" : "queued") as "queued" | "held" },
  }));
  const restored = new RunManager({
    owner: "owner", createChild: async () => { throw new Error("must not run"); },
    readArchive: async () => [], record: () => {}, report: () => { throw new Error("must not replay"); }, warn: () => {},
  }, history);
  assert.deepEqual(restored.list().map(r => [r.status, r.error, r.delivery]),
    [["closed", undefined, "unconfirmed"], ["closed", "Parent session ended while it was working.", "suppressed"]]);
  await assert.rejects(restored.send("0", "resume?"), /cannot resume/);
  await restored.close();
});

test("persistent closed transcripts are evicted and reloaded only while needed", async () => {
  const child = new FakeChild();
  let reads = 0;
  let gate: Promise<readonly AssistantMessage[]> | undefined;
  const manager = new RunManager({
    owner: "owner",
    createChild: async () => ({ connection: child, validateState: () => ({ thinking: "off", sessionFile: "/fake/archive.jsonl" }) }),
    readArchive: async () => { reads++; return gate ?? [answer("archived final")]; },
    record: () => {}, report: () => {}, warn: () => {},
  });
  const run = manager.spawn({ task: "work" }, defaults, null);
  const liveReader = manager.retainTranscript(run.id);
  await flush();
  child.complete("exact final");
  await flush();
  liveReader();
  assert.ok(run.transcript.items.length > 0, "an idle child's live history stays resident");
  const viewer = manager.retainTranscript(run.id);
  await manager.closeChild(run.id);
  assert.ok(run.transcript.items.length > 0, "open viewer keeps its terminal transcript");
  viewer();
  assert.equal(run.transcript.items.length, 0, "closing viewer releases projected history, not the result");
  assert.equal(run.finalText, "exact final");
  const reader1 = manager.retainTranscript(run.id);
  const reader2 = manager.retainTranscript(run.id);
  await manager.loadTranscript(run.id);
  assert.equal(reads, 1);
  assert.ok(run.transcript.items.length > 0);
  reader1();
  assert.ok(run.transcript.items.length > 0, "a second inspector still owns its read lease");
  reader2();
  reader2();
  assert.equal(run.transcript.items.length, 0);
  let resolve!: (messages: readonly AssistantMessage[]) => void;
  gate = new Promise(res => { resolve = res; });
  const closingReader = manager.retainTranscript(run.id);
  const pending = manager.loadTranscript(run.id);
  closingReader();
  resolve([answer("late read")]);
  await pending;
  assert.equal(run.transcript.items.length, 0, "an archive read finishing after viewer close cannot repopulate memory");
  await manager.close();
});

test("a consumed task reports no answer; a consumed message changes nothing", async () => {
  const child = new FakeChild();
  child.handler = async cmd => cmd.type === "prompt" ? { disposition: "handled" } : {};
  const { manager, reports } = setup({ make: () => child });
  const run = manager.spawn({ task: "/command" }, defaults, null);
  await flush();
  assert.equal(run.status, "idle");
  assert.deepEqual(reports.map(r => r.status), ["no-answer"]);
  assert.match(reports[0]!.text, /consumed/);
  assert.deepEqual(await manager.send(run.id, "/another"), { disposition: "handled" });
  await flush();
  assert.equal(run.status, "idle");
  assert.equal(reports.length, 1);
  await manager.close();
});

test("a report never reuses an earlier answer; inspection only shows current work", async () => {
  const { manager, children, reports } = setup();
  const run = manager.spawn({ task: "task" }, defaults, null);
  await flush();
  const child = children[0]!;
  child.complete("first answer");
  await flush();
  assert.deepEqual(manager.answer(run.id), { text: "first answer", kind: "final" });
  await manager.send(run.id, "second");
  child.emit({ type: "agent_start" });
  assert.equal(run.finalText, undefined, "the previous answer does not answer this work");
  assert.deepEqual(manager.answer(run.id), { text: "", kind: "unavailable" });
  child.emit({ type: "message_end", message: answer("working on it", "toolUse") });
  assert.deepEqual(manager.answer(run.id), { text: "working on it", kind: "partial" });
  child.emit({ type: "agent_settled" });
  await flush();
  assert.deepEqual(reports.map(r => r.status), ["answer", "no-answer"]);

  await manager.send(run.id, "third");
  child.emit({ type: "agent_start" });
  child.emit({ type: "agent_settled" }); // Settled without any new assistant message.
  await flush();
  assert.deepEqual(reports.map(r => [r.seq, r.status]), [[1, "answer"], [2, "no-answer"], [3, "no-answer"]]);
  assert.ok(!reports.slice(1).some(r => r.text.includes("first answer") || r.text === "working on it"));
  await manager.close();
});

test("delivery updates for an earlier report cannot overwrite the latest one", async () => {
  const { manager, children } = setup();
  const run = manager.spawn({ task: "task" }, defaults, null);
  await flush();
  children[0]!.complete("one");
  await flush();
  manager.setDelivery(run.id, 1, "queued");
  await manager.send(run.id, "two");
  children[0]!.complete("two");
  await flush();
  manager.setDelivery(run.id, 1, "appended");
  assert.equal(run.delivery, "none");
  manager.setDelivery(run.id, 2, "held");
  assert.equal(run.delivery, "held");
  await manager.close();
});

test("interrupt stops current work, keeps the child, returns discarded messages, and reports nothing", async () => {
  const { manager, children, reports } = setup();
  const run = manager.spawn({ task: "task" }, defaults, null);
  await flush();
  const child = children[0]!;
  assert.deepEqual(await manager.interrupt(run.id), { interrupted: false, discarded: [] }, "nothing to stop before work starts");
  child.emit({ type: "agent_start" });
  child.handler = async command => command.type === "clear_queue" ? { steering: ["queued note"], followUp: [] }
    : command.type === "get_state" ? { isStreaming: false, isCompacting: false, pendingMessageCount: 0 } : {};
  assert.deepEqual(await manager.interrupt(run.id), { interrupted: true, discarded: ["queued note"] });
  assert.deepEqual(child.commands.slice(-2).map(c => c.type), ["clear_queue", "abort"]);
  child.emit({ type: "message_end", message: answer("half done", "aborted") });
  child.emit({ type: "agent_settled" });
  await flush();
  assert.equal(run.status, "idle");
  assert.equal(run.activity, "Idle · interrupted");
  assert.equal(run.error, undefined);
  assert.equal(reports.length, 0, "the parent asked for this stop");
  assert.equal(child.closed, false);

  child.handler = undefined;
  await manager.send(run.id, "carry on");
  child.complete("finished");
  await flush();
  assert.deepEqual(reports.map(r => [r.status, r.text]), [["answer", "finished"]]);
  assert.deepEqual(await manager.interrupt(run.id), { interrupted: false, discarded: [] }, "an idle child has nothing to stop");
  await manager.close();
});

test("interrupt racing a finished answer keeps that answer's report", async () => {
  const { manager, children, reports } = setup();
  const run = manager.spawn({ task: "task" }, defaults, null);
  await flush();
  const child = children[0]!;
  child.emit({ type: "agent_start" });
  child.handler = async command => {
    if (command.type === "abort") { child.emit({ type: "message_end", message: answer("done anyway") }); child.emit({ type: "agent_settled" }); }
    return command.type === "get_state" ? { isStreaming: false, isCompacting: false, pendingMessageCount: 0 } : {};
  };
  await manager.interrupt(run.id);
  await flush();
  assert.deepEqual(reports.map(r => [r.status, r.text]), [["answer", "done anyway"]]);
  await manager.close();
});

test("messaging a closed child resumes its own session after the old process is gone", async () => {
  const { manager, children, reports, launches } = setup({ persistent: true });
  const run = manager.spawn({ task: "task" }, defaults, null);
  await flush();
  children[0]!.complete("first answer");
  await flush();
  await manager.closeChild(run.id);
  assert.equal(run.activity, "Closed · resumes on message");
  assert.equal(children[0]!.closed, true);

  const [a, b] = [manager.send(run.id, "next step"), manager.send(run.id, "and then")];
  await Promise.all([a, b]);
  assert.equal(children.length, 2, "concurrent messages resume one process");
  assert.deepEqual(launches, [undefined, { sessionFile: "/fake/child.jsonl", sessionId: "child-session" }]);
  const revived = children[1]!;
  assert.deepEqual(prompts(revived), [["next step", "steer"], ["and then", "steer"]], "the task is not re-sent");
  assert.ok(run.transcript.items.some(i => i.kind === "message" && i.message.role === "user" && i.message.content === "earlier task"),
    "history is restored from the archive");
  revived.complete("second answer");
  await flush();
  assert.equal(run.status, "idle");
  assert.deepEqual(reports.map(r => [r.seq, r.text]), [[1, "first answer"], [2, "second answer"]]);
  await manager.close();
});

test("resume is refused for ephemeral children and other parent sessions; a failed resume is reported", async () => {
  const ephemeral = setup();
  const run = ephemeral.manager.spawn({ task: "task" }, defaults, null);
  await flush();
  await ephemeral.manager.closeChild(run.id);
  await assert.rejects(ephemeral.manager.send(run.id, "more"), /ephemeral/);
  await ephemeral.manager.close();

  const record = (owner: string): RunRecord => ({ version: 1, owner, anchor: null, run: {
    id: "11111111-1111-4111-8111-111111111111", label: "old", task: "old", status: "idle", model, thinking: "off",
    createdAt: 0, activity: "Idle", reports: 1, delivery: "appended", sessionFile: "/fake/child.jsonl", sessionId: "child-session" } });
  const forked = setup({ persistent: true, history: [record("another-session")] });
  await assert.rejects(forked.manager.send("11111111-1111-4111-8111-111111111111", "more"), /another parent session/);
  assert.equal(forked.children.length, 0);
  await forked.manager.close();

  const mismatch = new FakeChild();
  const own = setup({ persistent: true, history: [record("owner")], make: () => mismatch });
  mismatch.handler = async c => { if (c.type === "get_state") throw new Error("resumed child did not reopen its recorded session"); return {}; };
  await assert.rejects(own.manager.send("11111111-1111-4111-8111-111111111111", "more"), /Could not resume/);
  await flush(); // The report follows cleanup.
  assert.deepEqual(own.reports.map(r => r.status), ["failed"]);
  await own.manager.close();
});

test("idle resumable children close on their own and wake on the next message", async () => {
  const { manager, children, reports } = setup({ persistent: true, idleCloseMs: 20 });
  const run = manager.spawn({ task: "task" }, defaults, null);
  await flush();
  children[0]!.complete("answer");
  await flush();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(run.status, "closed");
  assert.equal(children[0]!.closed, true);
  assert.equal(reports.length, 1, "closing for idleness is not news");
  await manager.send(run.id, "wake up");
  assert.equal(children.length, 2);
  children[1]!.emit({ type: "agent_start" });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(run.status, "working", "a working child never idles out");
  await manager.close();

  const ephemeral = setup({ idleCloseMs: 20 });
  const kept = ephemeral.manager.spawn({ task: "task" }, defaults, null);
  await flush();
  ephemeral.children[0]!.complete("answer");
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(kept.status, "idle", "without an archive, closing would lose its context");
  await ephemeral.manager.close();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("an archive read started before resume cannot replace live events or report an old answer", async t => {
  const read = deferred<AgentMessage[]>();
  let reads = 0;
  const h = setup({ persistent: true, readArchive: async () => ++reads === 1 ? read.promise : [answer("OLD ANSWER")] });
  t.after(() => h.manager.close());
  const run = h.manager.spawn({ task: "task" }, defaults, null);
  await flush();
  h.children[0]!.complete("OLD ANSWER");
  await flush();
  await h.manager.closeChild(run.id);
  const release = h.manager.retainTranscript(run.id);
  t.after(release);
  const loading = h.manager.loadTranscript(run.id);
  await flush();
  await h.manager.send(run.id, "new task");
  h.children[1]!.emit({ type: "agent_start" });
  h.children[1]!.emit({ type: "message_end", message: answer("NEW ANSWER") });
  read.resolve([answer("OLD ANSWER")]); // A different parsed object with the same old answer.
  await loading;
  h.children[1]!.emit({ type: "agent_settled" });
  await flush();
  assert.deepEqual(h.reports.map(r => r.text), ["OLD ANSWER", "NEW ANSWER"]);
  assert.ok(run.transcript.items.some(i => i.kind === "message" && i.message.role === "assistant" &&
    i.message.content.some(b => b.type === "text" && b.text === "NEW ANSWER")));
});

for (const waitAt of ["release", "archive"] as const) {
  for (const closeAll of [false, true]) {
    test(`close ${closeAll ? "all" : "one"} cancels concurrent sends awaiting resume ${waitAt}`, async t => {
      const gate = deferred<void>();
      let reads = 0;
      const h = setup({ persistent: true, readArchive: async () => {
        reads++;
        if (waitAt === "archive" && reads === 1) await gate.promise;
        return [answer("old")];
      } });
      t.after(() => h.manager.close());
      const run = h.manager.spawn({ task: "task" }, defaults, null);
      await flush();
      h.children[0]!.complete("old");
      await flush();
      if (waitAt === "release") h.children[0]!.close = async () => { await gate.promise; h.children[0]!.closed = true; };
      const initialClose = h.manager.closeChild(run.id);
      await flush();
      const sends = [h.manager.send(run.id, "cancel me"), h.manager.send(run.id, "cancel me too")];
      // Observe rejection before releasing any gates.
      const rejected = sends.map(send => assert.rejects(send, /closed|cancel/i));
      await flush();
      const closing = h.manager.closeChild(closeAll ? "all" : run.id);
      gate.resolve();
      await Promise.all([initialClose, closing, ...rejected]);
      assert.equal(h.children.length, 1, "cancelled resume must not launch");
      assert.equal(run.status, "closed");
      assert.equal(h.reports.length, 1, "cancelling was the parent's request");
      if (waitAt === "release") assert.equal(reads, 0, "check cancellation before archive I/O");
      await h.manager.send(run.id, "later message");
      assert.deepEqual(prompts(h.children[1]!), [["later message", "steer"]]);
    });
  }
}

test("a later message can resume before a cancelled archive read completes", { timeout: 2000 }, async t => {
  const gate = deferred<AgentMessage[]>();
  let reads = 0;
  const h = setup({ persistent: true, readArchive: async () => ++reads === 1 ? gate.promise : [answer("old")] });
  t.after(() => h.manager.close());
  const run = h.manager.spawn({ task: "task" }, defaults, null);
  await flush();
  h.children[0]!.complete("old");
  await flush();
  await h.manager.closeChild(run.id);
  const cancelled = assert.rejects(h.manager.send(run.id, "cancel me"), /closed|cancel/i);
  await flush();
  await h.manager.closeChild(run.id);
  await h.manager.send(run.id, "later message");
  gate.resolve([answer("old")]);
  await cancelled;
  assert.equal(h.children.length, 2);
  assert.deepEqual(prompts(h.children[1]!), [["later message", "steer"]]);
});

test("oversized archives permit resume with new events only; other archive failures still reject", async t => {
  const root = await mkdtemp(join(tmpdir(), "peeps-manager-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "peeps"));
  const file = join(root, "peeps", "child.jsonl");
  await writeFile(file, "");
  await truncate(file, MAX_ARCHIVE_BYTES + 1);
  let failure: Error | undefined;
  const h = setup({ persistent: true, readArchive: async () => {
    if (failure) throw failure;
    return readArchive(file, root);
  } });
  t.after(() => h.manager.close());
  const run = h.manager.spawn({ task: "task" }, defaults, null);
  await flush();
  h.children[0]!.complete("old answer");
  await flush();
  await h.manager.closeChild(run.id);
  await assert.rejects(h.manager.loadTranscript(run.id), /too large to display/);
  await h.manager.send(run.id, "new task");
  assert.equal(run.transcript.items.length, 0);
  h.children[1]!.emit({ type: "agent_start" });
  h.children[1]!.emit({ type: "agent_settled" });
  await flush();
  assert.equal(h.reports[1]!.status, "no-answer", "old answers must not be reused");
  await h.manager.send(run.id, "answer now");
  h.children[1]!.complete("new answer");
  await flush();
  assert.equal(h.reports[2]!.text, "new answer");
  assert.ok(h.warnings.some(w => /history|archive/i.test(w)));
  await h.manager.closeChild(run.id);
  failure = new Error("archive is unreadable");
  await assert.rejects(h.manager.send(run.id, "more"), failure);
  assert.equal(h.children.length, 2, "other archive errors must prevent launch");
});

test("handled input on an idle child restarts auto-close without reporting", async t => {
  const h = setup({ persistent: true, idleCloseMs: 100 });
  t.after(() => h.manager.close());
  const run = h.manager.spawn({ task: "task" }, defaults, null);
  await flush();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  h.children[0]!.complete("answer");
  await flush();
  t.mock.timers.tick(80);
  h.children[0]!.handler = async () => ({ disposition: "handled" });
  assert.deepEqual(await h.manager.send(run.id, "/command"), { disposition: "handled" });
  t.mock.timers.tick(80);
  assert.equal(run.status, "idle", "restart the full idle period");
  t.mock.timers.tick(20);
  await flush();
  assert.equal(run.status, "closed");
  assert.equal(h.children[0]!.closed, true);
  assert.equal(h.reports.length, 1);
});

test("a cancelled resume finishing launch preparation cannot replace a later child", { timeout: 2000 }, async t => {
  const prepared = deferred<void>();
  const children: FakeChild[] = [];
  const manager = new RunManager({
    owner: "owner", readArchive: async () => [answer("old")], record: () => {}, report: () => {}, warn: () => {},
    createChild: async () => {
      const child = new FakeChild();
      children.push(child);
      if (children.length === 2) await prepared.promise;
      return { connection: child, validateState: () => ({ thinking: "off", sessionFile: "/fake/child.jsonl", sessionId: "child" }) };
    },
  });
  t.after(() => manager.close());
  const run = manager.spawn({ task: "task" }, defaults, null);
  await flush();
  children[0]!.complete("old");
  await flush();
  await manager.closeChild(run.id);
  const cancelled = assert.rejects(manager.send(run.id, "cancel me"), /closed|cancel/i);
  await flush();
  assert.equal(children.length, 2);
  await manager.closeChild(run.id);
  await manager.send(run.id, "later message");
  prepared.resolve();
  await cancelled;
  await flush();
  assert.equal(children[1]!.started, false, "cancelled preparation must never start a second session writer");
  assert.equal(children[1]!.closed, true);
  await manager.send(run.id, "keep going");
  assert.deepEqual(prompts(children[2]!), [["later message", "steer"], ["keep going", "steer"]]);
});
