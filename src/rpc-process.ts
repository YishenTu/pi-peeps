/**
 * RpcProcess: the process owner for one `pi --mode rpc` child.
 *
 * Scope: this module owns exactly one child process and the JSONL transport to
 * it. It does not decide run policy, session classification, dialog policy, or
 * launch arguments — the run manager owns those. In particular:
 *
 * - Extension UI dialogs are forwarded to event listeners; answering them is
 *   the manager's decision via {@link RpcProcess.respondToUi}.
 * - There is no task lifetime timeout. Requests have a bounded per-request
 *   timeout so a lost response cannot hang a caller, but the child is never
 *   killed for taking a long time.
 * - Shutdown only ever signals this one process. It is not spawned detached and
 *   no process-group kill is attempted: grandchildren (bash/MCP) rely on Pi's
 *   own shutdown path (its SIGTERM handler kills tracked detached children).
 *   No process-tree guarantee is claimed.
 *
 * Transport rules (docs/rpc.md, docs/json.md):
 * - stdout is strict JSONL: split records only on LF, strip one preceding CR.
 *   `node:readline` must not be used because it also splits on U+2028/U+2029.
 * - Stdout is drained continuously; stdin writes are serialized so the Node
 *   write callback enforces backpressure.
 * - Child stderr is kept in a bounded in-memory ring for {@link RpcProcess.diagnostics}
 *   and is never echoed to the parent's stderr.
 * - Malformed or oversized protocol records are fatal: pending requests are
 *   rejected and the child is shut down.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { RpcCommand, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import type { ChildConnection, ChildExit, RpcIncoming, RpcProcessOptions } from "./contracts.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;
/** Default ceiling for a single unterminated stdout record. */
const DEFAULT_MAX_RECORD_BYTES = 64 * 1024 * 1024;
/** Combined budget for the diagnostics log and for the child stderr ring. */
const DIAGNOSTIC_LIMIT_BYTES = 64 * 1024;
const RECORD_PREVIEW_CHARS = 200;
/** Fallback finalize delay if a spawn failure never produces a "close" event. */
const SPAWN_FAILURE_GRACE_MS = 250;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function previewRecord(line: string): string {
  return line.length > RECORD_PREVIEW_CHARS ? `${line.slice(0, RECORD_PREVIEW_CHARS)}…` : line;
}

/**
 * Bounded UTF-8 text accumulator. Drops oldest entries first and truncates a
 * single oversized entry, so memory stays inside the configured budget.
 */
class BoundedLog {
  readonly #limitBytes: number;
  #entries: string[] = [];
  #bytes = 0;

  constructor(limitBytes: number) {
    this.#limitBytes = limitBytes;
  }

