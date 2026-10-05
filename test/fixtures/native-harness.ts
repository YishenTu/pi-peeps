/**
 * In-process harness for test/native-delivery.test.ts.
 *
 * Wires the real ResultDelivery to a real Pi AgentSession + extension runtime
 * the same way src/index.ts does, but with:
 *   - a fake provider registered on an in-memory ModelRuntime
 *   - in-memory credential, model, settings, and session stores
 *   - a temporary cwd and agent dir
 *
 * No network, no real credentials, no user Pi configuration, no subprocess.
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";
import type { DeliveryStatus, Report, RunView } from "../../src/contracts.ts";
import { RESULT_TYPE, ResultDelivery } from "../../src/delivery.ts";

/** Identifiers the harness selects; the provider is always fake and local. */
export const PROVIDER = "peeps-native-probe";
export const MODEL_ID = "peeps-native-probe-1";
const API = "peeps-native-probe-api";

/** A deterministic in-test gate. No timers, no polling in provider code. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
export interface Gate {
  entered: Deferred<void>;
  release: Deferred<void>;
}
export function latch(): Gate {
  return { entered: deferred<void>(), release: deferred<void>() };
}

/** One scripted provider turn. A gate blocks the turn until the test releases it. */
export interface Plan {
  text?: string;
  gate?: Gate;
}

export interface RecordedRequest {
  index: number;
  beforeStarts: number;
  systemPrompt: string;
  messages: readonly Message[];
}

export interface SentRecord {
  message: { customType: string; content: unknown; display?: boolean; details?: unknown };
  options: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } | undefined;
}

export interface CustomNoticeMessage {
  role: "custom";
  customType: string;
  content: unknown;
  display?: boolean;
  details?: unknown;
}

export interface SceneOptions {
  plans?: Plan[];
}

export interface Scene {
  session: AgentSession;
  requests: RecordedRequest[];
  sent: SentRecord[];
  inputSources: string[];
  readonly beforeStarts: number;
  readonly settles: number;
  readonly starts: number;
  readonly owner: string;
  readonly sessionId: string;
  readonly wiredOnLoad: boolean;
  readonly delivery: ResultDelivery | undefined;
  /** Create/track a completed run. */
  run(id: string, finalText: string, overrides?: Partial<RunView>): RunView;
  /** Offer a tracked run to the wired ResultDelivery. */
  offer(run: RunView, anchor?: string | null): void;
  notices(): CustomNoticeMessage[];
  waitFor(predicate: () => boolean, what: string, timeoutMs?: number): Promise<void>;
  tick(): Promise<void>;
}

const USAGE: Usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The report RunManager would send for this view's answer. */
export function toOutcome(run: RunView): Report {
  return { runId: run.id, seq: run.reports, status: "answer", text: run.finalText ?? "" };
}

export function tick(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Plain text of a provider message, without depending on provider-owned structures. */
export function textOf(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
    })
    .join("");
}

