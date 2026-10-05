import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent, RpcSessionState } from "@earendil-works/pi-coding-agent";
import type { ChildConnection, DeliveryStatus, ModelChoice, Report, ReportStatus, RpcIncoming, RunStatus, RunView, SpawnTask, ViewSource } from "./contracts.ts";
import { isTerminal } from "./contracts.ts";
import type { RunRecord } from "./archive.ts";
import { Transcript } from "./transcript.ts";

export interface PreparedChild {
  connection: ChildConnection;
  validateState(state: unknown): { sessionFile?: string; sessionId?: string; thinking: ThinkingLevel };
}
/** The recorded session a closed child reopens. */
export interface Resume { sessionId: string; sessionFile: string }
export interface ManagerOptions {
  owner: string;
  createChild(run: RunView, resume?: Resume): Promise<PreparedChild>;
  /** Close resumable children after this long idle; the next message resumes them. */
  idleCloseMs?: number;
  readArchive(path: string): Promise<Parameters<Transcript["restore"]>[0]>;
  record(record: RunRecord): void;
  report(report: Report, anchor: string | null): void;
  warn(message: string): void;
}
interface Run {
  view: RunView & { transcript: Transcript };
  anchor: string | null;
  /** The parent session that started it; only that session may resume it. */
  owner: string;
  reviving?: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** The parent interrupted this work; its stop is not news. */
  interrupting: boolean;
  child?: ChildConnection;
  /** Resolves once the task prompt is admitted (or the child ends), so messages queue behind it. */
  ready: Promise<void>;
  markReady: () => void;
  /** Prompt requests awaiting their admission response. */
  pending: number;
  /** No agent run is in progress since the last agent_settled. */
  settled: boolean;
  revision: number;
  checking: boolean;
  releasing?: Promise<void>;
  historical: boolean;
  transcriptLoaded: boolean;
  readers: number;
  /** Transcript position and final message at the last report; the next report must be newer. */
  reportStart: number;
  reported?: AssistantMessage;
}
export type AnswerKind = "final" | "partial" | "unavailable";

const textOf = (message: AssistantMessage | undefined): string =>
  message?.content.filter(block => block.type === "text").map(block => block.text).join("") ?? "";
const disposition = (result: unknown): string | undefined =>
  (result as { disposition?: string } | undefined)?.disposition;

/**
 * Owns children independently of tools and UI. No host session mutation occurs here.
 *
 * A child is a temporary Pi session for its parent runtime. Messages are native
 * prompts; whenever the child goes quiet its answer (or why there is none) is
 * reported once, and it idles until the next message, an explicit close, or
 * parent teardown.
 */
