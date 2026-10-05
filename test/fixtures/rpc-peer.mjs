#!/usr/bin/env node
/**
 * Scripted JSONL RPC peer for test/rpc-process.test.ts.
 *
 * It speaks the record shapes from docs/rpc.md, docs/rpc-commands.md,
 * docs/json.md, and docs/rpc-extension-ui.md, but performs no model or
 * provider work: every behavior is selected by the incoming command. It never
 * reads credentials, touches the network, or loads the user's Pi configuration.
 *
 * Behavior keys are the command's message (prompt/steer) or command (bash)
 * field, combined with its type:
 *
 *   prompt  silent                   never responds (request timeout test)
 *   prompt  reorder                  responds only after the next command, so
 *                                    the responses arrive out of request order
 *   prompt  crlf-unicode             CRLF-terminated response with U+2028/U+2029
 *                                    and a UTF-8 character split across writes
 *   prompt  oversize                 one record with no LF past maxRecordBytes
 *   prompt  garbage                  a malformed JSON line
 *   prompt  stderr-flood             ~0.5 MiB of stderr, then a response
 *   prompt  dialog                   extension_ui_request, then response
 *   prompt  exit-no-write            exits without responding
 *   prompt  final-event              trailing event then exit (with LF)
 *   prompt  final-event-no-newline   trailing event then exit (no LF)
 *   prompt  slow                     responds after 200 ms
 *   prompt  big-response             responds with a 4 MiB JSON record
 *   prompt  emit-unknown             unknown/optional events, then a response
 *   abort   (any)                    success:false response
 *   compact (any)                    never responds (request timeout test)
 *
 * Env:
 *   PEEPS_PEER_MODE=hang             never exit, ignore SIGTERM, ignore EOF
 *                                    (kill-escalation test)
 *   PEEPS_PEER_STDIN_DELAY_MS=N      delay reading stdin (write backpressure)
 */
import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";

const mode = process.env.PEEPS_PEER_MODE ?? "normal";
const stdinDelayMs = Number(process.env.PEEPS_PEER_STDIN_DELAY_MS ?? "0") || 0;

// Normal mode must be able to exit on EOF, so the keep-alive is unref'd there.
const keepAlive = setInterval(() => {}, 1000);
if (mode !== "hang") keepAlive.unref();

function rawWrite(value) {
  process.stdout.write(value);
}

function send(record) {
  rawWrite(JSON.stringify(record) + "\n");
}

function respond(command, data) {
  send({ id: command.id, type: "response", command: command.type, success: true, data: data });
}

// Exit only once the record reached the pipe, so a trailing record cannot be
// truncated by process.exit() (Node does not flush piped stdout on exit).
function sendThenExit(record, code) {
  process.stdout.write(JSON.stringify(record) + "\n", () => process.exit(code));
}

let reordered = null;
let dialogPrompt = null;

function sendCrlfUnicode(command) {
  const text = "before-\u2028-middle-\u2029-after-\u00e9\ud83d\ude00-end";
  const payload =
    JSON.stringify({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { disposition: "started", text: text },
    }) + "\r\n";
  const bytes = Buffer.from(payload, "utf8");
  const emojiIndex = bytes.indexOf(Buffer.from("\ud83d\ude00", "utf8"));
  const split = emojiIndex + 2; // split inside the 4-byte emoji on purpose
  rawWrite(bytes.subarray(0, split));
  setTimeout(() => rawWrite(bytes.subarray(split)), 5);
}