async function awaitGate(gate: Gate | undefined, signal: AbortSignal | undefined): Promise<void> {
  if (!gate) return;
  gate.entered.resolve(undefined);
  if (signal?.aborted) throw new Error("aborted");
  const aborted = deferred<never>();
  const onAbort = () => aborted.reject(new Error("aborted"));
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([gate.release.promise, aborted.promise]);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function createScene(t: TestContext, options: SceneOptions = {}): Promise<Scene> {
  const sandbox = await mkdtemp(join(tmpdir(), "peeps-native-delivery-"));
  const agentDir = join(sandbox, "agent");
  const cwd = join(sandbox, "cwd");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  process.env.PI_OFFLINE = "1";
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const plans = options.plans ?? [];
  const requests: RecordedRequest[] = [];
  const sent: SentRecord[] = [];
  const inputSources: string[] = [];
  const errors: unknown[] = [];
  const runs = new Map<string, RunView>();
  let beforeStarts = 0;
  let starts = 0;
  let settles = 0;
  let extensionAPI: ExtensionAPI | undefined;
  let wiredOnLoad = false;
  let current: { delivery: ResultDelivery; owner: string } | undefined;
  let owner = "";
  let sessionId = "";

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const streamSimple = (
    model: Model<Api>,
    context: TranscriptContext,
    streamOptions?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const index = requests.length;
    const plan = plans[index] ?? { text: "answer-" + (index + 1) };
    requests.push({
      index,
      beforeStarts,
      systemPrompt: getCurrentSystemPrompt(context.messages),
      messages: structuredClone(context.messages) as Message[],
    });
    const message: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      stopReason: "pending",
      content: [],
      usage: USAGE,
    };
    void (async () => {
      try {
        stream.push({ type: "start", partial: message });
        const text = plan.text ?? "answer-" + (index + 1);
        message.content.push({ type: "text", text });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
        await awaitGate(plan.gate, streamOptions?.signal);
        if (streamOptions?.signal?.aborted) throw new Error("aborted");
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
        message.stopReason = "stop";
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      } catch (error) {
        message.stopReason = streamOptions?.signal?.aborted ? "aborted" : "error";
        message.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({
          type: "error",
          reason: message.stopReason === "aborted" ? "aborted" : "error",
          error: message,
        });
        stream.end(message);
      }
    })();
    return stream;
  };
  runtime.registerProvider(PROVIDER, {
    name: "Peeps native-delivery probe",
    baseUrl: "https://example.invalid",
    apiKey: "fake-not-a-credential",
    api: API,
    models: [
      {
        id: MODEL_ID,
        name: "Peeps native-delivery probe",
        reasoning: false,
        input: ["text"],
        contextWindow: 100_000,
        maxTokens: 1_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple,
  });

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
    steeringMode: "all",
  });

  const wire = (ctx: ExtensionContext): void => {
    if (current) return;
    const manager = ctx.sessionManager;
    owner = manager.getSessionId();
    sessionId = owner;
    let self: { delivery: ResultDelivery; owner: string };
    const delivery = new ResultDelivery({
      owner,
      active: (anchor) =>
        current === self && (anchor === null || manager.getBranch().some((entry) => entry.id === anchor)),
      branch: () => manager.getBranch(),
      send: (message, sendOptions) => {
        sent.push({ message, options: sendOptions });
        extensionAPI?.sendMessage(message, sendOptions);
      },
      update: (id, _turn, status: DeliveryStatus) => {
        const run = runs.get(id);
        if (run) run.delivery = status;
      },
    });
    self = { delivery, owner };
    current = self;
  };

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "BASE_INSTRUCTION: isolated native delivery test.",
    extensionFactories: [
      (pi) => {
        extensionAPI = pi;
        wiredOnLoad = current !== undefined;
        pi.on("session_start", (_event, ctx) => {
          wire(ctx);
        });
        pi.on("session_shutdown", () => {
          const previous = current;
          current = undefined;
          previous?.delivery.close();
        });
        pi.on("agent_start", (_event, ctx) => {
          wire(ctx);
          starts++;
          current?.delivery.watch(ctx.signal);
        });
        pi.on("input", (event) => {
          inputSources.push(event.source);
          current?.delivery.input(event.source);
        });
        pi.on("before_agent_start", () => {
          beforeStarts++;
          current?.delivery.beforeAgentStart();
          current?.delivery.reconcile();
        });
        pi.on("message_end", (event) => {
          if (event.message.role === "custom" && event.message.customType === RESULT_TYPE) {
            const snapshot = current;
            setImmediate(() => {
              if (current === snapshot) snapshot?.delivery.reconcile();
            });
          }
        });
        pi.on("agent_settled", () => {
          current?.delivery.reconcile(true);
        });
      },
    ],
  });
  await loader.reload();
  const model = runtime.getModel(PROVIDER, MODEL_ID);
  if (!model) throw new Error("probe model was not registered");

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "all",
  });
  await session.bindExtensions({
    mode: "json",
    onError: (error) => errors.push(error),
  });
  session.subscribe((event) => {
    if (event.type === "agent_settled") settles++;
  });

  t.after(async () => {
    current?.delivery.close();
    current = undefined;
    await session.abort();
    session.dispose();
    await rm(sandbox, { recursive: true, force: true });
  });

  const scene: Scene = {
    session,
    requests,
    sent,
    inputSources,
    get beforeStarts() {
      return beforeStarts;
    },
    get settles() {
      return settles;
    },
    get starts() {
      return starts;
    },
    get owner() {
      return owner;
    },
    get sessionId() {
      return sessionId;
    },
    get wiredOnLoad() {
      return wiredOnLoad;
    },
    get delivery() {
      return current?.delivery;
    },
    run(id, finalText, overrides = {}) {
      const run: RunView = {
        id,
        label: id,
        task: "native delivery task",
        status: "idle",
        model: { provider: PROVIDER, id: MODEL_ID },
        thinking: "off",
        createdAt: Date.now(),
        finishedAt: Date.now(),
        activity: "Idle",
        reports: 1,
        finalText,
        delivery: "none",
        transcript: { items: [], version: 0 },
        ...overrides,
      };
      runs.set(id, run);
      return run;
    },
    offer(run, anchor = null) {
      current?.delivery.offer(toOutcome(run), anchor);
    },
    notices() {
      return session.messages.filter(
        (message) =>
          message.role === "custom" && (message as { customType?: string }).customType === RESULT_TYPE,
      ) as CustomNoticeMessage[];
    },
    async waitFor(predicate, what, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for " + what);
        await tick();
      }
    },
    tick,
  };
  return scene;
}
