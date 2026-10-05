/**
 * End-to-end RPC integration tests for Peeps.
 *
 * These tests launch a real `pi --mode rpc` child through the same public
 * contracts production uses:
 *
 *   buildLaunch -> RpcProcess -> RunManager -> archive read-back
 *
 * The child is fully isolated: a temporary agent directory, an empty temporary
 * working directory, a scripted in-process provider extension, and credential
 * environment variables removed. No credentials are read and no network request
 * is made. The child never inherits this repository's Pi configuration or the
 * real Peeps extension's tools.
 *
 * Covered here:
 *   - fresh child context (no parent transcript)
 *   - the regression guard that stops nested Peeps tools
 *   - exact final assistant text
 *   - a message to a working child steers natively and is observed by a later model request
 *   - a message to an idle child starts new work with its conversation intact
 *   - native child session archive read-back (direct and via RunManager)
 *   - closing a child, idle or working, with no orphaned process
 *   - interrupting a real child, and resuming its own session after close and a parent reload
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { readArchive } from "../src/archive.ts";
import type { RunRecord } from "../src/archive.ts";
import { buildLaunch, PEEPS_TOOL_NAMES, validateChildState } from "../src/launch.ts";
import type { LaunchContext } from "../src/launch.ts";
import { RpcProcess } from "../src/rpc-process.ts";
import { RunManager, type ManagerOptions } from "../src/run-manager.ts";
import type { ModelChoice, RunView } from "../src/contracts.ts";
import { GATE_TOOL_NAME, SCRIPTED_MODEL, SCRIPTED_PROVIDER } from "./fixtures/scripted-provider.ts";

const FIXTURE_EXTENSION = fileURLToPath(new URL("./fixtures/scripted-provider.ts", import.meta.url));
/** The real Peeps extension: loaded explicitly so the child guard is exercised. */
const PEEPS_EXTENSION = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const PACKAGE_DIR = getPackageDir();

const OWNER = "peeps-integration-owner";

/**
 * Exact child arguments: only the scripted provider and the real Peeps
 * extension load, discovered resources stay off, and the task never reaches
 * argv. Explicit --extension paths are still honored under --no-extensions.
 */
const CHILD_ARGV: string[] = [
  process.execPath,
  join(PACKAGE_DIR, "dist", "cli.js"),
  "--no-extensions",
  "--extension",
  FIXTURE_EXTENSION,
  "--extension",
  PEEPS_EXTENSION,
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
];

function childLaunchContext(
  agentDir: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
  persistent: boolean,
): LaunchContext {
  return {
    cwd: workspace,
    ownerId: OWNER,
    persistent,
    trusted: false,
    agentDir,
    packageDir: PACKAGE_DIR,
    argv: CHILD_ARGV,
    env,
    executable: process.execPath,
  };
}

async function writeAgentSettings(agentDir: string): Promise<void> {
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify(
      {
        defaultProvider: SCRIPTED_PROVIDER,
        defaultModel: SCRIPTED_MODEL,
        defaultThinkingLevel: "off",
        cacheWarming: "off",
        compaction: { enabled: false },
      },
      null,
      2,
    ),
  );
}

const MODEL: ModelChoice = { provider: SCRIPTED_PROVIDER, id: SCRIPTED_MODEL };

/** Generous but bounded: every model call is local and scripted. */
const TEST_TIMEOUT_MS = 120_000;
const START_TIMEOUT_MS = 60_000;

interface ScriptSpec {
  finalText: string;
  steerToken: string;
  gateTag: string;
}

