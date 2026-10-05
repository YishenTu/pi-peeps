import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { RunView } from "../src/contracts.ts";
import {
  buildLaunch,
  PEEPS_CHILD_ENV,
  PEEPS_TOOL_NAMES,
  validateChildState,
  type LaunchContext,
} from "../src/launch.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNER = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const STALE_ENV_KEYS = [
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
  "PI_CODING_AGENT_SESSION_DIR",
];

type LaunchRun = Pick<RunView, "id" | "task" | "model" | "thinking">;

interface Fixture {
  root: string;
  agentDir: string;
  pkg: string;
  cwd: string;
}

async function makePiPackage(root: string, name = PI_PACKAGE_NAME): Promise<string> {
  const pkg = join(root, "pi-pkg");
  await mkdir(join(pkg, "dist"), { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name, version: "1.0.2", engines: { node: ">=22.19.0" } }),
    "utf8",
  );
  await writeFile(join(pkg, "dist", "rpc-entry.js"), "// fake rpc entry\n", "utf8");
  return pkg;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "peeps-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const pkg = await makePiPackage(root);
  return { root, agentDir, pkg, cwd };
}

function parentSessionFile(f: Fixture): string {
  return join(f.agentDir, "sessions", "--project--", `2026-01-01T00-00-00-000Z_${OWNER}.jsonl`);
}

function contextFor(
  f: Fixture,
  overrides: Partial<LaunchContext> = {},
  argv: string[] = [],
): LaunchContext {
  return {
    cwd: f.cwd,
    parentSessionFile: parentSessionFile(f),
    trusted: true,
    agentDir: f.agentDir,
    packageDir: f.pkg,
    argv,
    env: {
      KEEP: "yes",
      PI_SESSION_ID: "parent-session",
      PI_SESSION_FILE: "/parent/session.jsonl",
      PI_PROVIDER: "parent-provider",
      PI_MODEL: "parent-model",
      PI_REASONING_LEVEL: "high",
      PI_CODING_AGENT_SESSION_DIR: "/parent/sessions",
    },
    executable: process.execPath,
    ...overrides,
  };
}