  push(text: string): void {
    if (text.length === 0) return;
    const entry = text.endsWith("\n") ? text : `${text}\n`;
    this.#entries.push(entry);
    this.#bytes += Buffer.byteLength(entry);
    while (this.#entries.length > 1 && this.#bytes > this.#limitBytes) {
      const removed = this.#entries.shift();
      if (removed === undefined) break;
      this.#bytes -= Buffer.byteLength(removed);
    }
    if (this.#bytes > this.#limitBytes && this.#entries.length === 1) {
      const only = this.#entries[0] ?? "";
      const keepChars = Math.max(0, this.#limitBytes - 32);
      this.#entries[0] = `[truncated]\n${only.slice(-keepChars)}`;
      this.#bytes = Buffer.byteLength(this.#entries[0]);
    }
  }

  text(): string {
    return this.#entries.join("");
  }
}

interface PendingRequest {
  readonly command: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class RpcProcess implements ChildConnection {
  readonly #command: string;
  readonly #args: string[];
  readonly #cwd: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #requestTimeoutMs: number;
  readonly #shutdownTimeoutMs: number;
  readonly #maxRecordBytes: number;

  #child: ChildProcess | undefined;
  #started = false;
  #closing = false;
  #finalized = false;
  #stdoutEnded = false;
  #stdoutFatal = false;
  #protocolError: string | undefined;
  #spawnError: string | undefined;
  #stdinError: Error | undefined;
  #exitRecord: ChildExit | undefined;
  #closePromise: Promise<void> | undefined;
  #spawnFailureTimer: NodeJS.Timeout | undefined;

  /** Byte-accurate UTF-8 decoding across chunk boundaries. */
  readonly #stdoutDecoder = new StringDecoder("utf8");
  #stdoutBuffer = "";
  #stdoutBytes = 0;

  readonly #stderrDecoder = new StringDecoder("utf8");
  readonly #stderr = new BoundedLog(DIAGNOSTIC_LIMIT_BYTES);
  readonly #diagnostics = new BoundedLog(DIAGNOSTIC_LIMIT_BYTES);

  readonly #pending = new Map<string, PendingRequest>();
  #requestSeq = 0;

  readonly #eventListeners = new Set<(event: RpcIncoming) => void>();
  readonly #exitListeners = new Set<(exit: ChildExit) => void>();
  readonly #exitWaiters: Array<() => void> = [];

  #writeTail: Promise<void> = Promise.resolve();

  constructor(options: RpcProcessOptions) {
    if (typeof options.command !== "string" || options.command.length === 0) {
      throw new TypeError("RpcProcess requires a non-empty command");
    }
    this.#command = options.command;
    this.#args = [...options.args];
    this.#cwd = options.cwd;
    // An explicit environment is complete: do not reintroduce deleted parent
    // session fields or credentials in isolated test/launch profiles.
    this.#env = { ...(options.env ?? process.env) };
    this.#requestTimeoutMs = positiveOr(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.#shutdownTimeoutMs = positiveOr(options.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS);
    this.#maxRecordBytes = positiveOr(options.maxRecordBytes, DEFAULT_MAX_RECORD_BYTES);
  }

  /**
   * Spawn the child and wire stdout/stderr/stdin synchronously, so no output
   * can be missed after this returns. Idempotent; call once per instance.
   *
   * Subscribe with {@link onEvent}/{@link onExit} before calling this: events
   * are not buffered for later subscribers.
   */
  start(): void {
    if (this.#started) return;
    this.#started = true;

    let child: ChildProcess;
    try {
      child = spawn(this.#command, this.#args, {
        cwd: this.#cwd,
        env: this.#env,
        // Deliberately not detached: we own one process, not a group.
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this.#spawnError = errorMessage(error);
      this.#diagnostics.push(`[rpc] failed to spawn ${this.#command}: ${this.#spawnError}`);
      this.#finalize(null, null);
      return;
    }

    this.#child = child;
    this.#diagnostics.push(`[rpc] spawned pid=${child.pid ?? "?"} ${this.#command}`);

    child.stdout?.on("data", (chunk: Buffer) => {
      this.#onStdout(chunk);
    });
    child.stdout?.on("end", () => {
      this.#flushStdout();
    });
    child.stdout?.on("error", (error: Error) => {
      this.#fatal(`stdout stream error: ${errorMessage(error)}`);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.#stderr.push(this.#stderrDecoder.write(chunk));
    });
    child.stderr?.on("error", () => {
      // stderr is diagnostics-only; a broken stderr stream is not fatal.
    });
    child.stdin?.on("error", (error: Error) => {
      this.#onStdinError(error);
    });
    child.on("error", (error: Error) => {
      this.#onChildError(error);
    });
    child.on("close", (code, signal) => {
      this.#finalize(code, signal);
    });
  }

  /**
   * Send one RPC command and resolve with its `response.data`.
   *
   * Rejects immediately when the process is not started, is closing, has
   * exited, or the protocol has failed. Rejects after `timeoutMs` (default:
   * the constructor's `requestTimeoutMs`, 30s) or when the write fails. A
   * response with `success: false` rejects with the child's error text.
   */
  async request(command: RpcCommand, timeoutMs?: number): Promise<unknown> {
    this.#assertUsable();
    const id = this.#reserveRequestId(command.id);
    const line = `${JSON.stringify({ ...command, id })}\n`;
    const timeout = positiveOr(timeoutMs, this.#requestTimeoutMs);

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) {
          reject(new Error(`RPC command ${command.type} timed out after ${timeout}ms`));
        }
      }, timeout);
      this.#pending.set(id, { command: command.type, resolve, reject, timer });
      void this.#write(line).catch((error: unknown) => {
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /**
   * Answer an `extension_ui_request` received through {@link onEvent}.
   * Whether a dialog is cancelled, answered, or forwarded is manager policy;
   * this method only writes the record on the serialized stdout/stdin channel.
   */
  async respondToUi(response: RpcExtensionUIResponse): Promise<void> {
    this.#assertUsable();
    await this.#write(`${JSON.stringify(response)}\n`);
  }

  /** Subscribe to session events and extension UI requests. */
  onEvent(listener: (event: RpcIncoming) => void): () => void {
    this.#eventListeners.add(listener);
    return () => {
      this.#eventListeners.delete(listener);
    };
  }

  /**
   * Subscribe to the terminal exit. The exit is emitted only after stdout has
   * been drained and the stdio streams are closed, so every record the child
   * flushed is delivered first. A late subscriber is notified asynchronously.
   */
  onExit(listener: (exit: ChildExit) => void): () => void {
    const record = this.#exitRecord;
    if (record !== undefined) {
      queueMicrotask(() => {
        listener(record);
      });
      return () => {};
    }
    this.#exitListeners.add(listener);
    return () => {
      this.#exitListeners.delete(listener);
    };
  }

  /**
   * Idempotent bounded shutdown: end stdin (Pi's documented orderly shutdown),
   * then SIGTERM after `shutdownTimeoutMs`, then SIGKILL after another
   * `shutdownTimeoutMs`. Pending requests are cancelled up front so a hung
   * command cannot hold shutdown open.
   */
  close(): Promise<void> {
    this.#closePromise ??= this.#shutdown();
    return this.#closePromise;
  }

  /** Bounded diagnostic text: owner log plus the child stderr tail. */
  diagnostics(): string {
    const sections: string[] = [];
    const log = this.#diagnostics.text().trimEnd();
    if (log.length > 0) sections.push(log);
    const stderr = this.#stderr.text().trimEnd();
    if (stderr.length > 0) {
      sections.push(`--- child stderr (tail; never echoed to the parent) ---\n${stderr}`);
    }
    return sections.join("\n");
  }

  // -- stdout ---------------------------------------------------------------

  #onStdout(chunk: Buffer): void {
    if (this.#stdoutFatal) return;
    const text = this.#stdoutDecoder.write(chunk);
    if (text.length > 0) {
      this.#stdoutBuffer += text;
      this.#stdoutBytes += Buffer.byteLength(text);
    }
    this.#drainStdoutRecords();
    if (!this.#stdoutFatal && this.#stdoutBytes > this.#maxRecordBytes) {
      this.#fatal(`record exceeded ${this.#maxRecordBytes} bytes without a line feed`);
    }
  }

  #drainStdoutRecords(): void {
    while (!this.#stdoutFatal) {
      const index = this.#stdoutBuffer.indexOf("\n");
      if (index < 0) return;
      const rawLine = this.#stdoutBuffer.slice(0, index);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(index + 1);
      this.#stdoutBytes = Math.max(0, this.#stdoutBytes - Buffer.byteLength(rawLine) - 1);
      // Tolerate CRLF; only LF is a record boundary (U+2028/U+2029 are data).
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.trim().length === 0) continue;
      this.#handleRecord(line);
    }
  }

