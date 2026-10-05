import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Transcript } from "../src/transcript.ts";
import type { TranscriptItem } from "../src/contracts.ts";

type MessageItem = Extract<TranscriptItem, { kind: "message" }>;
type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistant = (
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "test",
  provider: "test",
  model: "test",
  usage,
  stopReason,
  timestamp: 7,
});

const ev = (value: Record<string, unknown>): JsonAgentSessionEvent =>
  value as unknown as JsonAgentSessionEvent;

const messageItems = (transcript: Transcript): MessageItem[] =>
  transcript.items.filter((item): item is MessageItem => item.kind === "message");

type AssistantItem = MessageItem & { message: AssistantMessage };

const assistantItems = (transcript: Transcript): AssistantItem[] =>
  messageItems(transcript).filter((item): item is AssistantItem => item.message.role === "assistant");

const toolItems = (transcript: Transcript): ToolItem[] =>
  transcript.items.filter((item): item is ToolItem => item.kind === "tool");

test("reconstructs delta-only text and replaces it with the authoritative message_end", () => {
  const transcript = new Transcript();
  transcript.apply(ev({ type: "message_start", message: assistant([], "pending") }));
  transcript.apply(
    ev({
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    }),
  );
  transcript.apply(
    ev({
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
    }),
  );
  transcript.apply(
    ev({
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
    }),
  );

  const streaming = assistantItems(transcript);
  assert.equal(streaming.length, 1);
  assert.equal(streaming[0]!.streaming, true);
  assert.equal(streaming[0]!.message.content[0]?.type, "text");
  assert.equal(
    streaming[0]!.message.content[0]?.type === "text" ? streaming[0]!.message.content[0].text : "",
    "Hello",
  );

  transcript.apply(ev({ type: "message_end", message: assistant([{ type: "text", text: "Hello world" }]) }));

  const final = assistantItems(transcript);
  assert.equal(final.length, 1, "message_end must not append a duplicate");
  assert.equal(final[0]!.streaming, false);
  assert.equal(final[0]!.message.content[0]?.type === "text" ? final[0]!.message.content[0].text : "", "Hello world");
  assert.equal(transcript.lastAssistant()?.content[0]?.type === "text" ? true : false, true);
});

test("reconstructs thinking blocks and buffers partial tool arguments without executing", () => {
  const transcript = new Transcript();
  transcript.apply(ev({ type: "message_start", message: assistant([], "pending") }));
  transcript.apply(
    ev({
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    }),
  );
  transcript.apply(
    ev({
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "pon" },
    }),
  );
  transcript.apply(
    ev({
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "ponder" },
    }),
  );
  transcript.apply(
    ev({
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "call_a", toolName: "write" },
    }),
  );
  transcript.apply(
    ev({
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "{\"path\":" },
    }),
  );

  let tools = toolItems(transcript);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.started, false, "partial args must not mark execution started");
  assert.deepEqual(tools[0]!.args, {});

  transcript.apply(
    ev({
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "\"a.txt\"}" },
    }),
  );
  tools = toolItems(transcript);
  assert.deepEqual(tools[0]!.args, { path: "a.txt" });

  transcript.apply(
    ev({
      type: "message_update",
      usage,
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: { type: "toolCall", id: "call_a", name: "write", arguments: { path: "a.txt" } },
      },
    }),
  );

  const message = assistantItems(transcript)[0]!;
  const thinking = message.message.content[0];
  assert.equal(thinking?.type, "thinking");
  assert.equal(thinking?.type === "thinking" ? thinking.thinking : "", "ponder");
});

