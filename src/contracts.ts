import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent, RpcCommand, RpcExtensionUIRequest, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";

/** A child is a temporary Pi session: it works on messages, idles between them, and ends closed or failed. */
export type RunStatus = "starting" | "working" | "idle" | "closed" | "failed";
/**
 * What one report says. "answer" and "no-answer" leave the child idle and able to
 * take more messages; "failed" means the child itself ended.
 */
export type ReportStatus = "answer" | "no-answer" | "failed";
export type DeliveryStatus = "none" | "held" | "queued" | "appended" | "unconfirmed" | "suppressed" | "failed";
export interface ModelChoice { provider: string; id: string }
export interface SpawnTask { task: string; label?: string; model?: ModelChoice; thinking?: ThinkingLevel }
export interface ToolResultView {
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
}
export type TranscriptItem =
  | { kind: "message"; id: string; version: number; message: AgentMessage; streaming: boolean }
  | { kind: "tool"; id: string; version: number; toolName: string; args: unknown; started: boolean; complete: boolean; parentToolCallId?: string; result?: ToolResultView };
export interface TranscriptView { readonly version: number; readonly items: readonly TranscriptItem[] }
export interface RunView {
  id: string;
  label: string;
  task: string;
  status: RunStatus;
  model: ModelChoice;
  thinking: ThinkingLevel;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  activity: string;
  error?: string;
  /** Reports sent to the parent so far; each one has its own notice. */
  reports: number;
  /** Exact text of the latest report when it was an answer. */
  finalText?: string;
  sessionFile?: string;
  /** Native session id; with sessionFile, what a closed child resumes from. */
  sessionId?: string;
  delivery: DeliveryStatus;
  transcript: TranscriptView;
}
/** Snapshot of one report, taken when the child goes quiet. Later work never alters it. */
export interface Report {
  runId: string;
  /** 1-based report number for this run; the deduplication key. */
  seq: number;
  status: ReportStatus;
  /** The answer, or why there is none. */
  text: string;
  sessionFile?: string;
}
export interface ViewSource {
  list(): readonly RunView[];
  get(id: string): RunView | undefined;
  subscribe(listener: () => void): () => void;
  loadTranscript(id: string): Promise<void>;
  /** Keep this transcript resident while a read-only consumer is using it. */
  retainTranscript?(id: string): () => void;
}
export type RpcIncoming = JsonAgentSessionEvent | RpcExtensionUIRequest | { type: "extension_error"; extensionPath: string; event: string; error: string };
export interface ChildExit { code: number | null; signal: NodeJS.Signals | null; error?: string }
export interface ChildConnection {
  start(): void;
  request(command: RpcCommand, timeoutMs?: number): Promise<unknown>;
  respondToUi(response: RpcExtensionUIResponse): Promise<void>;
  onEvent(listener: (event: RpcIncoming) => void): () => void;
  onExit(listener: (exit: ChildExit) => void): () => void;
  close(): Promise<void>;
  diagnostics(): string;
}
export interface RpcProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxRecordBytes?: number;
}
export interface TranscriptModel extends TranscriptView {
  apply(event: JsonAgentSessionEvent): void;
  restore(messages: readonly AgentMessage[]): void;
  lastAssistant(): AssistantMessage | undefined;
}
export const isTerminal = (status: RunStatus): boolean => status === "closed" || status === "failed";
