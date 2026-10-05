/**
 * Scripted test provider extension for test/integration.test.ts.
 *
 * This is a real Pi extension. It registers one legacy provider whose
 * `streamSimple` implementation never touches the network, the user's Pi
 * configuration, or any credentials. Every response is decided locally from
 * the request context:
 *
 * - The first model request in a session emits a `peeps_gate` tool call. That
 *   tool blocks until <PEEPS_TEST_DIR>/release exists (bounded), which gives the
 *   parent test a deterministic window to steer the child mid-task.
 * - Once the transcript already contains a tool result (the gate returned) or a
 *   user message carrying the steering token, the provider emits the exact
 *   configured final text with stop reason "stop".
 * - A latest user message starting with "FOLLOWUP:" is answered with
 *   "REPLY " + that message, so follow-up turns are distinguishable.
 *
 * It also registers `peeps_gate`, a test-only tool. The regression guard under
 * test is that the real Peeps extension no-ops inside a child, so none of its
 * tools are declared here.
 *
 * Env:
 *   PEEPS_TEST_DIR     required. Directory for the request log, child pid, gate
 *                      markers, and the release file.
 *   PEEPS_SCRIPT_JSON  JSON { finalText, steerToken, gateTag }.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  Tool,
  ToolCall,
  TranscriptContext,
  Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Provider/model identifiers the integration test selects. */
export const SCRIPTED_PROVIDER = "peeps-scripted";
export const SCRIPTED_MODEL = "peeps-scripted-1";
const SCRIPTED_API = "peeps-scripted-api";

/** Test-only blocking tool name. */
export const GATE_TOOL_NAME = "peeps_gate";
/** Provider-side identifier for the low-level API implementation. */
export const GATE_TOOL_TAG = "peeps-gate";

const GATE_TIMEOUT_MS = 30_000;
const GATE_POLL_MS = 20;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const USAGE: Usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: ZERO_COST,
};

interface ScriptSpec {
  finalText: string;
  steerToken: string;
  gateTag: string;
}

function testDir(): string {
  return process.env.PEEPS_TEST_DIR ?? "";
}

function readSpec(): ScriptSpec {
  const raw = process.env.PEEPS_SCRIPT_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<ScriptSpec>;
      return {
        finalText: typeof parsed.finalText === "string" ? parsed.finalText : "SCRIPTED-FINAL",
        steerToken: typeof parsed.steerToken === "string" ? parsed.steerToken : "STEER-TOKEN",
        gateTag: typeof parsed.gateTag === "string" ? parsed.gateTag : GATE_TOOL_TAG,
      };
    } catch {
      // Fall through to defaults.
    }
  }
  return { finalText: "SCRIPTED-FINAL", steerToken: "STEER-TOKEN", gateTag: GATE_TOOL_TAG };
}