interface RequestRecord {
  index: number;
  model: { provider: string; id: string };
  tools: string[];
  messages: { role: string; text: string }[];
  systemPrompt: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = START_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await delay(25);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function roleOf(message: AgentMessage): string {
  return String((message as { role?: unknown }).role ?? "");
}

function textOf(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
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

/** Child environment: isolated script state and no ambient credentials. */
function childEnv(testDir: string, spec: ScriptSpec): NodeJS.ProcessEnv {
  return {
    PEEPS_TEST_DIR: testDir,
    PEEPS_SCRIPT_JSON: JSON.stringify(spec),
    // Undefined removes an inherited variable from the merged child env.
    ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    GOOGLE_API_KEY: undefined,
    GEMINI_API_KEY: undefined,
    GOOGLE_GENERATIVE_AI_API_KEY: undefined,
    OPENROUTER_API_KEY: undefined,
    MISTRAL_API_KEY: undefined,
    GROQ_API_KEY: undefined,
    XAI_API_KEY: undefined,
    GITLAB_TOKEN: undefined,
    AWS_ACCESS_KEY_ID: undefined,
    AWS_SECRET_ACCESS_KEY: undefined,
  };
}

interface Harness {
  manager: RunManager;
  /** Production manager options, for constructing a reloaded parent's manager. */
  options: ManagerOptions;
  agentDir: string;
  workspace: string;
  testDir: string;
  records: RunRecord[];
  outcomes: Map<string, { status: string; anchor: string | null }>;
  warnings: string[];
  /** Each report is numbered per child. */
  outcomeFor(id: string, seq?: number): Promise<{ status: string; anchor: string | null }>;
  readRequests(): Promise<RequestRecord[]>;
  close(): Promise<void>;
}

async function createHarness(root: string, spec: ScriptSpec): Promise<Harness> {
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  const testDir = join(root, "script");
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(testDir, { recursive: true }),
  ]);
  await writeAgentSettings(agentDir);

  const env = childEnv(testDir, spec);
  const records: RunRecord[] = [];
  const warnings: string[] = [];
  const outcomes = new Map<string, { status: string; anchor: string | null }>();
  const waiters = new Map<string, () => void>();

  const options: ManagerOptions = {
    owner: OWNER,
    createChild: async (run, resume) => {
      const launch = await buildLaunch(childLaunchContext(agentDir, workspace, env, true), run, resume);
      return {
        connection: new RpcProcess(launch.options),
        validateState: (state) => validateChildState(state, run, launch.runDir, resume),
      };
    },
    readArchive: (file) => readArchive(file, agentDir),
    record: (record) => {
      records.push(record);
    },
    report: (result, anchor) => {
      const key = `${result.runId}#${result.seq}`;
      outcomes.set(key, { status: result.status, anchor });
      waiters.get(key)?.();
      waiters.delete(key);
    },
    warn: (message) => {
      warnings.push(message);
    },
  };
  const manager = new RunManager(options);

  return {
    manager,
    options,
    agentDir,
    workspace,
    testDir,
    records,
    outcomes,
    warnings,
    outcomeFor(id, seq = 1) {
      const key = `${id}#${seq}`;
      const existing = outcomes.get(key);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        waiters.set(key, () => {
          resolve(outcomes.get(key) as { status: string; anchor: string | null });
        });
      });
    },
    async readRequests() {
      const path = join(testDir, "requests.jsonl");
      if (!existsSync(path)) return [];
      const content = await readFile(path, "utf8");
      return content
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as RequestRecord);
    },
    async close() {
      await manager.close();
    },
  };
}

function nonSystemMessages(record: RequestRecord): { role: string; text: string }[] {
  return record.messages.filter((message) => message.role !== "system");
}