export class RunManager implements ViewSource {
  private runs = new Map<string, Run>();
  private listeners = new Set<() => void>();
  private stopped = false;
  private options: ManagerOptions;
  constructor(options: ManagerOptions, history: RunRecord[] = []) {
    this.options = options;
    for (const record of history) {
      const view = { ...record.run, transcript: new Transcript() };
      if (!isTerminal(view.status)) {
        // Children never outlive their parent runtime and are not resumed.
        if (view.status !== "idle") view.error = "Parent session ended while it was working.";
        view.status = "closed";
        view.activity = "Closed with its parent session";
      }
      if (view.delivery === "queued") view.delivery = "unconfirmed";
      if (view.delivery === "held") view.delivery = "suppressed"; // Historical reports are never replayed.
      this.runs.set(view.id, { view, anchor: record.anchor, owner: record.owner, interrupting: false,
        ready: Promise.resolve(), markReady: () => {},
        pending: 0, settled: true, revision: 0, checking: false, historical: true, transcriptLoaded: false,
        readers: 0, reportStart: 0 });
    }
  }
  get closed(): boolean { return this.stopped; }
  list(): readonly RunView[] { return [...this.runs.values()].map(run => run.view); }
  get(id: string): RunView | undefined { return this.runs.get(id)?.view; }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private changed(run?: Run, persist = false): void {
    if (run && persist && !run.historical && !this.stopped) {
      const { transcript: _, finalText: __, ...view } = run.view;
      try { this.options.record({ version: 1, owner: this.options.owner, anchor: run.anchor, run: view }); }
      catch (error) { this.options.warn(`Could not save Peeps metadata: ${String(error)}`); }
    }
    for (const listener of this.listeners) {
      try { listener(); } catch { /* A viewer cannot break the child lifecycle. */ }
    }
  }
  setDelivery(id: string, seq: number, status: DeliveryStatus): void {
    const run = this.runs.get(id);
    // The view shows the latest report; an earlier report's late update must not overwrite it.
    if (!run || run.view.reports !== seq || run.view.delivery === status) return;
    run.view.delivery = status;
    this.changed(run, true);
  }
  spawn(task: SpawnTask, defaults: { model: ModelChoice; thinking: ThinkingLevel }, anchor: string | null): RunView {
    if (this.stopped) throw new Error("Peeps owner is closed.");
    if (!task.task.trim()) throw new Error("Task must not be empty.");
    const view: Run["view"] = {
      id: randomUUID(), task: task.task, label: task.label?.trim() || task.task.replace(/\s+/g, " ").slice(0, 60),
      model: task.model ?? defaults.model, thinking: task.thinking ?? defaults.thinking,
      status: "starting", createdAt: Date.now(), activity: "Starting Pi", reports: 0, delivery: "none",
      transcript: new Transcript(),
    };
    let markReady!: () => void;
    const ready = new Promise<void>(resolve => { markReady = resolve; });
    const run: Run = { view, anchor, owner: this.options.owner, interrupting: false, ready, markReady,
      pending: 0, settled: false, revision: 0, checking: false,
      historical: false, transcriptLoaded: true, readers: 0, reportStart: 0 };
    this.runs.set(view.id, run);
    this.changed(run, true);
    void this.start(run).catch(error => this.finish(run, "failed", String(error))).finally(() => run.markReady());
    return view;
  }
  private async start(run: Run, resume?: Resume): Promise<void> {
    const prepared = await this.options.createChild(run.view, resume);
    run.child = prepared.connection;
    if (this.stopped || isTerminal(run.view.status)) {
      await prepared.connection.close();
      return;
    }
    run.child.onEvent(event => this.event(run, event));
    run.child.onExit(exit => {
      if (isTerminal(run.view.status)) return;
      void this.finish(run, "failed", `Child exited (${exit.error ?? `code ${exit.code}, signal ${exit.signal}`}).`);
    });
    run.child.start();
    const state = await run.child.request({ type: "get_state" }, 60_000);
    if (isTerminal(run.view.status) || this.stopped) return;
    const validated = prepared.validateState(state);
    run.view.sessionFile = validated.sessionFile;
    run.view.sessionId = validated.sessionId;
    run.view.thinking = validated.thinking;
    run.view.startedAt = Date.now();
    this.changed(run, true);
    if (resume) return; // The message that woke it is the first prompt.
    const result = await this.prompt(run, run.view.task);
    run.markReady();
    if (disposition(result) === "handled" && run.view.status === "starting") {
      // A consumed task starts no agent run, so the parent would otherwise wait forever.
      this.settle(run, "no-answer", "The task was consumed by a child command or input extension; no agent run started.");
    }
  }
  private event(run: Run, event: RpcIncoming): void {
    if (this.stopped || isTerminal(run.view.status)) return;
    if (event.type === "extension_ui_request") {
      if (["select", "confirm", "input", "editor"].includes(event.method)) {
        void run.child!.respondToUi({ type: "extension_ui_response", id: event.id, cancelled: true }).catch(() => {});
        void this.finish(run, "failed", "interaction_required: child requested a blocking dialog. Nothing was approved.");
      }
      return;
    }
    if (event.type === "extension_error") {
      run.view.activity = `Extension error: ${event.event}`;
      this.changed(run);
      return;
    }
    run.view.transcript.apply(event as JsonAgentSessionEvent);
    run.revision++;
    let persist = false;
    if (event.type === "agent_start") {
      run.settled = false;
      this.clearIdleTimer(run);
      run.view.activity = "Working";
      if (run.view.status !== "working") {
        run.view.status = "working";
        run.view.finalText = undefined; // The previous answer does not answer this work.
        run.view.error = undefined;
        persist = true;
      }
    } else if (event.type === "tool_execution_start") {
      run.view.activity = `Running ${event.toolName}`;
    } else if (event.type === "auto_retry_start") {
      run.view.activity = "Retrying";
    } else if (event.type === "compaction_start") {
      run.view.activity = "Compacting";
    } else if (event.type === "agent_settled") {
      // agent_end is not final: retries and admitted messages can continue the work.
      run.settled = true;
      void this.reconcile(run);
    }
    this.changed(run, persist);
  }
  private async prompt(run: Run, message: string): Promise<unknown> {
    run.pending++;
    try {
      return await run.child!.request({ type: "prompt", message, streamingBehavior: "steer" });
    } catch (error) {
      await this.finish(run, "failed", `Message admission failed or uncertain: ${String(error)}`);
      throw error;
    } finally {
      run.pending--;
      void this.reconcile(run);
    }
  }
  /**
   * Send a message like a person typing into the child. Pi starts a run when the
   * child is idle and steers the current run when it is working; checking its
   * state first would race with that decision. A closed child resumes first.
   */
  async send(id: string, message: string): Promise<unknown> {
    const run = this.require(id);
    if (!message.trim()) throw new Error("Message must not be empty.");
    if (this.stopped) throw new Error("Peeps owner is closed.");
    if (isTerminal(run.view.status)) await this.revive(run);
    await run.ready; // Queue behind the task prompt while the child starts.
    if (this.stopped || isTerminal(run.view.status)) {
      throw new Error(`Cannot message a ${run.view.status} peep${run.view.error ? `: ${run.view.error}` : "."}`);
    }
    this.clearIdleTimer(run);
    const result = await this.prompt(run, message);
    if (disposition(result) === "handled" && run.view.status === "starting") {
      // A resumed child consumed its waking message: it is simply idle again.
      run.view.status = "idle";
      run.view.activity = "Idle";
      this.changed(run, true);
      this.armIdleClose(run);
    }
    return result;
  }
  /**
   * Reopen a closed or failed child's own session in a new process. Only its
   * owning parent session may do this, and only once the old process is gone,
   * so one session file never has two writers.
   */
  private revive(run: Run): Promise<void> {
    run.reviving ??= (async () => {
      const { sessionFile, sessionId } = run.view;
      if (!sessionFile || !sessionId) throw new Error("This peep cannot resume: its parent session is ephemeral, so no child history was kept.");
      if (run.owner !== this.options.owner) throw new Error("This peep belongs to another parent session and cannot resume here.");
      await run.releasing;
      const transcript = new Transcript();
      transcript.restore(await this.options.readArchive(sessionFile));
      if (this.stopped) throw new Error("Peeps owner is closed.");
      let markReady!: () => void;
      run.ready = new Promise<void>(resolve => { markReady = resolve; });
      Object.assign(run, { markReady, historical: false, transcriptLoaded: true, child: undefined, releasing: undefined,
        pending: 0, settled: false, checking: false, interrupting: false, reportStart: transcript.items.length,
        reported: transcript.lastAssistant() });
      Object.assign(run.view, { transcript, status: "starting", activity: "Resuming", error: undefined,
        finishedAt: undefined, delivery: "none" });
      this.changed(run, true);
      void this.start(run, { sessionFile, sessionId })
        .catch(error => this.finish(run, "failed", `Could not resume: ${String(error)}`))
        .finally(() => run.markReady());
    })().finally(() => { run.reviving = undefined; });
    return run.reviving;
  }
  /**
   * Stop the current work but keep the child and its context. Messages still
   * queued for it are discarded and returned. No report follows unless the work
   * had already produced an answer.
   */
  async interrupt(id: string): Promise<{ interrupted: boolean; discarded: string[] }> {
    const run = this.require(id);
    // Only a running agent can be aborted; aborting before Pi starts the run could strand it.
    if (this.stopped || run.view.status !== "working") return { interrupted: false, discarded: [] };
    run.interrupting = true;
    let cleared: { steering?: string[]; followUp?: string[] } | undefined;
    try {
      cleared = await run.child!.request({ type: "clear_queue" }) as typeof cleared;
      await run.child!.request({ type: "abort" });
    } catch (error) {
      run.interrupting = false;
      throw error;
    }
    // The run may have finished while the abort was in flight; that report stands.
    if ((run.view.status as RunStatus) === "idle") run.interrupting = false;
    return { interrupted: true, discarded: [...cleared?.steering ?? [], ...cleared?.followUp ?? []] };
  }
  private armIdleClose(run: Run): void {
    this.clearIdleTimer(run);
    const ms = this.options.idleCloseMs;
    if (!ms || !run.view.sessionFile || !run.view.sessionId) return; // Without an archive, closing would lose it.
    run.idleTimer = setTimeout(() => { if (run.view.status === "idle") void this.finish(run, "closed"); }, ms);
    run.idleTimer.unref?.();
  }
  private clearIdleTimer(run: Run): void {
    if (run.idleTimer) clearTimeout(run.idleTimer);
    run.idleTimer = undefined;
  }
  /** Report once the child is quiet: settled, nothing in flight, not streaming. */
  private async reconcile(run: Run): Promise<void> {
    if (run.checking || !run.settled || run.pending || run.view.status !== "working" || this.stopped) return;
    run.checking = true;
    const revision = run.revision;
    try {
      const state = await run.child!.request({ type: "get_state" }) as RpcSessionState;
      if (run.view.status !== "working" || this.stopped || run.pending || revision !== run.revision || !run.settled) return;
      if (state.isStreaming || state.isCompacting) return;
      if (state.pendingMessageCount) {
        await this.finish(run, "failed", "Child settled with undelivered input; message delivery is uncertain.");
        return;
      }
      const latest = run.view.transcript.lastAssistant();
      const last = latest === run.reported ? undefined : latest; // An earlier report's answer is not this one.
      const text = textOf(last);
      if (last?.stopReason === "stop" && text) this.settle(run, "answer", text);
      else this.settle(run, "no-answer", last?.errorMessage ?? `The run ended without a final answer (stop reason: ${last?.stopReason ?? "none"}).`);
    } catch (error) {
      await this.finish(run, "failed", `Could not confirm the child went idle: ${String(error)}`);
    } finally {
      run.checking = false;
      if (revision !== run.revision && run.settled && !run.pending && run.view.status === "working") void this.reconcile(run);
    }
  }
  private settle(run: Run, status: Exclude<ReportStatus, "failed">, text: string): void {
    const interrupted = run.interrupting && status === "no-answer";
    run.interrupting = false;
    run.view.status = "idle";
    run.view.finalText = status === "answer" ? text : undefined; // Exact: no trim, separators, or truncation.
    run.view.error = status === "answer" || interrupted ? undefined : text;
    run.view.activity = status === "answer" ? "Idle" : interrupted ? "Idle · interrupted" : "Idle · no answer";
    run.reportStart = run.view.transcript.items.length;
    run.reported = run.view.transcript.lastAssistant();
    this.armIdleClose(run);
    if (interrupted) this.changed(run, true); // The parent asked for this stop.
    else this.report(run, status, text);
  }
  private report(run: Run, status: ReportStatus, text: string): void {
    if (this.stopped) return;
    run.view.reports++;
    run.view.delivery = "none";
    this.changed(run, true);
    const { id: runId, reports: seq, sessionFile } = run.view;
    try { this.options.report({ runId, seq, status, text, sessionFile }, run.anchor); }
    catch (error) { this.options.warn(`Peeps result delivery: ${String(error)}`); }
  }
  private finish(run: Run, status: "closed" | "failed", error?: string): Promise<void> {
    if (isTerminal(run.view.status)) return run.releasing ?? Promise.resolve();
    const busy = run.view.status !== "idle";
    this.clearIdleTimer(run);
    const resumable = !!run.view.sessionFile && !!run.view.sessionId && run.owner === this.options.owner;
    run.view.status = status;
    run.view.error = error;
    run.view.activity = error ?? (status === "failed" ? "Failed" : resumable ? "Closed · resumes on message" : "Closed");
    run.view.finishedAt = Date.now();
    this.changed(run, true);
    run.markReady();
    run.releasing = (async () => {
      if (run.child) {
        if (busy) {
          // Out-of-band bounded controls: never await a hung prompt/start request.
          await Promise.allSettled([
            run.child.request({ type: "clear_queue" }, 500),
            run.child.request({ type: "abort" }, 500),
          ]);
        }
        try { await run.child.close(); }
        catch (error) { this.options.warn(`Peeps cleanup: ${String(error)}`); }
        if (status === "failed") {
          const diagnostics = run.child.diagnostics().slice(-4096).trim();
          if (diagnostics) {
            run.view.error = `${error ?? "Child failed."}\n\nChild diagnostics (bounded tail):\n${diagnostics}`;
            this.changed(run, true);
          }
        }
      }
      // Closing was the parent's own request; only a failure is news.
      if (status === "failed") this.report(run, "failed", run.view.error ?? "Child failed.");
      this.evictTranscript(run);
    })();
    return run.releasing;
  }
  /**
   * The latest answer for inspection. Only a captured answer, or a cleanly closed
   * archived child's final stop message, is labelled final.
   */
  answer(id: string): { text: string; kind: AnswerKind } {
    const run = this.require(id);
    if (run.view.finalText !== undefined) return { text: run.view.finalText, kind: "final" };
    const items = run.view.transcript.items;
    let last: AssistantMessage | undefined;
    for (let i = items.length - 1; i >= run.reportStart; i--) {
      const item = items[i];
      if (item?.kind === "message" && item.message.role === "assistant") { last = item.message; break; }
    }
    const text = textOf(last);
    const clean = run.view.status === "closed" && !run.view.error;
    return { text, kind: clean && last?.stopReason === "stop" && text ? "final" : text ? "partial" : "unavailable" };
  }
  private require(id: string): Run {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Unknown peep: ${id}`);
    return run;
  }
  /** Close one child or all of them. Work in progress is aborted; no report is sent. */
  async closeChild(id: string): Promise<void> {
    const runs = id === "all" ? [...this.runs.values()] : [this.require(id)];
    await Promise.all(runs.filter(r => !isTerminal(r.view.status)).map(run =>
      this.finish(run, "closed", run.view.status === "idle" ? undefined : "Closed by the parent while working.")));
  }
  retainTranscript(id: string): () => void {
    const run = this.require(id);
    run.readers++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      run.readers--;
      this.evictTranscript(run);
    };
  }
  private evictTranscript(run: Run): void {
    if (!isTerminal(run.view.status) || !run.view.sessionFile || run.readers || !run.transcriptLoaded) return;
    // Native JSONL owns finished history. Only live children and current readers
    // need a second in-memory copy; ephemeral runs have no archive to fall back on.
    run.view.transcript = new Transcript();
    run.transcriptLoaded = false;
    run.reportStart = 0; // A reloaded archive starts at item 0.
    this.changed(run);
  }
  async loadTranscript(id: string): Promise<void> {
    const run = this.require(id);
    if (run.transcriptLoaded) return;
    if (!run.view.sessionFile) throw new Error("No persistent child transcript (ephemeral parent or interrupted startup).");
    const hadReader = run.readers > 0;
    await run.releasing; // Never read a child archive while its process is closing.
    const transcript = new Transcript();
    transcript.restore(await this.options.readArchive(run.view.sessionFile));
    if (hadReader && run.readers === 0) return; // Viewer closed during the read.
    run.view.transcript = transcript;
    run.transcriptLoaded = true;
    this.changed(run);
  }
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; // Synchronous ownership fence before the first await.
    this.changed();
    await Promise.all([...this.runs.values()].map(run => isTerminal(run.view.status) ? run.releasing
      : this.finish(run, "closed", run.view.status === "idle" ? undefined : "Parent session ended while it was working.")));
    this.listeners.clear();
  }
}
