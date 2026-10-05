import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import peeps from "../src/index.ts";
import { RESULT_TYPE } from "../src/delivery.ts";
import { RunManager } from "../src/run-manager.ts";
import { ViewerComponent, trackViewer, type ViewerOptions } from "../src/ui/viewer.ts";

// No child can start from this SDK-shaped test entrypoint: launch explicitly
// rejects it before spawning. Real subprocess behavior is covered separately.
function harness() {
  const hooks = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, ToolDefinition<any, any>>();
  const commands = new Map<string, { handler: (...args: any[]) => Promise<void> }>();
  const notices: unknown[] = [], sendOptions: unknown[] = [], widgets: unknown[] = [], notifications: string[] = [];
  const session = SessionManager.inMemory("/tmp");
  const ctx = {
    mode: "tui", hasUI: true, cwd: "/tmp", sessionManager: session,
    model: { provider: "fake", id: "scripted" }, thinkingLevel: "off",
    isProjectTrusted: () => false, isIdle: () => true, signal: undefined,
    ui: { setWidget: (...args: unknown[]) => widgets.push(args),
      notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, fn: (...args: any[]) => any) => hooks.set(name, fn),
    registerTool: (tool: ToolDefinition<any, any>) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerShortcut: () => {},
    registerMessageRenderer: () => {},
    appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
    sendMessage: (notice: unknown, options: unknown) => { notices.push(notice); sendOptions.push(options); },
  } as unknown as ExtensionAPI;
  peeps(pi);
  const emit = async (name: string, event: object = {}) => { await hooks.get(name)?.(event, ctx); };
  const call = async (name: string, params: unknown, signal?: AbortSignal) => {
    const tool = tools.get(name)!;
    return tool.execute("test-call", params, signal, undefined, ctx as any);
  };
  return { hooks, tools, commands, notices, sendOptions, widgets, ctx, session, emit, call, notifications };
}
const task = { task: "isolated task" };

test("index tool surface rejects single-shot/aborted spawn before admission", async () => {
  const h = harness();
  await h.emit("session_start");
  assert.deepEqual([...h.tools.keys()], ["peeps_spawn", "peeps_send", "peeps_interrupt", "peeps_inspect", "peeps_close"]);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(h.call("peeps_spawn", task, abort.signal), /abort/i);
  for (const mode of ["print", "json"] as const) {
    h.ctx.mode = mode;
    await assert.rejects(h.call("peeps_spawn", task), /TUI or RPC parent/);
    await assert.rejects(h.call("peeps_close", { id: "all" }), /TUI or RPC parent/);
  }
  const inspected = await h.call("peeps_inspect", {});
  assert.equal((inspected.details as any).total, 0);
  await h.emit("session_shutdown");
});

test("an RPC parent is accepted and gets no TUI presentation", async () => {
  const h = harness();
  h.ctx.mode = "rpc";
  await h.emit("session_start");
  const spawned = await h.call("peeps_spawn", task);
  const id = (spawned.details as any).id;
  assert.equal(typeof id, "string");
  await settle(h, id);
  await h.call("peeps_interrupt", { id });
  await h.call("peeps_close", { id });
  await h.commands.get("peeps")!.handler("close all", h.ctx);
  await h.commands.get("peeps")!.handler("", h.ctx);
  assert.deepEqual(h.notifications, ["Peeps viewer requires the terminal UI."]);
  assert.equal(h.widgets.length, 0, "the overview widget is TUI-only");
  await h.emit("session_shutdown");
});

test("actual index shutdown wiring fences a just-admitted startup outcome", async () => {
  const h = harness();
  await h.emit("session_start");
  const spawning = h.call("peeps_spawn", task);
  // Admission is synchronous. Fence the owner before launch rejection resolves.
  const shuttingDown = h.emit("session_shutdown");
  const result = await spawning;
  assert.equal(typeof (result.details as any).id, "string");
  await shuttingDown;
  await tick();
  assert.equal(h.notices.length, 0, "old owner cannot send into a new runtime");
  assert.ok(h.widgets.length >= 2, "widget mounted and removed");
});