/** Plain text of a content value, without reading provider-owned structures. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const value = block as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? value.text : "";
    })
    .join("");
}

function baseAssistant(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: USAGE,
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function finishText(stream: AssistantMessageEventStream, model: Model<Api>, text: string): void {
  const start = baseAssistant(model);
  stream.push({ type: "start", partial: start });
  const empty: AssistantMessage = { ...start, content: [{ type: "text", text: "" }] };
  stream.push({ type: "text_start", contentIndex: 0, partial: empty });
  const complete: AssistantMessage = { ...start, content: [{ type: "text", text }] };
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: complete });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: complete });
  const done: AssistantMessage = { ...complete, stopReason: "stop" };
  stream.push({ type: "done", reason: "stop", message: done });
  stream.end(done);
}

function requestTool(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  tag: string,
): void {
  const start = baseAssistant(model);
  stream.push({ type: "start", partial: start });
  const call: ToolCall = { type: "toolCall", id: `call_${Date.now().toString(36)}`, name: GATE_TOOL_NAME, arguments: { tag } };
  const empty: AssistantMessage = { ...start, content: [{ ...call, arguments: {} }] };
  stream.push({ type: "toolcall_start", contentIndex: 0, partial: empty });
  const partial: AssistantMessage = { ...start, content: [call] };
  stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(call.arguments), partial });
  stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial });
  const done: AssistantMessage = { ...partial, stopReason: "toolUse" };
  stream.push({ type: "done", reason: "toolUse", message: done });
  stream.end(done);
}

let callCount = 0;

function streamSimple(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const spec = readSpec();
  const index = callCount++;
  const dir = testDir();

  const messages = context.messages.map((message) => ({
    role: message.role,
    text: contentText((message as { content?: unknown }).content),
  }));
  const tools: string[] = getCurrentTools(context.messages).map((tool: Tool) => tool.name);

  if (dir) {
    const record = {
      index,
      model: { provider: model.provider, id: model.id },
      tools,
      messages,
      systemPrompt: getCurrentSystemPrompt(context.messages),
    };
    appendFileSync(join(dir, "requests.jsonl"), `${JSON.stringify(record)}\n`);
  }

  const hasSteer = messages.some(
    (message) => message.role === "user" && message.text.includes(spec.steerToken),
  );
  const sawToolResult = messages.some((message) => message.role === "toolResult");
  const sawAssistant = messages.some((message) => message.role === "assistant");
  const finalTurn = hasSteer || sawToolResult || sawAssistant;
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const followUp = lastUser?.text.startsWith("FOLLOWUP:") ? "REPLY " + lastUser.text : undefined;

  void (async () => {
    try {
      await options?.onPayload?.({ provider: model.provider, model: model.id }, model);
      await options?.onResponse?.({ status: 200, headers: {} }, model);
      if (options?.signal?.aborted) {
        const aborted: AssistantMessage = {
          ...baseAssistant(model),
          stopReason: "aborted",
          errorMessage: "Scripted provider request was aborted",
        };
        stream.push({ type: "error", reason: "aborted", error: aborted });
        stream.end(aborted);
        return;
      }
      if (followUp) {
        finishText(stream, model, followUp);
      } else if (finalTurn) {
        finishText(stream, model, spec.finalText);
      } else {
        requestTool(stream, model, spec.gateTag);
      }
    } catch (error) {
      const failed: AssistantMessage = {
        ...baseAssistant(model),
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
      stream.push({ type: "error", reason: "error", error: failed });
      stream.end(failed);
    }
  })();

  return stream;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export default function scriptedProviderExtension(pi: ExtensionAPI): void {
  const dir = testDir();
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "child.pid"), String(process.pid));
  }

  pi.registerProvider(SCRIPTED_PROVIDER, {
    name: "Peeps Scripted Test Provider",
    baseUrl: "http://127.0.0.1:0",
    // A literal key: no credential env, no auth file, no network.
    apiKey: "peeps-scripted-fake-key",
    api: SCRIPTED_API,
    models: [
      {
        id: SCRIPTED_MODEL,
        name: "Peeps Scripted Model",
        reasoning: false,
        input: ["text"],
        cost: ZERO_COST,
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ],
    streamSimple,
  });

  pi.registerTool({
    name: GATE_TOOL_NAME,
    label: "Scripted gate",
    description:
      "Test-only blocking tool. Waits, bounded, until the release file exists, then returns.",
    parameters: Type.Object({ tag: Type.String() }),
    async execute(_id, params, signal, _update, _ctx) {
      const directory = testDir();
      if (!directory) throw new Error("PEEPS_TEST_DIR is not set");
      writeFileSync(join(directory, "gate-started"), params.tag);
      const release = join(directory, "release");
      const deadline = Date.now() + GATE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error("gate aborted");
        if (existsSync(release)) {
          return { content: [{ type: "text" as const, text: "released" }], details: { released: true } };
        }
        await delay(GATE_POLL_MS);
      }
      throw new Error("gate timed out waiting for release");
    },
  });
}