test("RPC child has fresh context, steers natively, returns exact text, follows up, archives, and leaves no orphan", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "peeps-integration-happy-"));
  const nonce = root.slice(-8);
  const spec: ScriptSpec = {
    finalText: `FINAL-${nonce} \u2014 \u00e9\ud83c\udfaf\n\n  trailing spaces  `,
    steerToken: `STEER-${nonce}`,
    gateTag: `gate-${nonce}`,
  };
  const harness = await createHarness(root, spec);
  t.after(async () => {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  });

  const task = `TASK-${nonce}: wait at the gate, then report.`;
  const run = harness.manager.spawn({ task }, { model: MODEL, thinking: "off" }, null);

  // The gate tool starts inside a real agent turn, so steering is a native
  // mid-run steer rather than a queued follow-up.
  await waitFor(
    () => existsSync(join(harness.testDir, "gate-started")),
    "scripted gate tool never started",
  );
  assert.equal(harness.manager.get(run.id)?.status, "working");

  const admission = (await harness.manager.send(run.id, spec.steerToken)) as { disposition?: string };
  assert.equal(admission.disposition, "queued", "a message to a working child must queue as native steering");

  // Release only after admission so the steer is guaranteed to reach the next model request.
  await writeFile(join(harness.testDir, "release"), "go");

  const outcome = await harness.outcomeFor(run.id);
  assert.equal(outcome.status, "answer", `warnings: ${harness.warnings.join(" | ")}`);

  const view = harness.manager.get(run.id) as RunView;
  assert.equal(view.status, "idle", "a finished run leaves the child alive for more messages");
  assert.equal(view.error, undefined);
  assert.equal(view.finalText, spec.finalText, "final text must be exact, with whitespace and Unicode");
  const pid = Number(await readFile(join(harness.testDir, "child.pid"), "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.ok(processAlive(pid), "idle child keeps its process and context");

  // The same call to an idle child starts new work with its context intact.
  const followUp = `FOLLOWUP: ${nonce} again`;
  const restarted = (await harness.manager.send(run.id, followUp)) as { disposition?: string };
  assert.notEqual(restarted.disposition, "handled");
  const second = await harness.outcomeFor(run.id, 2);
  assert.equal(second.status, "answer", `warnings: ${harness.warnings.join(" | ")}`);
  assert.equal(view.reports, 2);
  assert.equal(view.status, "idle");
  assert.equal(view.finalText, `REPLY ${followUp}`);

  const requests = await harness.readRequests();
  assert.ok(requests.length >= 2, `expected at least two model requests, got ${requests.length}`);

  // Fresh context: only the task user message, no parent transcript.
  const first = requests[0] as RequestRecord;
  const last = requests[requests.length - 1] as RequestRecord;
  const lastMessages = nonSystemMessages(last);
  assert.equal(lastMessages[0]?.text, task, "the follow-up turn keeps the original conversation");
  assert.ok(lastMessages.some((message) => message.role === "assistant" && message.text === spec.finalText));
  assert.equal(lastMessages.at(-1)?.text, followUp);
  const firstMessages = nonSystemMessages(first);
  assert.deepEqual(firstMessages.map((message) => message.role), ["user"]);
  assert.equal(firstMessages[0]?.text, task);
  assert.equal(first.model.provider, SCRIPTED_PROVIDER);
  assert.equal(first.model.id, SCRIPTED_MODEL);
  assert.ok(!first.systemPrompt.includes(task), "task must not be duplicated into the child system prompt");

  // Regression guard: the Peeps extension is loaded but must no-op in the child.
  assert.ok(first.tools.includes(GATE_TOOL_NAME), `expected ${GATE_TOOL_NAME} in ${first.tools.join(",")}`);
  for (const name of PEEPS_TOOL_NAMES) {
    assert.ok(!first.tools.includes(name), `nested Peeps tool leaked into the child: ${name}`);
  }

  // Native steering: the token arrives in exactly one later request, after the gate tool result.
  assert.ok(!first.messages.some((message) => message.text.includes(spec.steerToken)));
  const steered = requests.filter((record) =>
    record.messages.some((message) => message.role === "user" && message.text.includes(spec.steerToken))
    && !record.messages.some((message) => message.text === followUp),
  );
  assert.equal(steered.length, 1, "steering must be observed by exactly one subsequent model request");
  const steeredRequest = steered[0] as RequestRecord;
  assert.ok(steeredRequest.index >= 1);
  assert.ok(steeredRequest.messages.some((message) => message.role === "toolResult"), "steering must follow the tool result");

  // Native archive read-back from the persisted child session.
  assert.equal(typeof view.sessionFile, "string");
  const sessionFile = view.sessionFile as string;
  assert.ok(
    sessionFile.startsWith(join(harness.agentDir, "peeps") + sep),
    `session archive must live under the isolated agent dir: ${sessionFile}`,
  );
  const archived = await readArchive(sessionFile, harness.agentDir);
  const archivedAssistant = archived.filter((message) => roleOf(message) === "assistant").map(textOf);
  assert.ok(archivedAssistant.includes(spec.finalText), "archive must contain the exact final text");
  assert.ok(archived.some((message) => roleOf(message) === "user" && textOf(message) === task));

  // The same read-back through RunManager history resolution.
  const replay = new RunManager(
    {
      owner: OWNER,
      createChild: async () => {
        throw new Error("replay must not create children");
      },
      readArchive: (file) => readArchive(file, harness.agentDir),
      record: () => {},
      report: () => {},
      warn: () => {},
    },
    [harness.records[harness.records.length - 1] as RunRecord],
  );
  try {
    const restored = replay.get(run.id) as RunView;
    assert.equal(restored.status, "closed", "an idle child is closed, not resumed, with its parent runtime");
    await replay.loadTranscript(run.id);
    const restoredText = replay
      .get(run.id)
      ?.transcript.items.filter((item) => item.kind === "message" && item.message.role === "assistant")
      .map((item) => (item.kind === "message" ? textOf(item.message as AgentMessage) : ""))
      .join("|");
    assert.ok(restoredText?.includes(spec.finalText), "RunManager transcript restore must include the exact final text");
  } finally {
    await replay.close();
  }

  // Explicit close: no further notice, and no orphan.
  await harness.manager.closeChild(run.id);
  assert.equal(view.status, "closed");
  assert.equal(harness.outcomes.size, 2, "closing a child reports nothing");
  await waitFor(() => !processAlive(pid), "closed child process outlived the run", 15_000);
});