for (const failure of ["widget", "viewer"] as const) {
  for (const event of ["session_shutdown", "session_start", "session_before_tree", "session_tree"]) {
    test(`${event} awaits child cleanup even when ${failure} teardown throws`, async t => {
      const h = harness();
      await h.emit("session_start");
      const uiError = new Error(`${failure} teardown failed`);
      let releaseCleanup!: () => void;
      const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
      t.after(() => releaseCleanup());
      let closingManager: RunManager | undefined;
      const originalClose = RunManager.prototype.close;
      t.mock.method(RunManager.prototype, "close", async function (this: RunManager) {
        closingManager = this;
        await originalClose.call(this); // Exercise real cancellation, not a stubbed close.
        await cleanup;
      });
      if (failure === "widget") {
        const setWidget = h.ctx.ui.setWidget.bind(h.ctx.ui);
        t.mock.method(h.ctx.ui, "setWidget", (...args: Parameters<typeof setWidget>) => {
          if (args[1] === undefined) throw uiError;
          return setWidget(...args);
        });
      } else {
        // A tracked viewer calls the host's done callback. No terminal rendering
        // is needed to exercise the real closeAllViewers -> Viewer.close path.
        const viewer = new ViewerComponent({
          source: { list: () => [], get: () => undefined, subscribe: () => () => {},
            loadTranscript: async () => {} },
          tui: {} as ViewerOptions["tui"], theme: {} as ViewerOptions["theme"],
          keybindings: {} as ViewerOptions["keybindings"], cwd: "/tmp",
          factory: { create: () => { throw new Error("unexpected render"); } },
          done: () => { throw uiError; },
        });
        const untrack = trackViewer(viewer);
        t.after(() => { untrack(); viewer.dispose(); });
      }

      const spawning = h.call("peeps_spawn", task);
      let settled = false;
      const stopping = h.emit(event).then(
        () => { settled = true; return undefined; },
        error => { settled = true; return error; },
      );
      const admitted = await spawning;
      await tick();
      assert.ok(closingManager, "UI failure cannot skip the lifetime owner's close");
      assert.equal(closingManager.closed, true);
      assert.equal(closingManager.get((admitted.details as any).id)?.status, "closed");
      assert.equal(settled, false, "lifecycle handler must await cleanup even on its error path");
      assert.equal(h.notices.length, 0, "old owner cannot report or wake the parent");

      releaseCleanup();
      assert.equal(await stopping, uiError, "preserve the UI error for Pi's event error reporting");
      assert.equal(h.notices.length, 0);
    });
  }
}

test("actual tree lifecycle closes children and restores metadata without resuming/replaying work", async () => {
  const h = harness();
  await h.emit("session_start");
  const spawning = h.call("peeps_spawn", task);
  await h.emit("session_before_tree");
  const admitted = await spawning;
  await h.emit("session_tree");
  await tick();
  const id = (admitted.details as any).id;
  const status = await h.call("peeps_inspect", { id });
  assert.equal((status.details as any).status, "closed");
  assert.match((status.details as any).error, /while it was working/);
  assert.match((status.details as any).transcriptError, /No persistent child transcript/);
  assert.equal(h.notices.length, 0);
  await h.emit("session_shutdown");
});

test("cancelled tree navigation keeps the historical overview mounted without a Peeps call", async () => {
  const h = harness();
  await h.emit("session_start");
  const spawning = h.call("peeps_spawn", task);
  await h.emit("session_before_tree");
  await spawning;
  await tick();
  // No session_tree follows: another extension or the user cancelled navigation.
  const lastWidget = h.widgets.at(-1) as unknown[];
  assert.equal(typeof lastWidget[1], "function");
  assert.equal(h.notices.length, 0);
  await h.emit("session_shutdown");
});

test("tool and command close are idempotent and send no notice", async () => {
  const h = harness();
  await h.emit("session_start");
  const spawning = h.call("peeps_spawn", task);
  // Get the synchronously persisted run ID before startup preflight can fail.
  const records = h.session.getBranch().filter(e => e.type === "custom");
  const id = (records.at(-1) as any).data.run.id;
  const closing = h.call("peeps_close", { id });
  await spawning;
  await closing;
  await h.commands.get("peeps")!.handler("close " + id, h.ctx);
  const status = await h.call("peeps_inspect", { id, limit: 10 });
  assert.equal((status.details as any).status, "closed");
  assert.equal((status.details as any).textKind, "unavailable");
  assert.equal(h.notices.length, 0, "closing was the parent's request, not news");
  await assert.rejects(h.call("peeps_send", { id, message: "late" }), /cannot resume: its parent session is ephemeral/);
  await h.emit("session_shutdown");
});