function runFor(overrides: Partial<LaunchRun> = {}): LaunchRun {
  return {
    id: RUN_ID,
    task: "SECRET TASK: do the delegated thing",
    model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    thinking: "medium" as ThinkingLevel,
    ...overrides,
  };
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function hasFlagValue(args: readonly string[], flag: string, value: string): boolean {
  return valueAfter(args, flag) === value;
}

test("persistent launch isolates the session archive and clears inherited session env", async (t) => {
  const f = await fixture(t);
  const spec = await buildLaunch(contextFor(f), runFor());
  const args = spec.options.args;

  assert.equal(spec.options.command, process.execPath);
  assert.equal(spec.options.cwd, f.cwd);
  assert.equal(args[0], resolve(join(f.pkg, "dist", "rpc-entry.js")));
  // rpc-entry.js selects RPC mode itself; copying a mode flag would be wrong.
  assert.ok(!args.includes("--mode"));
  assert.ok(!args.includes("--no-session"));

  // Nested beside the parent file, where Pi's flat session picker never looks.
  const runDir = join(resolve(f.agentDir), "sessions", "--project--", `2026-01-01T00-00-00-000Z_${OWNER}`, RUN_ID);
  assert.equal(spec.runDir, runDir);
  assert.ok(hasFlagValue(args, "--session-dir", runDir));
  const sessionId = valueAfter(args, "--session-id");
  assert.match(sessionId ?? "", UUID_RE);
  assert.notEqual(sessionId, RUN_ID);
  assert.ok(args.includes("--approve"));

  assert.ok(!args.some((arg) => arg.includes("SECRET TASK")));

  assert.equal(spec.options.env?.[PEEPS_CHILD_ENV], "1");
  assert.equal(spec.options.env?.PI_CODING_AGENT_DIR, resolve(f.agentDir));
  assert.equal(spec.options.env?.KEEP, "yes");
  for (const key of STALE_ENV_KEYS) {
    assert.equal(spec.options.env?.[key], undefined, `${key} must be cleared`);
  }

  assert.ok(existsSync(runDir));
  assert.equal(statSync(runDir).mode & 0o777, 0o700);
});

test("ephemeral launch uses --no-session and creates no archive directory", async (t) => {
  const f = await fixture(t);
  const spec = await buildLaunch(contextFor(f, { parentSessionFile: undefined }), runFor());
  assert.ok(spec.options.args.includes("--no-session"));
  assert.ok(!spec.options.args.includes("--session-dir"));
  assert.ok(!spec.options.args.includes("--session-id"));
  assert.equal(spec.runDir, undefined);
  assert.ok(!existsSync(join(resolve(f.agentDir), "sessions")));
});

test("trust is preserved explicitly for the same cwd", async (t) => {
  const f = await fixture(t);
  const trusted = await buildLaunch(contextFor(f, { trusted: true }), runFor());
  assert.ok(trusted.options.args.includes("--approve"));
  assert.ok(!trusted.options.args.includes("--no-approve"));

  const untrusted = await buildLaunch(contextFor(f, { trusted: false }), runFor());
  assert.ok(untrusted.options.args.includes("--no-approve"));
  assert.ok(!untrusted.options.args.includes("--approve"));
  assert.equal(untrusted.options.cwd, f.cwd);
});

test("resource allowlist is reproduced and relative paths resolve against cwd", async (t) => {
  const f = await fixture(t);
  const spec = await buildLaunch(
    contextFor(f, {}, [
      "--extension",
      "./ext.ts",
      "--extension",
      "builtin:mcp",
      "--no-extensions",
      "--no-skills",
      "--skill",
      "skills/a.md",
      "--no-prompt-templates",
      "--prompt-template",
      "prompts/p.md",
      "--no-context-files",
      "--system-prompt",
      "custom system",
      "--append-system-prompt",
      "extra instruction",
    ]),
    runFor(),
  );
  const args = spec.options.args;

  assert.ok(args.includes("--no-extensions"));
  assert.ok(hasFlagValue(args, "--extension", resolve(f.cwd, "ext.ts")));
  // Repeated --extension keeps every value and builtins stay verbatim.
  assert.ok(args.filter((arg) => arg === "--extension").length === 2);
  assert.ok(args.includes("builtin:mcp"));
  assert.ok(args.includes("--no-skills"));
  assert.ok(hasFlagValue(args, "--skill", resolve(f.cwd, "skills/a.md")));
  assert.ok(args.includes("--no-prompt-templates"));
  assert.ok(hasFlagValue(args, "--prompt-template", resolve(f.cwd, "prompts/p.md")));
  assert.ok(args.includes("--no-context-files"));
  assert.ok(hasFlagValue(args, "--system-prompt", "custom system"));
  assert.ok(hasFlagValue(args, "--append-system-prompt", "extra instruction"));
});

test("parent positional/session/mode/model flags are replaced by the captured run selection", async (t) => {
  const f = await fixture(t);
  const spec = await buildLaunch(
    contextFor(f, {}, [
      "--mode",
      "json",
      "--provider",
      "anthropic",
      "--model",
      "anthropic/claude-opus-4",
      "--models",
      "a,b",
      "--thinking",
      "high",
      "--session",
      "some-session",
      "--session-id",
      "parent-session-id",
      "--session-dir",
      "/parent/sessions",
      "--continue",
      "--name",
      "parent-name",
      "--theme",
      "./theme.json",
      "--offline",
      "--",
      "prompt text",
      "@some-file.txt",
    ]),
    runFor(),
  );
  const args = spec.options.args;

  for (const forbidden of [
    "--mode",
    "--models",
    "--session",
    "--continue",
    "--name",
    "--theme",
    "--offline",
  ]) {
    assert.ok(!args.includes(forbidden), `${forbidden} must not be copied`);
  }
  assert.equal(valueAfter(args, "--provider"), runFor().model.provider);
  assert.equal(valueAfter(args, "--model"), runFor().model.id);
  assert.equal(valueAfter(args, "--thinking"), runFor().thinking);
  assert.equal(valueAfter(args, "--session-id") === "parent-session-id", false);
  assert.notEqual(valueAfter(args, "--session-dir"), "/parent/sessions");
  assert.ok(!args.some((arg) => arg === "prompt text" || arg === "some-file.txt"));
});

test("package source identifiers are not rewritten as local cwd paths", async t => {
  const f = await fixture(t);
  for (const source of ["npm:@example/tools@1.0.0", "git:github.com/example/tools", "https://github.com/example/tools", "builtin:codemode"]) {
    const spec = await buildLaunch(contextFor(f, {}, ["-e", source]), runFor());
    assert.equal(valueAfter(spec.options.args, "--extension"), source);
  }
});

test("tool restrictions are preserved and peeps tools are excluded", async (t) => {
  const f = await fixture(t);
  const restricted = await buildLaunch(
    contextFor(f, {}, ["--tools", "read,bash,peeps_spawn", "--exclude-tools", "grep"]),
    runFor(),
  );
  const restrictedArgs = restricted.options.args;
  assert.equal(valueAfter(restrictedArgs, "--tools"), "read,bash");
  const excluded = (valueAfter(restrictedArgs, "--exclude-tools") ?? "").split(",");
  assert.ok(excluded.includes("grep"));
  for (const name of PEEPS_TOOL_NAMES) {
    assert.ok(excluded.includes(name), `${name} must be excluded`);
    assert.ok(!(valueAfter(restrictedArgs, "--tools") ?? "").includes(name));
  }

  const noTools = await buildLaunch(contextFor(f, {}, ["--no-tools"]), runFor());
  assert.ok(noTools.options.args.includes("--no-tools"));

  const noBuiltins = await buildLaunch(contextFor(f, {}, ["--no-builtin-tools"]), runFor());
  assert.ok(noBuiltins.options.args.includes("--no-builtin-tools"));

  // With no parent tool flags the child keeps Pi defaults, still with peeps excluded.
  const defaults = await buildLaunch(contextFor(f), runFor());
  assert.ok(!defaults.options.args.includes("--tools"));
  const defaultExcluded = (valueAfter(defaults.options.args, "--exclude-tools") ?? "").split(",");
  for (const name of PEEPS_TOOL_NAMES) assert.ok(defaultExcluded.includes(name));
});

test("rejects an ephemeral --api-key profile without leaking the secret", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    buildLaunch(contextFor(f, {}, ["--api-key", "sk-super-secret"]), runFor()),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /api-key/);
      assert.ok(!message.includes("sk-super-secret"));
      return true;
    },
  );
});