function processCommand(command, behavior) {
  if (command.type === "prompt" && behavior === "silent") return;
  if (command.type === "prompt" && behavior === "oversize") {
    rawWrite('{"type":"session_event","pad":"' + "x".repeat(65536)); // no LF on purpose
    return;
  }
  if (command.type === "prompt" && behavior === "oversize-line") {
    send({ type: "large_event", pad: "x".repeat(2048) });
    return;
  }
  if (command.type === "prompt" && behavior === "inherited-pipes") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: ["ignore", 1, 2] });
    child.unref();
    respond(command, { pid: child.pid });
    return;
  }
  if (command.type === "prompt" && behavior === "garbage") {
    rawWrite("{not json\n");
    return;
  }
  if (command.type === "prompt" && behavior === "crlf-unicode") {
    sendCrlfUnicode(command);
    return;
  }
  if (command.type === "prompt" && behavior === "stderr-flood") {
    const chunk = "stderr-flood-" + "y".repeat(1023);
    for (let i = 0; i < 512; i += 1) process.stderr.write(chunk + "\n");
    respond(command, { disposition: "started" });
    return;
  }
  if (command.type === "prompt" && behavior === "dialog") {
    dialogPrompt = command;
    send({
      type: "extension_ui_request",
      id: "dialog-1",
      method: "confirm",
      title: "Proceed?",
      message: "Peer dialog",
    });
    return;
  }
  if (command.type === "prompt" && behavior === "exit-no-write") {
    process.exit(7);
    return;
  }
  if (command.type === "prompt" && behavior === "final-event") {
    sendThenExit({ type: "final_event", n: 42 }, 0);
    return;
  }
  if (command.type === "prompt" && behavior === "final-event-no-newline") {
    process.stdout.write(JSON.stringify({ type: "final_event", n: 43 }), () => process.exit(0));
    return;
  }
  if (command.type === "prompt" && behavior === "slow") {
    setTimeout(() => respond(command, { disposition: "started", slow: true }), 200);
    return;
  }
  if (command.type === "prompt" && behavior === "big-response") {
    respond(command, { disposition: "started", blob: "b".repeat(4 * 1024 * 1024) });
    return;
  }
  if (command.type === "prompt" && behavior === "emit-unknown") {
    send({ type: "totally_unknown_event", value: 1 });
    send({ type: "session_info_changed", name: "peer" });
    respond(command, { disposition: "started" });
    return;
  }
  if (command.type === "compact") return; // never responds
  if (command.type === "abort") {
    send({
      id: command.id,
      type: "response",
      command: "abort",
      success: false,
      error: "abort rejected by peer",
    });
    return;
  }
  if (command.type === "get_state") {
    respond(command, { isStreaming: false, sessionId: "peer-1", messageCount: 0 });
    return;
  }
  respond(command, { disposition: "started", echoed: command.type });
}

function handleCommand(command) {
  const behavior =
    typeof command.message === "string"
      ? command.message
      : typeof command.command === "string"
        ? command.command
        : "";

  if (command.type === "prompt" && behavior === "reorder") {
    reordered = command;
    return;
  }

  const delayed = reordered;
  reordered = null;
  processCommand(command, behavior);
  // Answer the delayed request only now, so its response arrives after the
  // response to a request that was sent later.
  if (delayed !== null) respond(delayed, { disposition: "started", reordered: true });
}

function onUiResponse(record) {
  if (record.id !== "dialog-1" || dialogPrompt === null) return;
  const prompt = dialogPrompt;
  dialogPrompt = null;
  send({
    type: "dialog_response",
    id: record.id,
    confirmed: record.confirmed === true,
    cancelled: record.cancelled === true,
    value: record.value,
  });
  respond(prompt, { disposition: "started" });
}

const decoder = new StringDecoder("utf8");
let buffer = "";

function dispatch(line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  if (record === null || typeof record !== "object") return;
  if (record.type === "extension_ui_response") {
    onUiResponse(record);
    return;
  }
  if (typeof record.type === "string") handleCommand(record);
}

function onStdin(chunk) {
  buffer += decoder.write(chunk);
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    let line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim().length === 0) continue;
    dispatch(line);
  }
}

function attachReader() {
  process.stdin.on("data", onStdin);
  process.stdin.on("end", () => {
    if (mode === "hang") return;
    // Mimic Pi's orderly shutdown: stdin close disposes the runtime and the
    // process finishes shortly afterwards.
    setTimeout(() => process.exit(0), 10);
  });
}

if (mode === "hang") {
  process.on("SIGTERM", () => {
    // Deliberately ignore SIGTERM so the client must escalate to SIGKILL.
  });
}

if (stdinDelayMs > 0) {
  setTimeout(attachReader, stdinDelayMs);
} else {
  attachReader();
}