async function settle(h: ReturnType<typeof harness>, id: string) {
  for (let i = 0; i < 100; i++) {
    const status = await h.call("peeps_inspect", { id });
    if (!["starting", "working"].includes((status.details as any).status)) return status;
    await tick();
  }
  throw new Error("child did not settle");
}

for (const human of ["interactive", "rpc"] as const) test(`actual index Stop wiring holds outcomes until an ${human} prompt reaches before_agent_start`, async () => {
  const h = harness();
  if (human === "rpc") h.ctx.mode = "rpc";
  await h.emit("session_start");
  const turn = new AbortController();
  (h.ctx as any).signal = turn.signal;
  await h.emit("agent_start");
  const spawning = h.call("peeps_spawn", task);
  turn.abort(); // Parent Stop while the child is still starting.
  const id = ((await spawning).details as any).id;
  await h.emit("agent_end");
  (h.ctx as any).signal = undefined;
  const status = await settle(h, id);
  assert.equal((status.details as any).status, "failed", "SDK-shaped launch is rejected; the failure is the outcome");
  assert.equal((status.details as any).delivery, "held");
  assert.equal(h.notices.length, 0, "Stop holds the outcome instead of waking the parent");

  await h.emit("before_agent_start"); // Another extension's turn.
  await h.emit("input", { source: "extension" });
  await h.emit("before_agent_start");
  await h.emit("input", { source: human }); // Input alone does not release.
  assert.equal(h.notices.length, 0, "only a human prompt reaching before_agent_start releases the hold");

  await h.emit("before_agent_start");
  assert.equal(h.notices.length, 1);
  assert.equal((h.notices[0] as any).customType, RESULT_TYPE);
  assert.deepEqual(h.sendOptions[0], { deliverAs: "nextTurn", triggerTurn: false });
  await h.emit("before_agent_start");
  assert.equal(h.notices.length, 1, "released outcomes are sent once");
  await h.emit("session_shutdown");
});

const ARCHIVED_ID = "00000000-0000-4000-8000-000000000001";
test("inspect does not label an unavailable archived answer as final", async t => {
  const agentDir = mkdtempSync(join(tmpdir(), "peeps-index-agent-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  });
  const h = harness();
  const owner = h.session.getSessionId();
  h.session.appendCustomEntry("peeps/run", { version: 1, owner, anchor: null, run: {
    id: ARCHIVED_ID, label: "archived", task: "archived task", status: "closed",
    model: { provider: "fake", id: "scripted" }, thinking: "off", createdAt: 1, finishedAt: 2,
    activity: "Closed", reports: 1, delivery: "appended", sessionFile: join(agentDir, "sessions", "--tmp--", "missing", "run", "child.jsonl"),
  } });
  await h.emit("session_start");
  const status = await h.call("peeps_inspect", { id: ARCHIVED_ID });
  assert.equal((status.details as any).status, "closed");
  assert.equal((status.details as any).text, "");
  assert.equal(typeof (status.details as any).transcriptError, "string");
  assert.equal((status.details as any).textKind, "unavailable");
  await h.emit("session_shutdown");
});

test("actual peeps_send wiring watches the turn signal and admits through the manager", async t => {
  const h = harness();
  await h.emit("session_start");
  const spawned = await h.call("peeps_spawn", task);
  const id = (spawned.details as any).id;
  await settle(h, id);
  // A real failed child is rejected through the shipped tool path.
  await assert.rejects(h.call("peeps_send", { id, message: "more" }), /cannot resume/);

  const calls: unknown[][] = [];
  t.mock.method(RunManager.prototype, "send", async function (this: RunManager, ...args: unknown[]) {
    calls.push(args);
    return { disposition: "started" };
  });
  const turn = new AbortController();
  turn.abort(); // A stopped parent turn: later outcomes must be held.
  (h.ctx as any).signal = turn.signal;
  const result = await h.call("peeps_send", { id, message: "more" });
  (h.ctx as any).signal = undefined;
  assert.deepEqual(calls, [[id, "more"]]);
  assert.deepEqual((result.details as any).admission, { disposition: "started" });
  assert.equal((result.details as any).id, id);
  // The tool bound delivery to the aborted turn: a later outcome is held, not sent.
  const noticesBefore = h.notices.length;
  const later = await h.call("peeps_spawn", task);
  const status = await settle(h, (later.details as any).id);
  assert.equal((status.details as any).delivery, "held");
  assert.equal(h.notices.length, noticesBefore);
  await h.emit("session_shutdown");
});
