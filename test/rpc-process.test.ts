import assert from "node:assert/strict";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RpcProcess } from "../src/rpc-process.ts";
import type { ChildExit, RpcIncoming, RpcProcessOptions } from "../src/contracts.ts";

const PEER = fileURLToPath(new URL("./fixtures/rpc-peer.mjs", import.meta.url));
const PEER_DIR = dirname(PEER);

function peer(overrides: Partial<RpcProcessOptions> = {}): RpcProcess {
  return new RpcProcess({
    command: overrides.command ?? process.execPath,
    args: overrides.args ?? [PEER],
    cwd: overrides.cwd ?? PEER_DIR,
    env: overrides.env,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 2_000,
    shutdownTimeoutMs: overrides.shutdownTimeoutMs ?? 200,
    maxRecordBytes: overrides.maxRecordBytes,
  });
}

function waitForExit(proc: RpcProcess): Promise<ChildExit> {
  return new Promise((resolve) => {
    proc.onExit(resolve);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await delay(5);
  }
}

const STATE = { isStreaming: false, sessionId: "peer-1", messageCount: 0 };

test("complete newline-terminated records obey the configured byte ceiling", async t => {
  const proc = peer({ maxRecordBytes: 1024 });
  t.after(() => proc.close());
  proc.start();
  await assert.rejects(proc.request({ type: "prompt", message: "oversize-line" }), /record exceeded/);
});

test("shutdown releases inherited pipes even when an unrelated descendant stays alive", async t => {
  const proc = peer({ shutdownTimeoutMs: 30 });
  let pid: number | undefined;
  t.after(async () => {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await proc.close();
  });
  const exit = waitForExit(proc);
  proc.start();
  const response = await proc.request({ type: "prompt", message: "inherited-pipes" }) as { pid: number };
  pid = response.pid;
  await proc.close();
  await exit;
  assert.doesNotThrow(() => process.kill(pid!, 0), "cleanup does not pretend to kill unowned descendants");
});

test("start is idempotent, requests round-trip, unknown events are tolerated", async (t) => {
  const proc = peer();
  t.after(() => proc.close());

  await assert.rejects(proc.request({ type: "get_state" }), /has not been started/);

  const events: RpcIncoming[] = [];
  proc.onEvent((event) => events.push(event));
  proc.start();
  proc.start();

  assert.deepEqual(await proc.request({ type: "get_state" }), STATE);

  assert.deepEqual(await proc.request({ type: "prompt", message: "emit-unknown" }), {
    disposition: "started",
  });
  assert.deepEqual(
    events.map((event) => (event as { type: string }).type),
    ["totally_unknown_event", "session_info_changed"],
  );

  // Unrelated traffic afterwards does not disturb the listener.
  assert.deepEqual(await proc.request({ type: "get_state" }, 1_000), STATE);
  assert.equal(events.length, 2);
});

test("correlates simultaneous and out-of-order responses", async (t) => {
  const proc = peer();
  t.after(() => proc.close());
  proc.start();

  const first = proc.request({ type: "prompt", message: "reorder" });
  const second = proc.request({ type: "get_state" });
  const [reordered, state] = await Promise.all([first, second]);
  assert.deepEqual(reordered, { disposition: "started", reordered: true });
  assert.deepEqual(state, STATE);

  const bulk = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      proc.request({ type: "prompt", message: `bulk-${index}` }),
    ),
  );
  for (const value of bulk) {
    assert.deepEqual(value, { disposition: "started", echoed: "prompt" });
  }
});

test("decodes chunk-split UTF-8 and tolerates CRLF and U+2028/U+2029", async (t) => {
  const proc = peer();
  t.after(() => proc.close());
  proc.start();

  const data = (await proc.request({ type: "prompt", message: "crlf-unicode" })) as {
    text: string;
  };
  assert.equal(data.text, "before-\u2028-middle-\u2029-after-\u00e9\ud83d\ude00-end");

  assert.deepEqual(await proc.request({ type: "get_state" }), STATE);
});

test("rejects when the child answers success=false", async (t) => {
  const proc = peer();
  t.after(() => proc.close());
  proc.start();

  await assert.rejects(proc.request({ type: "abort" }), /abort rejected by peer/);
  assert.deepEqual(await proc.request({ type: "get_state" }), STATE);
});