test("keys tool call, execution, and result by toolCallId without duplicates", () => {
  const transcript = new Transcript();
  transcript.apply(ev({ type: "message_start", message: assistant([], "pending") }));
  transcript.apply(
    ev({
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "call_1", toolName: "bash" },
    }),
  );
  transcript.apply(
    ev({
      type: "message_update",
      usage,
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
      },
    }),
  );
  transcript.apply(
    ev({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } }),
  );
  transcript.apply(
    ev({
      type: "tool_execution_update",
      toolCallId: "call_1",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "partial" }], isError: false },
    }),
  );
  transcript.apply(
    ev({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "done" }], details: { ok: true } },
      isError: false,
    }),
  );
  transcript.apply(
    ev({
      type: "message_end",
      message: assistant(
        [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }],
        "toolUse",
      ),
    }),
  );
  const result: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "bash",
    content: [{ type: "text", text: "done" }],
    isError: false,
    timestamp: 9,
  };
  transcript.apply(ev({ type: "message_end", message: result }));
  transcript.apply(
    ev({
      type: "turn_end",
      message: assistant(
        [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }],
        "toolUse",
      ),
      toolResults: [result],
    }),
  );

  const tools = toolItems(transcript);
  assert.equal(tools.length, 1, "one tool item per toolCallId");
  assert.equal(tools[0]!.started, true);
  assert.equal(tools[0]!.complete, true);
  assert.deepEqual(tools[0]!.args, { command: "ls" });
  assert.equal(tools[0]!.result?.content[0]?.type === "text" ? tools[0]!.result?.content[0].text : "", "done");
  assert.equal(messageItems(transcript).length, 1, "toolResult messages render through the tool item");
});

test("models nested child tools as separate subordinate activity", () => {
  const transcript = new Transcript();
  transcript.apply(ev({ type: "tool_execution_start", toolCallId: "outer", toolName: "codemode", args: {} }));
  transcript.apply(
    ev({
      type: "tool_execution_start",
      toolCallId: "inner",
      toolName: "read",
      args: { path: "x" },
      parentToolCallId: "outer",
    }),
  );
  transcript.apply(
    ev({ type: "tool_execution_end", toolCallId: "inner", toolName: "read", result: { content: [] }, isError: false }),
  );

  const tools = toolItems(transcript);
  assert.equal(tools.length, 2);
  const inner = tools.find((tool) => tool.id === "inner");
  assert.ok(inner);
  assert.equal(inner.parentToolCallId, "outer");
  assert.equal(inner.complete, true);
  const outer = tools.find((tool) => tool.id === "outer");
  assert.equal(outer?.parentToolCallId, undefined);
});

test("ignores unknown optional events without inventing history", () => {
  const transcript = new Transcript();
  transcript.apply(ev({ type: "compaction_start", reason: "threshold" }));
  transcript.apply(ev({ type: "queue_update", steering: [], followUp: [] }));
  transcript.apply(ev({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "x" }));
  transcript.apply(ev({ type: "brand_new_event_type", payload: { nested: true } }));

  assert.equal(transcript.items.length, 0);
  assert.equal(transcript.version, 0);
  assert.equal(transcript.lastAssistant(), undefined);
});

test("restore rebuilds user, assistant, custom, and bash messages from real messages only", () => {
  const user: AgentMessage = { role: "user", content: "do the thing", timestamp: 1 };
  const result: AgentMessage = {
    role: "toolResult",
    toolCallId: "call_9",
    toolName: "read",
    content: [{ type: "text", text: "file body" }],
    isError: false,
    timestamp: 3,
  };
  const custom: AgentMessage = { role: "custom", customType: "note", content: "note text", display: true, timestamp: 4 };
  const bash: AgentMessage = {
    role: "bashExecution",
    command: "ls",
    output: "a\nb",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: 5,
  };
  const withTool = assistant([{ type: "toolCall", id: "call_9", name: "read", arguments: { path: "a" } }], "toolUse");

  const transcript = new Transcript();
  transcript.restore([user, withTool, result, custom, bash]);

  assert.deepEqual(
    transcript.items.map((item) => (item.kind === "message" ? item.message.role : "tool")),
    ["user", "assistant", "tool", "custom", "bashExecution"],
  );
  const tool = toolItems(transcript)[0]!;
  assert.equal(tool.complete, true);
  assert.equal(tool.result?.content[0]?.type === "text" ? tool.result?.content[0].text : "", "file body");
  assert.equal(transcript.lastAssistant()?.content.length, 1);
  assert.equal(messageItems(transcript).length, 4);
});