test("rejects identifiable unsupported parent profiles", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    buildLaunch(contextFor(f, {}, ["--my-extension-flag", "value"]), runFor()),
    /my-extension-flag/,
  );
  await assert.rejects(
    buildLaunch(contextFor(f, {}, ["--mode", "bogus"]), runFor()),
    /unsupported parent invocation/,
  );
});

test("rejects unsupported runtime and install shapes", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    buildLaunch(contextFor(f, { executable: "/usr/local/bin/bun" }), runFor()),
    /unsupported runtime/,
  );

  const missingEntry = join(f.root, "missing-entry");
  await mkdir(join(missingEntry, "dist"), { recursive: true });
  await writeFile(
    join(missingEntry, "package.json"),
    JSON.stringify({ name: PI_PACKAGE_NAME, engines: { node: ">=22.19.0" } }),
    "utf8",
  );
  await assert.rejects(
    buildLaunch(contextFor(f, { packageDir: missingEntry }), runFor()),
    /RPC entry not found/,
  );

  const wrongPkg = await makePiPackage(join(f.root, "wrong"), "not-pi");
  await assert.rejects(
    buildLaunch(contextFor(f, { packageDir: wrongPkg }), runFor()),
    /is not @earendil-works\/pi-coding-agent/,
  );
});