test("bounds per-request timeouts without imposing a task lifetime timeout", async (t) => {
  const proc = peer({ requestTimeoutMs: 100 });
  t.after(() => proc.close());
  proc.start();

  await assert.rejects(proc.request({ type: "compact" }), /timed out after 100ms/);
  assert.deepEqual(await proc.request({ type: "get_state" }), STATE);

  // A slow but legitimate response is not a failure, and idle time is fine.
  const slow = (await proc.request({ type: "prompt", message: "slow" }, 5_000)) as {
    slow?: boolean;
  };
  assert.equal(slow.slow, true);
  await delay(150);
  assert.deepEqual(await proc.request({ type: "get_state" }), STATE);
});

test("rejects pending work and reports exit when the child dies", async (t) => {
  const proc = peer();
  t.after(() => proc.close());
  const exit = waitForExit(proc);
  proc.start();

  await assert.rejects(proc.request({ type: "prompt", message: "exit-no-write" }), /exited/);
  const record = await exit;
  assert.equal(record.code, 7);
  assert.equal(record.signal, null);

  await assert.rejects(proc.request({ type: "get_state" }), /exited/);
});

test("delivers drained output before the exit notification", async (t) => {
  const proc = peer();
  t.after(() => proc.close());
  const order: string[] = [];
  const finals: unknown[] = [];
  proc.onEvent((event) => {
    if ((event as { type: string }).type === "final_event") {
      order.push("event");
      finals.push(event);
    }
  });
  proc.onExit(() => order.push("exit"));
  proc.start();

  await assert.rejects(proc.request({ type: "prompt", message: "final-event" }), /exited/);
  await waitUntil(() => order.includes("exit"));
  assert.deepEqual(order, ["event", "exit"]);
  assert.deepEqual(finals, [{ type: "final_event", n: 42 }]);

  // A trailing record without a final LF at EOF is still parsed.
  const trailing = peer();
  t.after(() => trailing.close());
  const seen: unknown[] = [];
  trailing.onEvent((event) => seen.push(event));
  trailing.start();
  await assert.rejects(trailing.request({ type: "prompt", message: "final-event-no-newline" }));
  await waitUntil(() => seen.length === 1);
  assert.deepEqual(seen, [{ type: "final_event", n: 43 }]);
});

test("bounds child stderr and never echoes it to the parent", async (t) => {
  const proc = peer();
  t.after(() => proc.close());

  const captured: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = original;
  });

  proc.start();
  assert.deepEqual(await proc.request({ type: "prompt", message: "stderr-flood" }), {
    disposition: "started",
  });
  await delay(50);

  assert.deepEqual(
    captured.filter((line) => line.includes("stderr-flood")),
    [],
  );
  const diagnostics = proc.diagnostics();
  assert.match(diagnostics, /child stderr/);
  assert.ok(diagnostics.length > 1_000, "expected a substantial stderr tail");
  assert.ok(diagnostics.length <= 64 * 1024 + 1_024, `diagnostics too large: ${diagnostics.length}`);
});

test("treats an oversized record as fatal and cleans up", async (t) => {
  const proc = peer({ maxRecordBytes: 4_096 });
  t.after(() => proc.close());
  const exit = waitForExit(proc);
  proc.start();

  await assert.rejects(proc.request({ type: "prompt", message: "oversize" }), /protocol failure/i);
  const record = await exit;
  assert.match(record.error ?? "", /exceeded 4096 bytes/);
  assert.match(proc.diagnostics(), /protocol failure/);
  await assert.rejects(proc.request({ type: "get_state" }), /exited|closing|protocol/i);
});

test("treats malformed JSON output as fatal", async (t) => {
  const proc = peer();
  t.after(() => proc.close());
  proc.start();

  await assert.rejects(proc.request({ type: "prompt", message: "garbage" }), /malformed JSON/);
  assert.match(proc.diagnostics(), /malformed JSON/);
});

