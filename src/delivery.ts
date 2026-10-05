import type { ExtensionAPI, InputSource, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { DeliveryStatus, Report } from "./contracts.ts";

export const RESULT_TYPE = "peeps-result";
export const IDLE_QUIET_MS = 1_000;
export const IDLE_CAP_MS = 5_000;
export interface ResultItem { runId: string; seq: number; status: string; sessionFile?: string }
export interface ResultDetails { owner: string; results: ResultItem[] }
export interface LegacyResultDetails extends ResultItem { owner: string }
export interface DeliveryHost {
  owner: string;
  active(anchor: string | null): boolean;
  /** No parent agent run is active (agent_start through agent_settled). */
  isIdle(): boolean;
  branch(): readonly SessionEntry[];
  send: ExtensionAPI["sendMessage"];
  update(id: string, seq: number, status: DeliveryStatus): void;
}
interface Outcome { result: Report; anchor: string | null; sent: boolean; state: DeliveryStatus }
/** Each report is delivered at most once. */
const key = (runId: string, seq: number) => runId + "#" + seq;

/** Batches in Peeps before admission to Pi's native queue. */
export class ResultDelivery {
  private outcomes = new Map<string, Outcome>();
  private buffer = new Set<Outcome>();
  private quietTimer?: ReturnType<typeof setTimeout>;
  private capTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private paused = false;
  private humanCandidate = false;
  private unbindAbort?: () => void;
  private host: DeliveryHost;
  private quietMs: number;
  private capMs: number;
  constructor(host: DeliveryHost, timing: { quietMs?: number; capMs?: number } = {}) {
    this.host = host;
    this.quietMs = timing.quietMs ?? IDLE_QUIET_MS;
    this.capMs = timing.capMs ?? IDLE_CAP_MS;
  }

  watch(signal: AbortSignal | undefined): void {
    this.unbindAbort?.();
    this.unbindAbort = undefined;
    if (!this.host.isIdle()) this.clearTimers();
    if (!signal || this.closed) return;
    const pause = () => {
      this.paused = true;
      this.humanCandidate = false;
      this.clearTimers();
      for (const outcome of this.buffer) this.update(outcome, "held");
    };
    if (signal.aborted) pause();
    else {
      signal.addEventListener("abort", pause, { once: true });
      this.unbindAbort = () => signal.removeEventListener("abort", pause);
    }
  }
  /** A human prompt arrives from the TUI editor or an RPC client; another extension's prompt is not one. */
  input(source: InputSource): void { this.humanCandidate = source === "interactive" || source === "rpc"; }
  beforeAgentStart(): void {
    const resume = this.humanCandidate;
    this.humanCandidate = false;
    if (!resume || this.closed || !this.paused) return;
    this.paused = false;
    // The ordinary prompt will drain nextTurn custom messages after this hook.
    this.flush("nextTurn");
  }
  offer(result: Report, anchor: string | null): void {
    const id = key(result.runId, result.seq);
    if (this.closed || this.outcomes.has(id)) return;
    const outcome: Outcome = { result, anchor, sent: false, state: "none" };
    this.outcomes.set(id, outcome);
    this.buffer.add(outcome);
    if (this.paused) this.update(outcome, "held");
    else if (this.host.isIdle()) this.debounce();
  }
  private clearTimers(): void {
    clearTimeout(this.quietTimer);
    clearTimeout(this.capTimer);
    this.quietTimer = this.capTimer = undefined;
  }
  private debounce(): void {
    const elapsed = () => {
      this.clearTimers();
      // A human/extension may have started work since the timer was armed.
      // Busy results wait for turn_end (or the agent_settled fallback).
      if (this.host.isIdle()) this.flush();
    };
    clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(elapsed, this.quietMs);
    this.capTimer ??= setTimeout(elapsed, this.capMs);
  }
  private update(outcome: Outcome, state: DeliveryStatus): void {
    outcome.state = state;
    this.host.update(outcome.result.runId, outcome.result.seq, state);
  }
  /** Called synchronously at turn_end, before Pi polls steering, and at agent_settled. */
  flush(deliverAs: "steer" | "nextTurn" = "steer"): void {
    this.clearTimers();
    if (this.closed || this.paused) return;
    const batch = [...this.buffer];
    this.buffer.clear();
    // Fence the entire snapshot before host callbacks can reenter delivery.
    for (const outcome of batch) outcome.sent = true;
    const active = batch.filter(outcome => {
      if (this.host.active(outcome.anchor)) return true;
      this.update(outcome, "suppressed");
      return false;
    });
    if (!active.length) return;
    const details: ResultDetails = {
      owner: this.host.owner,
      results: active.map(({ result }) => ({
        runId: result.runId, seq: result.seq, status: result.status, sessionFile: result.sessionFile,
      })),
    };
    for (const outcome of active) this.update(outcome, "queued");
    try {
      this.host.send({
        customType: RESULT_TYPE, display: true, details,
        content: active.map(({ result }) => `[Peeps automated result — ${result.runId} — ${result.status}]\n${result.text}`).join("\n\n"),
      }, { deliverAs, triggerTurn: deliverAs === "steer" });
    } catch {
      // sendMessage is void: async host errors are NOT acknowledged by this catch.
      for (const outcome of active) this.update(outcome, "failed");
    }
  }
  reconcile(settled = false): void {
    if (this.closed) return;
    const appended = new Set<string>();
    for (const entry of this.host.branch()) {
      if (entry.type !== "custom_message" || entry.customType !== RESULT_TYPE) continue;
      const details = entry.details as Partial<ResultDetails & LegacyResultDetails> | undefined;
      if (details?.owner !== this.host.owner) continue;
      const results = Array.isArray(details.results) ? details.results : [details];
      for (const result of results) {
        if (result && typeof result.runId === "string" && typeof result.seq === "number") {
          appended.add(key(result.runId, result.seq));
        }
      }
    }
    for (const [id, outcome] of this.outcomes) {
      if (appended.has(id)) { if (outcome.state !== "appended") this.update(outcome, "appended"); }
      else if (settled && outcome.sent && outcome.state === "queued") this.update(outcome, "unconfirmed");
    }
    // Never retry an unconfirmed native queue item: clearQueue and raw abort differ.
  }
  close(): void {
    this.closed = true;
    this.clearTimers();
    this.unbindAbort?.();
    this.buffer.clear();
    this.outcomes.clear();
  }
}