  #flushStdout(): void {
    if (this.#stdoutEnded) return;
    this.#stdoutEnded = true;
    const tail = this.#stdoutDecoder.end();
    if (tail.length > 0) this.#stdoutBuffer += tail;
    this.#drainStdoutRecords();
    // A final record may be missing its trailing LF at EOF; accept it.
    const rest = this.#stdoutBuffer;
    this.#stdoutBuffer = "";
    this.#stdoutBytes = 0;
    if (this.#stdoutFatal || rest.trim().length === 0) return;
    const line = rest.endsWith("\r") ? rest.slice(0, -1) : rest;
    if (line.trim().length > 0) this.#handleRecord(line);
  }

  #handleRecord(line: string): void {
    if (Buffer.byteLength(line) > this.#maxRecordBytes) {
      this.#fatal(`record exceeded ${this.#maxRecordBytes} bytes`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.#fatal(`malformed JSON record (${errorMessage(error)}): ${previewRecord(line)}`);
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.#fatal(`record is not a JSON object: ${previewRecord(line)}`);
      return;
    }
    const record = parsed as Record<string, unknown>;
    if (record.type === "response") {
      this.#handleResponse(record);
      return;
    }
    if (typeof record.type === "string") {
      // Session events and extension UI requests are forwarded unchanged;
      // unknown optional events are tolerated.
      this.#emitEvent(record as unknown as RpcIncoming);
      return;
    }
    this.#fatal(`record without a string type: ${previewRecord(line)}`);
  }