test("accepts a full process.argv and rejects an SDK-host entry script", async (t) => {
  const f = await fixture(t);
  const piEntry = join(f.pkg, "dist", "bundle", "cli.js");
  const full = await buildLaunch(
    contextFor(f, { argv: [process.execPath, piEntry, "--no-context-files"] }),
    runFor(),
  );
  assert.ok(full.options.args.includes("--no-context-files"));

  await assert.rejects(
    buildLaunch(contextFor(f, { argv: [process.execPath, "/tmp/sdk-host.js"] }), runFor()),
    /inline SDK resources/,
  );
});

test("rejects an unsafe run id before touching the filesystem", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    buildLaunch(contextFor(f), runFor({ id: "../escape" })),
    /unsafe run id/,
  );
});

test("validateChildState requires the exact model and reports the clamped thinking level", async (t) => {
  const f = await fixture(t);
  const run = runFor();
  const runDir = join(f.root, "run-dir");
  await mkdir(runDir, { recursive: true });
  const sessionFile = join(runDir, "session.jsonl");

  const ok = validateChildState(
    { model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "low", sessionFile },
    run,
    runDir,
  );
  assert.deepEqual(ok, { sessionFile, thinking: "low" });

  const withoutFile = validateChildState(
    { model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "off" },
    run,
  );
  assert.deepEqual(withoutFile, { thinking: "off" });

  assert.throws(
    () =>
      validateChildState(
        { model: { provider: "openai", id: "gpt" }, thinkingLevel: "low" },
        run,
        runDir,
      ),
    /child model mismatch/,
  );
  assert.throws(
    () =>
      validateChildState(
        { model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "ridiculous" },
        run,
        runDir,
      ),
    /thinking level/,
  );
  assert.throws(
    () =>
      validateChildState(
        {
          model: { provider: "anthropic", id: "claude-sonnet-4-5" },
          thinkingLevel: "low",
          sessionFile,
        },
        run,
      ),
    /ephemeral run/,
  );
  assert.throws(
    () =>
      validateChildState(
        {
          model: { provider: "anthropic", id: "claude-sonnet-4-5" },
          thinkingLevel: "low",
          sessionFile: join(f.root, "outside.jsonl"),
        },
        run,
        runDir,
      ),
    /escapes its directory/,
  );
  assert.throws(() => validateChildState(null, run, runDir), /non-object/);
});

test("resume reopens the exact recorded session id in the same run directory, never a picker or fork", async (t) => {
  const f = await fixture(t);
  const sessionId = "0b7f6a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
  const spec = await buildLaunch(contextFor(f), runFor(), { sessionId });
  const args = spec.options.args;
  assert.ok(hasFlagValue(args, "--session-id", sessionId));
  assert.ok(hasFlagValue(args, "--session-dir", spec.runDir!));
  for (const flag of ["--continue", "-c", "--resume", "-r", "--fork", "--session"]) assert.ok(!args.includes(flag), flag);
  assert.ok(!args.some((arg) => arg.includes("SECRET TASK")));
  await assert.rejects(buildLaunch(contextFor(f), runFor(), { sessionId: "../escape" }), /unsafe session id/);
  await assert.rejects(buildLaunch(contextFor(f, { parentSessionFile: undefined }), runFor(), { sessionId }), /ephemeral/);
});

test("a resumed child must report exactly its recorded session, never a fresh one", async (t) => {
  const f = await fixture(t);
  const runDir = join(f.root, "run-dir");
  await mkdir(runDir, { recursive: true });
  const sessionFile = join(runDir, "session.jsonl");
  const state = (overrides: Record<string, unknown>) =>
    ({ model: { provider: "anthropic", id: "claude-sonnet-4-5" }, thinkingLevel: "low", sessionFile, sessionId: "kept", ...overrides });
  const resume = { sessionFile, sessionId: "kept" };
  assert.deepEqual(validateChildState(state({}), runFor(), runDir, resume), { sessionFile, sessionId: "kept", thinking: "low" });
  // Pi creates a new session when the recorded one is missing: a different file, or a different id.
  assert.throws(() => validateChildState(state({ sessionFile: join(runDir, "fresh.jsonl") }), runFor(), runDir, resume), /did not reopen/);
  assert.throws(() => validateChildState(state({ sessionId: "other" }), runFor(), runDir, resume), /did not reopen/);
});