test("close stops a working RPC child and leaves no orphan", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "peeps-integration-close-"));
  const nonce = root.slice(-8);
  const spec: ScriptSpec = {
    finalText: `SHOULD-NOT-APPEAR-${nonce}`,
    steerToken: `STEER-${nonce}`,
    gateTag: `gate-${nonce}`,
  };
  const harness = await createHarness(root, spec);
  t.after(async () => {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  });

  const run = harness.manager.spawn({ task: `CLOSE-${nonce}: block at the gate.` }, { model: MODEL, thinking: "off" }, null);
  await waitFor(
    () => existsSync(join(harness.testDir, "gate-started")),
    "scripted gate tool never started",
  );
  assert.equal(harness.manager.get(run.id)?.status, "working");

  await harness.manager.closeChild(run.id);
  const view = harness.manager.get(run.id) as RunView;
  assert.equal(view.status, "closed");
  assert.match(view.error ?? "", /while working/);
  assert.equal(harness.outcomes.size, 0, "closing is the parent's request, not a report");
  assert.equal(view.finalText, undefined, "a closed run must not publish a final answer");

  // Closing happened before the gate could release, so only the gate turn ran.
  const requests = await harness.readRequests();
  assert.equal(requests.length, 1, "closing must not start another model request");

  const pid = Number(await readFile(join(harness.testDir, "child.pid"), "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 0);
  await waitFor(() => !processAlive(pid), "closed child process was not reaped", 15_000);
});