  #handleResponse(record: Record<string, unknown>): void {
    if (typeof record.command !== "string" || typeof record.success !== "boolean") {
      this.#fatal("response record is missing a string command or boolean success");
      return;
    }
    const command = record.command;
    const id = record.id;
    if (typeof id !== "string") {
      // Pi emits an id-less parse response only for malformed *input*, which
      // this owner never sends. Record it and move on rather than failing.
      this.#diagnostics.push(`[rpc] response without an id for ${command}`);
      return;
    }
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      this.#diagnostics.push(`[rpc] ignored response for unknown request ${id} (${command})`);
      return;
    }
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (record.success === true) {
      pending.resolve(record.data);
      return;
    }
    const detail =
      typeof record.error === "string" && record.error.length > 0 ? `: ${record.error}` : "";
    pending.reject(new Error(`RPC command ${command} failed${detail}`));
  }

  #emitEvent(event: RpcIncoming): void {
    for (const listener of [...this.#eventListeners]) {
      try {
        listener(event);
      } catch (error) {
        this.#diagnostics.push(`[rpc] event listener failed: ${errorMessage(error)}`);
      }
    }
  }

  // -- failures -------------------------------------------------------------

  #fatal(reason: string): void {
    if (this.#stdoutFatal) return;
    this.#stdoutFatal = true;
    this.#protocolError = reason;
    this.#diagnostics.push(`[rpc] protocol failure: ${reason}`);
    // Every outstanding response is now unreachable.
    this.#rejectPending(new Error(`RPC protocol failure: ${reason}`));
    // Do not leave a child running behind a broken protocol stream.
    void this.close();
  }

  #onStdinError(error: Error): void {
    if (this.#stdinError !== undefined) return;
    this.#stdinError = error;
    this.#diagnostics.push(`[rpc] stdin error: ${errorMessage(error)}`);
    // A broken stdin cannot carry further commands; fail outstanding work
    // instead of letting it time out.
    this.#rejectPending(error);
  }

  #onChildError(error: Error): void {
    const message = errorMessage(error);
    this.#diagnostics.push(`[rpc] child error: ${message}`);
    if (this.#child?.pid === undefined) {
      this.#spawnError = message;
      // Node normally follows a spawn failure with "close"; keep a bounded
      // fallback so the exit is still reported if it does not.
      this.#spawnFailureTimer = setTimeout(() => {
        this.#finalize(null, null);
      }, SPAWN_FAILURE_GRACE_MS);
    }
  }

  // -- exit -----------------------------------------------------------------

  #finalize(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#finalized) return;
    this.#finalized = true;
    if (this.#spawnFailureTimer !== undefined) {
      clearTimeout(this.#spawnFailureTimer);
      this.#spawnFailureTimer = undefined;
    }
    const stderrTail = this.#stderrDecoder.end();
    if (stderrTail.length > 0) this.#stderr.push(stderrTail);
    // Drain anything flushed immediately before close, so trailing events are
    // delivered before the exit notification.
    this.#flushStdout();

    const detail = this.#protocolError ?? this.#spawnError;
    const record: ChildExit = { code, signal };
    if (detail !== undefined) record.error = detail;
    this.#exitRecord = record;
    this.#rejectPending(this.#unavailableError("RPC process exited before responding"));
    this.#diagnostics.push(`[rpc] exited code=${String(code)} signal=${String(signal)}`);

    const waiters = this.#exitWaiters.splice(0);
    for (const waiter of waiters) waiter();
    for (const listener of [...this.#exitListeners]) {
      try {
        listener(record);
      } catch (error) {
        this.#diagnostics.push(`[rpc] exit listener failed: ${errorMessage(error)}`);
      }
    }
  }

  #waitForExit(ms: number): Promise<boolean> {
    if (this.#finalized || this.#exitRecord !== undefined) return Promise.resolve(true);
    if (this.#child === undefined) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(true);
      };
      timer = setTimeout(() => {
        const index = this.#exitWaiters.indexOf(waiter);
        if (index >= 0) this.#exitWaiters.splice(index, 1);
        resolve(false);
      }, Math.max(1, ms));
      this.#exitWaiters.push(waiter);
    });
  }

  // -- shutdown -------------------------------------------------------------

  async #shutdown(): Promise<void> {
    const first = !this.#closing;
    this.#closing = true;
    if (first) {
      this.#rejectPending(new Error("RPC process closed before responding"));
    }
    const child = this.#child;
    if (child === undefined || this.#finalized) return;

    // 1. Orderly: close stdin. Pi disposes its runtime and exits 0.
    try {
      child.stdin?.end();
    } catch (error) {
      this.#diagnostics.push(`[rpc] failed to close stdin: ${errorMessage(error)}`);
    }
    if (await this.#waitForExit(this.#shutdownTimeoutMs)) return;

    // 2. SIGTERM: Pi kills tracked detached children, then exits 143.
    this.#kill(child, "SIGTERM");
    if (await this.#waitForExit(this.#shutdownTimeoutMs)) return;

    // 3. SIGKILL: last resort. Grandchildren can be orphaned here; see the
    // module header for what is and is not guaranteed.
    this.#kill(child, "SIGKILL");
    if (!await this.#waitForExit(this.#shutdownTimeoutMs)) {
      // A descendant can hold inherited pipes open after the owned PID exits.
      // Stop retaining our pipe handles; this does not claim to kill that descendant.
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  }

  #kill(child: ChildProcess, signal: NodeJS.Signals): void {
    this.#diagnostics.push(`[rpc] sending ${signal} to pid=${child.pid ?? "?"}`);
    try {
      child.kill(signal);
    } catch (error) {
      this.#diagnostics.push(`[rpc] ${signal} failed: ${errorMessage(error)}`);
    }
  }

  // -- helpers --------------------------------------------------------------

  #assertUsable(): void {
    if (!this.#started) throw new Error("RPC process has not been started");
    if (this.#closing) throw new Error("RPC process is closing");
    if (this.#stdoutFatal) {
      throw new Error(`RPC protocol failure: ${this.#protocolError ?? "unknown"}`);
    }
    if (this.#finalized || this.#exitRecord !== undefined) {
      throw this.#unavailableError("RPC process has already exited");
    }
    if (this.#stdinError !== undefined) throw this.#stdinError;
  }

  #unavailableError(fallback: string): Error {
    const record = this.#exitRecord;
    const base =
      record === undefined
        ? fallback
        : `RPC process exited (code=${String(record.code)}, signal=${String(record.signal)})`;
    const detail = this.#protocolError ?? this.#spawnError;
    return new Error(detail === undefined ? base : `${base}: ${detail}`);
  }

  #reserveRequestId(preferred: string | undefined): string {
    if (typeof preferred === "string" && preferred.length > 0 && !this.#pending.has(preferred)) {
      return preferred;
    }
    let id: string;
    do {
      this.#requestSeq += 1;
      id = `peeps-rpc-${this.#requestSeq}`;
    } while (this.#pending.has(id));
    return id;
  }

  #rejectPending(error: Error): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  /**
   * Serialize writes: each chunk waits for the previous chunk's flush
   * callback, so a slow child applies backpressure instead of unbounded
   * internal buffering. Failures reject only their own write.
   */
  #write(line: string): Promise<void> {
    const write = this.#writeTail.then(() => this.#writeNow(line));
    this.#writeTail = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  #writeNow(line: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const stdin = this.#child?.stdin;
      if (stdin == null || stdin.destroyed || !stdin.writable) {
        reject(this.#stdinError ?? new Error("RPC stdin is not writable"));
        return;
      }
      const onError = (error: Error): void => {
        stdin.off("error", onError);
        reject(error);
      };
      stdin.once("error", onError);
      stdin.write(line, (error?: Error | null) => {
        stdin.off("error", onError);
        if (error != null) reject(error);
        else resolve();
      });
    });
  }
}
