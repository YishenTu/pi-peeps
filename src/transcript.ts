import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ToolResultView, TranscriptItem, TranscriptModel } from "./contracts.ts";

type MessageItem = Extract<TranscriptItem, { kind: "message" }>;
type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

/** Wire message_update payloads are delta-only; only these fields survive the JSON transform. */
interface AssistantStreamEvent {
  type: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  id?: string;
  toolName?: string;
  toolCall?: ToolCall;
  message?: AssistantMessage;
  error?: AssistantMessage;
}

interface TranscriptState {
  items: TranscriptItem[];
  messages: Map<string, number>;
  tools: Map<string, number>;
  /** Message item created by message_start and awaiting its authoritative message_end. */
  pendingMessageId: string | undefined;
  /** Assistant message currently being reconstructed from delta updates. */
  streamingMessageId: string | undefined;
  lastAssistant: AssistantMessage | undefined;
  toolArgsRaw: Map<string, string>;
  nextId: number;
  version: number;
}

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const tryParseJson = (raw: string): Record<string, unknown> | undefined => {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const toResultView = (result: unknown, isError: boolean): ToolResultView => {
  const record = isRecord(result) ? result : {};
  const content = Array.isArray(record.content) ? (record.content as (TextContent | ImageContent)[]) : [];
  return { content, details: record.details, isError };
};

interface ToolExecutionWire {
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  parentToolCallId?: string;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
}

const freshState = (): TranscriptState => ({
  items: [],
  messages: new Map(),
  tools: new Map(),
  pendingMessageId: undefined,
  streamingMessageId: undefined,
  lastAssistant: undefined,
  toolArgsRaw: new Map(),
  nextId: 0,
  version: 0,
});

/**
 * Reducer for the child session event stream (JsonAgentSessionEvent).
 *
 * The wire format is delta-only for streaming assistant content, so text/thinking
 * blocks are reconstructed per contentIndex and replaced by the authoritative
 * message_end message. Tool calls, tool executions, and tool results are keyed by
 * toolCallId so a single call produces a single tool item without duplicates.
 */
export class Transcript implements TranscriptModel {
  private state: TranscriptState = freshState();

  get version(): number {
    return this.state.version;
  }

  get items(): readonly TranscriptItem[] {
    return this.state.items;
  }

  apply(event: JsonAgentSessionEvent): void {
    const wire = event as unknown as Record<string, unknown> & { type: string };
    switch (wire.type) {
      case "message_start":
        this.onMessageStart(wire.message as AgentMessage | undefined);
        break;
      case "message_update":
        this.onMessageUpdate(
          wire.assistantMessageEvent as AssistantStreamEvent | undefined,
          wire.usage as Usage | undefined,
        );
        break;
      case "message_end":
        this.onMessageEnd(wire.message as AgentMessage | undefined);
        break;
      case "turn_end":
        this.onTurnEnd(
          wire.message as AgentMessage | undefined,
          wire.toolResults as ToolResultMessage[] | undefined,
        );
        break;
      case "tool_execution_start":
        this.onToolExecutionStart(wire as unknown as ToolExecutionWire);
        break;
      case "tool_execution_update":
        this.onToolExecutionUpdate(wire as unknown as ToolExecutionWire);
        break;
      case "tool_execution_end":
        this.onToolExecutionEnd(wire as unknown as ToolExecutionWire);
        break;
      case "agent_end":
        this.onAgentEnd(wire.messages as AgentMessage[] | undefined, wire.willRetry === true);
        break;
      default:
        // Unknown optional events (compaction, retries, queue updates, ...) are harmless.
        break;
    }
  }

  restore(messages: readonly AgentMessage[]): void {
    this.state = freshState();
    const results = new Map<string, ToolResultMessage>();
    for (const message of messages) {
      if (message.role === "toolResult") results.set(message.toolCallId, message);
    }

    for (const message of messages) {
      if (message.role === "toolResult") continue;
      if (message.role === "system") continue;
      if (message.role === "assistant") {
        this.appendMessageItem(message, false);
        for (const content of message.content) {
          if (content.type !== "toolCall") continue;
          const index = this.ensureToolItem(content.id, content.name);
          this.updateToolAt(index, { args: content.arguments });
          const result = results.get(content.id);
          if (result) {
            this.updateToolAt(index, {
              started: true,
              complete: true,
              result: toResultView(result, result.isError),
            });
            results.delete(content.id);
          }
        }
        this.state.lastAssistant = message;
        continue;
      }
      this.appendMessageItem(message, false);
    }

    // Tool results whose call block was not preserved still represent real activity.
    for (const result of results.values()) {
      const index = this.ensureToolItem(result.toolCallId, result.toolName);
      this.updateToolAt(index, {
        started: true,
        complete: true,
        result: toResultView(result, result.isError),
      });
    }
    this.bump();
  }

  lastAssistant(): AssistantMessage | undefined {
    return this.state.lastAssistant;
  }

  private onMessageStart(message: AgentMessage | undefined): void {
    if (!message) return;
    if (message.role === "toolResult") {
      this.ingestToolResult(message);
      return;
    }
    if (message.role === "system") return;
    const id = this.appendMessageItem(message, message.role === "assistant");
    this.state.pendingMessageId = id;
    if (message.role === "assistant") this.state.streamingMessageId = id;
  }

  private onMessageUpdate(stream: AssistantStreamEvent | undefined, usage: Usage | undefined): void {
    if (!stream) return;
    let index = this.state.streamingMessageId
      ? this.state.messages.get(this.state.streamingMessageId)
      : undefined;
    let message: AssistantMessage;
    if (index === undefined) {
      message = {
        role: "assistant",
        content: [],
        api: "",
        provider: "",
        model: "",
        usage: usage ?? ZERO_USAGE,
        stopReason: "pending",
        timestamp: Date.now(),
      };
      const id = this.appendMessageItem(message, true);
      this.state.streamingMessageId = id;
      this.state.pendingMessageId = id;
      index = this.state.messages.get(id);
    } else {
      const item = this.state.items[index];
      if (!item || item.kind !== "message" || item.message.role !== "assistant") return;
      message = item.message;
    }
    if (index === undefined) return;
    const next = this.applyStreamEvent(message, stream);
    this.replaceMessageAt(index, next, true);
  }

  private onMessageEnd(message: AgentMessage | undefined): void {
    if (!message) return;
    if (message.role === "toolResult") {
      this.ingestToolResult(message);
      return;
    }
    if (message.role === "system") return;

    const pendingId = this.state.pendingMessageId;
    let index = pendingId ? this.state.messages.get(pendingId) : undefined;
    // Only assistant messages stream without a start message; never overwrite an
    // earlier message of another role just because message_start was missing.
    if (index === undefined && message.role === "assistant") {
      index = this.findLastMessageIndex("assistant", true);
    }
    if (index === undefined) {
      this.appendMessageItem(message, false);
    } else {
      this.replaceMessageAt(index, message, false);
    }

    if (message.role === "assistant") {
      this.state.lastAssistant = message;
      this.ensureToolItemsForMessage(message);
    }
    if (pendingId && this.state.streamingMessageId === pendingId) this.state.streamingMessageId = undefined;
    this.state.pendingMessageId = undefined;
  }

  private onTurnEnd(message: AgentMessage | undefined, toolResults: ToolResultMessage[] | undefined): void {
    if (message && message.role === "assistant") {
      const streamingId = this.state.streamingMessageId;
      let index = streamingId ? this.state.messages.get(streamingId) : undefined;
      if (index === undefined) index = this.findAssistantByTimestamp(message.timestamp);
      if (index === undefined) index = this.findLastMessageIndex("assistant", true);
      if (index === undefined) {
        this.appendMessageItem(message, false);
      } else {
        this.replaceMessageAt(index, message, false);
      }
      this.state.lastAssistant = message;
      this.state.streamingMessageId = undefined;
      this.state.pendingMessageId = undefined;
      this.ensureToolItemsForMessage(message);
    }
    if (toolResults) for (const result of toolResults) this.ingestToolResult(result);
  }

  private onAgentEnd(messages: AgentMessage[] | undefined, willRetry: boolean): void {
    if (!messages || willRetry) return;
    // Reconcile a still-streaming assistant message with the run's authoritative output.
    if (!this.state.streamingMessageId) return;
    for (let i = messages.length - 1; i >= 0; i--) {
      const candidate = messages[i];
      if (candidate && candidate.role === "assistant") {
        const index = this.state.messages.get(this.state.streamingMessageId);
        if (index !== undefined) this.replaceMessageAt(index, candidate, false);
        this.state.lastAssistant = candidate;
        this.ensureToolItemsForMessage(candidate);
        this.state.streamingMessageId = undefined;
        this.state.pendingMessageId = undefined;
        return;
      }
    }
  }

  private onToolExecutionStart(wire: ToolExecutionWire): void {
    const id = typeof wire.toolCallId === "string" ? wire.toolCallId : "";
    if (!id) return;
    const name = typeof wire.toolName === "string" ? wire.toolName : "";
    const index = this.ensureToolItem(id, name);
    const patch: Partial<ToolItem> = { started: true, args: wire.args ?? {} };
    if (typeof wire.parentToolCallId === "string") patch.parentToolCallId = wire.parentToolCallId;
    this.updateToolAt(index, patch);
  }

  private onToolExecutionUpdate(wire: ToolExecutionWire): void {
    const id = typeof wire.toolCallId === "string" ? wire.toolCallId : "";
    if (!id) return;
    const name = typeof wire.toolName === "string" ? wire.toolName : "";
    const index = this.ensureToolItem(id, name);
    const patch: Partial<ToolItem> = { result: toResultView(wire.partialResult, false), started: true };
    if (wire.args !== undefined) patch.args = wire.args;
    if (typeof wire.parentToolCallId === "string") patch.parentToolCallId = wire.parentToolCallId;
    this.updateToolAt(index, patch);
  }

  private onToolExecutionEnd(wire: ToolExecutionWire): void {
    const id = typeof wire.toolCallId === "string" ? wire.toolCallId : "";
    if (!id) return;
    const name = typeof wire.toolName === "string" ? wire.toolName : "";
    const index = this.ensureToolItem(id, name);
    const patch: Partial<ToolItem> = {
      started: true,
      complete: true,
      result: toResultView(wire.result, wire.isError === true),
    };
    if (wire.args !== undefined) patch.args = wire.args;
    if (typeof wire.parentToolCallId === "string") patch.parentToolCallId = wire.parentToolCallId;
    this.updateToolAt(index, patch);
  }

  private applyStreamEvent(message: AssistantMessage, stream: AssistantStreamEvent): AssistantMessage {
    const contentIndex = typeof stream.contentIndex === "number" ? stream.contentIndex : 0;
    const content = message.content.slice();
    switch (stream.type) {
      case "text_start":
        content[contentIndex] = { type: "text", text: "" };
        break;
      case "text_delta": {
        const previous = content[contentIndex];
        const text = previous && previous.type === "text" ? previous.text : "";
        content[contentIndex] = { type: "text", text: text + (stream.delta ?? "") };
        break;
      }
      case "text_end":
        content[contentIndex] = { type: "text", text: stream.content ?? "" };
        break;
      case "thinking_start":
        content[contentIndex] = { type: "thinking", thinking: "" };
        break;
      case "thinking_delta": {
        const previous = content[contentIndex];
        const thinking = previous && previous.type === "thinking" ? previous.thinking : "";
        content[contentIndex] = { type: "thinking", thinking: thinking + (stream.delta ?? "") };
        break;
      }
      case "thinking_end":
        content[contentIndex] = { type: "thinking", thinking: stream.content ?? "" };
        break;
      case "toolcall_start": {
        const id = stream.id ?? "";
        const name = stream.toolName ?? "";
        content[contentIndex] = { type: "toolCall", id, name, arguments: {} };
        if (id) this.ensureToolItem(id, name);
        break;
      }
      case "toolcall_delta": {
        const block = content[contentIndex];
        if (block && block.type === "toolCall") {
          const raw = (this.state.toolArgsRaw.get(block.id) ?? "") + (stream.delta ?? "");
          this.state.toolArgsRaw.set(block.id, raw);
          const parsed = tryParseJson(raw);
          if (parsed) {
            content[contentIndex] = { ...block, arguments: parsed as ToolCall["arguments"] };
            this.updateToolById(block.id, { args: parsed });
          }
        }
        break;
      }
      case "toolcall_end":
        if (stream.toolCall) {
          content[contentIndex] = stream.toolCall;
          this.state.toolArgsRaw.delete(stream.toolCall.id);
          this.ensureToolItem(stream.toolCall.id, stream.toolCall.name);
          this.updateToolById(stream.toolCall.id, { args: stream.toolCall.arguments });
        }
        break;
      case "done":
        if (stream.message) return stream.message;
        break;
      case "error":
        if (stream.error) return stream.error;
        break;
      default:
        break;
    }
    return { ...message, content };
  }

  private ingestToolResult(message: ToolResultMessage): void {
    const index = this.ensureToolItem(message.toolCallId, message.toolName);
    this.updateToolAt(index, {
      started: true,
      complete: true,
      result: toResultView(message, message.isError),
    });
  }

  private ensureToolItemsForMessage(message: AssistantMessage): void {
    for (const content of message.content) {
      if (content.type !== "toolCall") continue;
      const index = this.ensureToolItem(content.id, content.name);
      this.updateToolAt(index, { args: content.arguments });
    }
  }

  private appendMessageItem(message: AgentMessage, streaming: boolean): string {
    const id = "m:" + this.state.nextId++;
    const item: MessageItem = { kind: "message", id, version: 0, message, streaming };
    this.state.items.push(item);
    this.state.messages.set(id, this.state.items.length - 1);
    this.bump();
    return id;
  }

  private replaceMessageAt(index: number, message: AgentMessage, streaming: boolean): void {
    const previous = this.state.items[index];
    if (!previous || previous.kind !== "message") return;
    this.state.items[index] = {
      kind: "message",
      id: previous.id,
      version: previous.version + 1,
      message,
      streaming,
    };
    this.bump();
  }

  private ensureToolItem(toolCallId: string, toolName: string): number {
    const existing = this.state.tools.get(toolCallId);
    if (existing !== undefined) {
      const item = this.state.items[existing];
      if (item && item.kind === "tool" && toolName && item.toolName !== toolName) {
        this.updateToolAt(existing, { toolName });
      }
      return existing;
    }
    const index = this.state.items.length;
    const item: ToolItem = {
      kind: "tool",
      id: toolCallId,
      version: 0,
      toolName,
      args: {},
      started: false,
      complete: false,
    };
    this.state.items.push(item);
    this.state.tools.set(toolCallId, index);
    this.bump();
    return index;
  }

  private updateToolById(toolCallId: string, patch: Partial<ToolItem>): void {
    const index = this.state.tools.get(toolCallId);
    if (index === undefined) return;
    this.updateToolAt(index, patch);
  }

  private updateToolAt(index: number, patch: Partial<ToolItem>): void {
    const previous = this.state.items[index];
    if (!previous || previous.kind !== "tool") return;
    this.state.items[index] = { ...previous, ...patch, version: previous.version + 1 };
    this.bump();
  }

  private findLastMessageIndex(role: AgentMessage["role"], streamingOnly = false): number | undefined {
    for (let i = this.state.items.length - 1; i >= 0; i--) {
      const item = this.state.items[i];
      if (!item || item.kind !== "message") continue;
      if (item.message.role !== role) continue;
      if (streamingOnly && !item.streaming) continue;
      return i;
    }
    return undefined;
  }

  private findAssistantByTimestamp(timestamp: number): number | undefined {
    for (let i = this.state.items.length - 1; i >= 0; i--) {
      const item = this.state.items[i];
      if (!item || item.kind !== "message" || item.message.role !== "assistant") continue;
      if (item.message.timestamp === timestamp) return i;
    }
    return undefined;
  }

  private bump(): void {
    this.state.version += 1;
  }
}
