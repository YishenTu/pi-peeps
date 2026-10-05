import { Type } from "typebox";
import type { JsonValue } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
  getAgentDir, getPackageDir,
  type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readArchive, readRunRecords } from "./archive.ts";
import { buildLaunch, validateChildState } from "./launch.ts";
import { RpcProcess } from "./rpc-process.ts";
import { RunManager } from "./run-manager.ts";
import { RESULT_TYPE, ResultDelivery, type ResultDetails } from "./delivery.ts";
import { closeAllViewers, mountOverview, openViewer } from "./ui/index.ts";
import type { RunView } from "./contracts.ts";

const thinking = Type.Union([
  Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"),
  Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
]);
const output = Type.Record(Type.String(), Type.Unknown());
function result<T extends Record<string, unknown>>(value: T) {
  const text = JSON.stringify(value);
  return { content: [{ type: "text" as const, text }], details: value, structuredContent: JSON.parse(text) as JsonValue };
}
function summary(run: RunView) {
  return { id: run.id, label: run.label, status: run.status, model: run.model, thinking: run.thinking,
    activity: run.activity, reports: run.reports, resumable: !!run.sessionId, delivery: run.delivery, createdAt: run.createdAt,
    finishedAt: run.finishedAt, sessionFile: run.sessionFile, error: run.error };
}
/** Idle children close to free their process; the next message resumes them. */
const IDLE_CLOSE_MS = 10 * 60_000;
interface Runtime {
  owner: string;
  manager: RunManager;
  delivery: ResultDelivery;
  disposeWidget(): void;
}