test("serializes stdin writes under backpressure and drains large stdout", async (t) => {
  const proc = peer({ env: { PEEPS_PEER_STDIN_DELAY_MS: "300" }, requestTimeoutMs: 10_000 });
  t.after(() => proc.close());
  proc.start();

  // 6 x 200 KiB exceeds the OS pipe buffer while the peer is not reading.
  const large = "z".repeat(200_000);
  const results = await Promise.all(
    Array.from({ length: 6 }, () => proc.request({ type: "prompt", message: large })),
  );
  for (const value of results) {
    assert.deepEqual(value, { disposition: "started", echoed: "prompt" });
  }

  const big = (await proc.request({ type: "prompt", message: "big-response" })) as { blob: string };
  assert.equal(big.blob.length, 4 * 1024 * 1024);
});

test("answers an extension UI dialog through respondToUi", async (t) => {
  const proc = peer();
  t.after(() => proc.close());

  await assert.rejects(
    proc.respondToUi({ type: "extension_ui_response", id: "x", cancelled: true }),
    /has not been started/,
  );

  const uiRequests: unknown[] = [];
  const dialogResponses: unknown[] = [];
  proc.onEvent((event) => {
    const type = (event as { type: string }).type;
    if (type === "extension_ui_request") uiRequests.push(event);
    if (type === "dialog_response") dialogResponses.push(event);
  });
  proc.start();

  const prompt = proc.request({ type: "prompt", message: "dialog" });
  await waitUntil(() => uiRequests.length === 1);
  const request = uiRequests[0] as { id: string; method: string };
  assert.equal(request.method, "confirm");
  await proc.respondToUi({ type: "extension_ui_response", id: request.id, confirmed: true });

  assert.deepEqual(await prompt, { disposition: "started" });
  await waitUntil(() => dialogResponses.length === 1);
  assert.deepEqual(dialogResponses[0], {
    type: "dialog_response",
    id: "dialog-1",
    confirmed: true,
    cancelled: false,
  });
});

test("close is idempotent and shuts down gracefully through stdin", async (t) => {
  const proc = peer({ shutdownTimeoutMs: 500 });
  const exit = waitForExit(proc);
  proc.start();
  assert.deepEqual(await proc.request({ type: "get_state" }), STATE);

  await Promise.all([proc.close(), proc.close()]);
  const record = await exit;
  assert.equal(record.code, 0);
  assert.equal(record.signal, null);

  await assert.rejects(proc.request({ type: "get_state" }), /closing|exited/);
  await proc.close();
});

test("escalates stdin close -> SIGTERM -> SIGKILL without waiting on a hung request", async (t) => {
  const proc = peer({ env: { PEEPS_PEER_MODE: "hang" }, shutdownTimeoutMs: 100 });
  const exit = waitForExit(proc);
  proc.start();
  await delay(100);

  // The hung peer never answers, so this request is still in flight at close.
  const hung = proc.request({ type: "get_state" }, 60_000);
  const rejected = assert.rejects(hung, /closed before responding/);

  const started = Date.now();
  await proc.close();
  await rejected;
  const record = await exit;
  assert.equal(record.signal, "SIGKILL");
  assert.ok(Date.now() - started < 3_000, "shutdown escalation took too long");
  assert.match(proc.diagnostics(), /SIGTERM/);
  assert.match(proc.diagnostics(), /SIGKILL/);
});

test("reports a spawn failure to pending requests and exit listeners", async (t) => {
  const proc = new RpcProcess({
    command: fileURLToPath(new URL("./fixtures/definitely-missing-peer.mjs", import.meta.url)),
    args: [],
    cwd: PEER_DIR,
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 100,
  });
  t.after(() => proc.close());
  const exit = waitForExit(proc);
  proc.start();

  await assert.rejects(proc.request({ type: "get_state" }), /EPIPE|stdin|exited|ENOENT/i);
  const record = await exit;
  assert.match(record.error ?? "", /ENOENT/);
});

test("unsubscribe stops event and exit delivery", async (t) => {
  const proc = peer();
  t.after(() => proc.close());

  const events: unknown[] = [];
  const exits: unknown[] = [];
  const offEvent = proc.onEvent((event) => events.push(event));
  const offExit = proc.onExit((exit) => exits.push(exit));
  offEvent();
  offExit();

  proc.start();
  assert.deepEqual(await proc.request({ type: "get_state" }), STATE);
  await proc.close();
  await delay(50);

  assert.deepEqual(events, []);
  assert.deepEqual(exits, []);
});