test("interrupt keeps a real child; after close and a parent reload a message resumes its own session", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "peeps-integration-resume-"));
  const nonce = root.slice(-8);
  const spec: ScriptSpec = { finalText: `UNUSED-${nonce}`, steerToken: `STEER-${nonce}`, gateTag: `gate-${nonce}` };
  const harness = await createHarness(root, spec);
  let reloaded: RunManager | undefined;
  t.after(async () => {
    await reloaded?.close();
    await harness.close();
    await rm(root, { recursive: true, force: true });
  });
  const task = `RESUME-${nonce}: wait at the gate.`;
  const run = harness.manager.spawn({ task }, { model: MODEL, thinking: "off" }, null);
  await waitFor(() => existsSync(join(harness.testDir, "gate-started")), "scripted gate tool never started");
  const firstPid = Number(await readFile(join(harness.testDir, "child.pid"), "utf8"));

  // Interrupt: the work stops, the child and its process stay, and nothing is reported.
  const interrupted = await harness.manager.interrupt(run.id);
  assert.equal(interrupted.interrupted, true);
  await waitFor(() => harness.manager.get(run.id)?.status === "idle", "interrupted child never went idle");
  assert.equal(harness.outcomes.size, 0, `interrupt is not news; warnings: ${harness.warnings.join(" | ")}`);
  assert.ok(processAlive(firstPid));

  const first = `FOLLOWUP: ${nonce} first`;
  await harness.manager.send(run.id, first);
  assert.equal((await harness.outcomeFor(run.id, 1)).status, "answer");
  assert.equal(harness.manager.get(run.id)?.finalText, `REPLY ${first}`);
  const sessionFile = harness.manager.get(run.id)!.sessionFile!;

  // Close, then reload the parent: a new manager built only from the persisted records.
  await harness.manager.closeChild(run.id);
  await waitFor(() => !processAlive(firstPid), "closed child process outlived the run", 15_000);
  await harness.manager.close();
  reloaded = new RunManager(harness.options, [harness.records[harness.records.length - 1] as RunRecord]);
  assert.equal(reloaded.get(run.id)?.status, "closed");

  const second = `FOLLOWUP: ${nonce} second`;
  await reloaded.send(run.id, second);
  assert.equal((await harness.outcomeFor(run.id, 2)).status, "answer", `warnings: ${harness.warnings.join(" | ")}`);
  const view = reloaded.get(run.id)!;
  assert.equal(view.finalText, `REPLY ${second}`);
  assert.equal(view.sessionFile, sessionFile, "the resumed child writes to its own session file");
  const secondPid = Number(await readFile(join(harness.testDir, "child.pid"), "utf8"));
  assert.notEqual(secondPid, firstPid);

  // The resumed model call carries the whole earlier conversation.
  const requests = await harness.readRequests();
  const last = nonSystemMessages(requests[requests.length - 1] as RequestRecord);
  assert.equal(last[0]?.text, task);
  assert.ok(last.some((message) => message.text === first));
  assert.ok(last.some((message) => message.role === "assistant" && message.text === `REPLY ${first}`));
  assert.equal(last.at(-1)?.text, second);
  assert.ok(!requests.some((record) => nonSystemMessages(record).filter((m) => m.text === task).length > 1), "the task is never re-sent");

  await reloaded.close();
  await waitFor(() => !processAlive(secondPid), "resumed child process outlived its parent runtime", 15_000);
});

/**
 * Boot one isolated child and read its registered commands. The guarded run is
 * the production shape; the control run clears the child marker to prove this
 * exact launch does load the Peeps extension, so the guarded absence is the
 * guard at work and not a failed import.
 */
async function queryChildCommands(
  root: string,
  guard: boolean,
): Promise<{ commands: string[]; model: string }> {
  const suffix = guard ? "guarded" : "unguarded";
  const agentDir = join(root, `agent-${suffix}`);
  const workspace = join(root, `ws-${suffix}`);
  const testDir = join(root, `script-${suffix}`);
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(testDir, { recursive: true }),
  ]);
  await writeAgentSettings(agentDir);

  const env = childEnv(testDir, { finalText: "unused", steerToken: "unused", gateTag: "unused" });
  const launch = await buildLaunch(childLaunchContext(agentDir, workspace, env, false), {
    id: `guard-${suffix}-${Date.now().toString(36)}`,
    task: "unused",
    model: MODEL,
    thinking: "off",
  });
  const options = { ...launch.options, env: { ...(launch.options.env ?? {}) } };
  if (!guard) options.env.PI_PEEPS_CHILD = undefined;

  const proc = new RpcProcess({ ...options, requestTimeoutMs: 30_000, shutdownTimeoutMs: 2_000 });
  try {
    proc.start();
    const state = (await proc.request({ type: "get_state" })) as {
      model?: { provider?: string; id?: string };
    };
    const data = (await proc.request({ type: "get_commands" })) as {
      commands?: { name?: string }[];
    };
    return {
      commands: (data.commands ?? []).map((command) => String(command.name)),
      model: `${state.model?.provider ?? "?"}/${state.model?.id ?? "?"}`,
    };
  } finally {
    await proc.close();
  }
}

test("child guard suppresses the nested Peeps extension while the control proves it loads", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "peeps-integration-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const guarded = await queryChildCommands(root, true);
  assert.equal(guarded.model, `${SCRIPTED_PROVIDER}/${SCRIPTED_MODEL}`);
  assert.ok(!guarded.commands.includes("peeps"), `guarded child exposed Peeps commands: ${guarded.commands.join(",")}`);

  const control = await queryChildCommands(root, false);
  assert.equal(control.model, `${SCRIPTED_PROVIDER}/${SCRIPTED_MODEL}`);
  assert.ok(control.commands.includes("peeps"), `control child did not load the Peeps extension; commands: ${control.commands.join(",")}`);
});