/** File-loaded Pi extension. It deliberately does nothing inside a Peeps child. */
export default function peeps(pi: ExtensionAPI): void {
  if (process.env.PI_PEEPS_CHILD === "1") return;
  let runtime: Runtime | undefined;
  let viewerOpen = false;

  async function stop(): Promise<void> {
    const old = runtime;
    runtime = undefined;
    if (!old) return;
    old.delivery.close();
    try {
      closeAllViewers();
      old.disposeWidget();
    } finally {
      // Presentation failures must not prevent (or outlive) child shutdown.
      await old.manager.close();
    }
  }
  function start(ctx: ExtensionContext): Runtime {
    if (runtime) return runtime;
    const owner = ctx.sessionManager.getSessionId();
    let instance: Runtime;
    const alive = () => runtime === instance && ctx.sessionManager.getSessionId() === owner;
    const agentDir = getAgentDir();
    const manager = new RunManager({
      owner,
      createChild: async (run, resume) => {
        const spec = await buildLaunch({
          cwd: ctx.cwd, ownerId: owner, persistent: !!ctx.sessionManager.getSessionFile(),
          trusted: ctx.isProjectTrusted(), agentDir, packageDir: getPackageDir(),
          argv: process.argv, env: process.env, executable: process.execPath,
        }, run, resume);
        return {
          connection: new RpcProcess(spec.options),
          validateState: state => validateChildState(state, run, spec.runDir, resume),
        };
      },
      idleCloseMs: IDLE_CLOSE_MS,
      readArchive: file => readArchive(file, agentDir),
      record: record => { if (alive()) pi.appendEntry("peeps/run", record); },
      report: (report, anchor) => { if (alive()) instance.delivery.offer(report, anchor); },
      warn: message => { if (alive() && ctx.mode === "tui") ctx.ui.notify(message, "warning"); },
    }, readRunRecords(ctx.sessionManager.getBranch()));
    const delivery = new ResultDelivery({
      owner,
      active: anchor => alive() && (anchor === null || ctx.sessionManager.getBranch().some(e => e.id === anchor)),
      branch: () => ctx.sessionManager.getBranch(),
      send: (message, options) => pi.sendMessage(message, options),
      update: (id, seq, state) => manager.setDelivery(id, seq, state),
    });
    instance = { owner, manager, delivery, disposeWidget: () => {} };
    runtime = instance;
    if (ctx.mode === "tui") instance.disposeWidget = mountOverview(ctx, manager);
    return instance;
  }
  function requireTui(ctx: ExtensionContext): Runtime {
    if (ctx.mode !== "tui") throw new Error("Peeps v0.1 requires a TUI parent. RPC/print parents are not supported.");
    return start(ctx);
  }
  async function view(ctx: ExtensionContext, id?: string): Promise<void> {
    if (ctx.mode !== "tui") { ctx.ui.notify("Peeps viewer requires the terminal UI.", "warning"); return; }
    if (viewerOpen) return;
    const active = start(ctx);
    if (id && !active.manager.get(id)) throw new Error(`Unknown peep: ${id}`);
    viewerOpen = true;
    try { await openViewer(ctx, active.manager, id); }
    finally { viewerOpen = false; }
  }

  pi.on("session_start", async (_event, ctx) => { await stop(); start(ctx); });
  pi.on("session_shutdown", async () => { await stop(); });
  // Conservative: even if another extension cancels navigation, old work is not resumed.
  pi.on("session_before_tree", async (_event, ctx) => {
    await stop();
    start(ctx); // Historical overview remains usable if another handler cancels navigation.
  });
  pi.on("session_tree", async (_event, ctx) => { await stop(); start(ctx); });
  pi.on("agent_start", (_event, ctx) => { runtime?.delivery.watch(ctx.signal); });
  pi.on("input", (event) => { runtime?.delivery.input(event.source); });
  pi.on("before_agent_start", () => { runtime?.delivery.beforeAgentStart(); runtime?.delivery.reconcile(); });
  pi.on("message_end", (event) => {
    if (event.message.role === "custom" && event.message.customType === RESULT_TYPE) {
      const current = runtime;
      // message_end can precede session persistence.
      setImmediate(() => { if (runtime === current) current?.delivery.reconcile(); });
    }
  });
  pi.on("agent_settled", () => { runtime?.delivery.reconcile(true); });

  pi.registerTool({
    name: "peeps_spawn", label: "Spawn peep", outputSchema: output,
    description: "Start a fresh Pi agent in the same cwd with the task as its first message, and return immediately. No parent transcript is inherited. Whenever it finishes working, its exact final answer arrives automatically as an automated Peeps notice. It keeps its conversation: peeps_send continues it at any time, even after it was closed or this session was reloaded. Children may edit shared files; avoid conflicting assignments. Only TUI parents are supported.",
    promptSnippet: "Delegate a self-contained task to a fresh background Pi agent.",
    promptGuidelines: ["Give peeps self-contained context. Do not poll: answers arrive automatically. Use peeps_send to redirect or continue a child, peeps_interrupt to stop its current work, and peeps_close when you are done with it."],
    parameters: Type.Object({
      task: Type.String({ minLength: 1 }), label: Type.Optional(Type.String({ maxLength: 100 })),
      model: Type.Optional(Type.Object({ provider: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) })),
      thinking: Type.Optional(thinking),
    }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const active = requireTui(ctx);
      const model = params.model ?? (ctx.model && { provider: ctx.model.provider, id: ctx.model.id });
      if (!model) throw new Error("Select a model before spawning a peep.");
      active.delivery.watch(ctx.signal);
      const run = active.manager.spawn(params, { model, thinking: ctx.thinkingLevel ?? "off" }, ctx.sessionManager.getLeafId());
      return result({ ...summary(run), note: "Accepted. Answers arrive automatically; opening the viewer does not control execution." });
    },
  });
  pi.registerTool({
    name: "peeps_send", label: "Message peep", outputSchema: output,
    description: "Send a message to a child, like typing into its Pi session. A working child is steered; an idle one starts working again with its conversation intact; a closed one is resumed first. Returns once Pi admits the message; any resulting answer arrives automatically as another Peeps notice.",
    parameters: Type.Object({ id: Type.String(), message: Type.String({ minLength: 1 }) }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const active = requireTui(ctx);
      active.delivery.watch(ctx.signal);
      const admission = await active.manager.send(params.id, params.message);
      return result({ ...summary(active.manager.get(params.id)!), admission: admission ?? null });
    },
  });
  pi.registerTool({
    name: "peeps_interrupt", label: "Interrupt peep", outputSchema: output,
    description: "Stop a child's current work but keep it and its conversation, like pressing Escape in Pi. Messages still queued for it are discarded and returned. No notice follows.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const active = requireTui(ctx);
      const outcome = await active.manager.interrupt(params.id);
      return result({ ...summary(active.manager.get(params.id)!), ...outcome });
    },
  });
  pi.registerTool({
    name: "peeps_inspect", label: "Inspect peeps", outputSchema: output,
    description: "Read Peeps status or a bounded page of the latest answer. Normally use automatic notices rather than polling. Human live transcripts are available in /peeps. Omit id to list up to 100 recent children.",
    parameters: Type.Object({
      id: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const active = start(ctx);
      if (!params.id) {
        const runs = active.manager.list();
        return result({ runs: runs.slice(-100).map(summary), total: runs.length });
      }
      const run = active.manager.get(params.id);
      if (!run) throw new Error(`Unknown peep: ${params.id}`);
      const release = active.manager.retainTranscript(run.id);
      try {
        let transcriptError: string | undefined;
        try { await active.manager.loadTranscript(run.id); }
        catch (error) { transcriptError = String(error); }
        const { text, kind: textKind } = active.manager.answer(run.id);
        const offset = params.offset ?? 0, limit = params.limit ?? 8000;
        return result({ ...summary(run), text: text.slice(offset, offset + limit), offset, totalChars: text.length,
          hasMore: offset + limit < text.length, transcriptItems: run.transcript.items.length, transcriptError, textKind });
      } finally { release(); }
    },
  });
  pi.registerTool({
    name: "peeps_close", label: "Close peeps", outputSchema: output,
    description: "Close one child or all children (id: all), aborting any work in progress and freeing its process. Idempotent; no notice follows. A later peeps_send resumes it. Shared file edits are not rolled back.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      await requireTui(ctx).manager.closeChild(params.id);
      return result({ id: params.id, closed: true });
    },
  });
  pi.registerCommand("peeps", {
    description: "Read-only Peeps overview/thread viewer; /peeps <id>, /peeps interrupt <id>, /peeps close <id|all>",
    async handler(args, ctx) {
      try {
        const words = args.trim().split(/\s+/).filter(Boolean);
        if (words[0] === "close") {
          if (words.length !== 2) throw new Error("Usage: /peeps close <id|all>");
          await requireTui(ctx).manager.closeChild(words[1]!);
        } else if (words[0] === "interrupt") {
          if (words.length !== 2) throw new Error("Usage: /peeps interrupt <id>");
          await requireTui(ctx).manager.interrupt(words[1]!);
        } else {
          if (words.length > 1) throw new Error("Usage: /peeps [id]");
          await view(ctx, words[0]);
        }
      } catch (error) { ctx.ui.notify(String(error), "error"); }
    },
  });
  pi.registerShortcut("ctrl+shift+a", { description: "Open Peeps", handler: ctx => view(ctx) });
  pi.registerMessageRenderer<ResultDetails>(RESULT_TYPE, (message, options, theme) => {
    const details = message.details;
    const title = theme.fg("accent", `Peeps · ${details?.runId?.slice(0, 8) ?? "result"} · ${details?.status ?? "answer"}`);
    const text = typeof message.content === "string" ? message.content : message.content.filter(b => b.type === "text").map(b => b.text).join("");
    return new Text(options.expanded ? `${title}\n${text}` : `${title}\n${theme.fg("dim", "Automated child result · expand for full text · /peeps for thread")}`, options.outputPad, 0);
  });
}
