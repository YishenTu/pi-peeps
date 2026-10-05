import type { ExtensionAPI, InputSource, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { DeliveryStatus, Report } from "./contracts.ts";

export const RESULT_TYPE = "peeps-result";
export interface ResultDetails { owner: string; runId: string; seq: number; status: string; sessionFile?: string }
export interface DeliveryHost {
  owner: string;
  active(anchor: string | null): boolean;
  branch(): readonly SessionEntry[];
  send: ExtensionAPI["sendMessage"];
  update(id: string, seq: number, status: DeliveryStatus): void;
}
interface Outcome { result: Report; anchor: string | null; sent: boolean; state: DeliveryStatus }
/** Each report is delivered at most once. */
const key = (runId: string, seq: number) => runId + "#" + seq;

/** Policy around the native queue, not a replacement for Pi's delivery runtime. */
export class ResultDelivery {
  private outcomes = new Map<string, Outcome>();
  private closed = false;
  private paused = false;
  private humanCandidate = false;
  private unbindAbort?: () => void;
  private host: DeliveryHost;
  constructor(host: DeliveryHost) { this.host = host; }

  watch(signal: AbortSignal | undefined): void {
    this.unbindAbort?.();
    this.unbindAbort = undefined;
    if (!signal || this.closed) return;
    const pause = () => { this.paused = true; this.humanCandidate = false; };
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
    if (!resume || this.closed) return;
    this.paused = false;
    // The ordinary prompt will drain nextTurn custom messages after this hook.
    for (const outcome of this.outcomes.values()) if (!outcome.sent) this.send(outcome, "nextTurn");
  }
  offer(result: Report, anchor: string | null): void {
    const id = key(result.runId, result.seq);
    if (this.closed || this.outcomes.has(id)) return;
    const outcome: Outcome = { result, anchor, sent: false, state: "none" };
    this.outcomes.set(id, outcome);
    if (!this.host.active(anchor)) {
      outcome.sent = true;
      this.update(outcome, "suppressed");
    } else if (this.paused) {
      this.update(outcome, "held");
    } else this.send(outcome, "steer");
  }
  private update(outcome: Outcome, state: DeliveryStatus): void {
    outcome.state = state;
    this.host.update(outcome.result.runId, outcome.result.seq, state);
  }
  private send(outcome: Outcome, deliverAs: "steer" | "nextTurn"): void {
    if (outcome.sent || this.closed) return;
    outcome.sent = true; // Reentrant events must never enqueue the same result twice.
    const { result, anchor } = outcome;
    if (!this.host.active(anchor)) {
      this.update(outcome, "suppressed");
      return;
    }
    const details: ResultDetails = {
      owner: this.host.owner, runId: result.runId, seq: result.seq, status: result.status, sessionFile: result.sessionFile,
    };
    this.update(outcome, "queued");
    try {
      this.host.send({
        customType: RESULT_TYPE, display: true, details,
        content: `[Peeps automated result — ${result.runId} — ${result.status}]\n${result.text}`,
      }, { deliverAs, triggerTurn: deliverAs === "steer" });
    } catch {
      // sendMessage is void: async host errors are NOT acknowledged by this catch.
      this.update(outcome, "failed");
    }
  }
  reconcile(settled = false): void {
    if (this.closed) return;
    const appended = new Set<string>();
    for (const entry of this.host.branch()) {
      if (entry.type !== "custom_message" || entry.customType !== RESULT_TYPE) continue;
      const details = entry.details as Partial<ResultDetails> | undefined;
      if (details?.owner === this.host.owner && typeof details.runId === "string" && typeof details.seq === "number") {
        appended.add(key(details.runId, details.seq));
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
    this.unbindAbort?.();
    this.outcomes.clear();
  }
}
