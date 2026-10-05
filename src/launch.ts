/**
 * Child launch construction for peeps runs.
 *
 * This module owns exactly two decisions:
 *
 * 1. How a child `pi` process is started: the Node executable plus the
 *    matching installed Pi `dist/rpc-entry.js` (which already selects RPC
 *    mode). It never guesses a `pi` from PATH and never assumes the cwd is a
 *    package root.
 * 2. Which parent CLI resources are reproducible: an explicit allowlist built
 *    with the public `parseArgs`. Positional prompts, session selectors,
 *    output mode, provider/model overrides, extension flags, and other
 *    arbitrary flags are never copied.
 *
 * Process lifecycle, model/thinking selection over RPC, and dialog policy
 * belong to the run manager. This module only validates the child's
 * `get_state` snapshot ({@link validateChildState}).
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { parseArgs, type Args } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { childArchiveDir } from "./archive.ts";
import type { RpcProcessOptions, RunView } from "./contracts.ts";

/** Child-process marker. The extension factory must no-op while this is set. */
export const PEEPS_CHILD_ENV = "PI_PEEPS_CHILD";

/**
 * Names of the tools this package registers.
 *
 * `index.ts` must register exactly these names so the child exclusion below
 * stays accurate. The env marker is the authoritative recursion guard; this
 * list is defense in depth for a parent that copied a `--tools` allowlist.
 */
export const PEEPS_TOOL_NAMES: readonly string[] = [
  "peeps_spawn",
  "peeps_send",
  "peeps_interrupt",
  "peeps_inspect",
  "peeps_close",
];

const PEEPS_TOOL_SET = new Set(PEEPS_TOOL_NAMES);

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/**
 * Inherited shell-tool session metadata that must not reach a child.
 *
 * Explicit undefined values are omitted by Node when spawning the child.
 */
const STALE_CHILD_ENV_KEYS = [
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
  "PI_CODING_AGENT_SESSION_DIR",
] as const;

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Safe single path segment (run id used as an archive directory name). */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A Node executable basename, optionally version-suffixed, without `.exe`. */
const NODE_EXECUTABLE = /^node(?:js)?(?:-\d+(?:\.\d+)*)?$/;

export interface LaunchContext {
  cwd: string;
  /** The parent's session file; absent for an ephemeral parent. */
  parentSessionFile?: string;
  trusted: boolean;
  agentDir: string;
  packageDir: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  executable: string;
}

export interface LaunchSpec {
  options: RpcProcessOptions;
  runDir?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`launch requires a non-empty ${label}`);
  }
  return value;
}

function compareVersions(version: string, minimum: readonly [number, number, number]): number {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < 3; index += 1) {
    const left = Number.isFinite(parts[index]) ? (parts[index] as number) : 0;
    const right = minimum[index] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/** Extract the minimum version from a simple `>=x.y.z` engines range. */
function minNodeFromEngines(engines: unknown): [number, number, number] | undefined {
  if (!isRecord(engines)) return undefined;
  const range = engines.node;
  if (typeof range !== "string") return undefined;
  const match = /(?:^|[^0-9])>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function assertNodeExecutable(executable: string): void {
  const raw = basename(executable).toLowerCase();
  const name = raw.endsWith(".exe") ? raw.slice(0, -4) : raw;
  if (!NODE_EXECUTABLE.test(name)) {
    throw new Error(
      `unsupported runtime "${basename(executable)}": peeps child runs require a Node executable`,
    );
  }
}

/**
 * Resolve and verify the installed Pi package shape. A Node + `dist/rpc-entry.js`
 * layout is the only supported shape: compiled/bundled Pi binaries cannot be
 * started this way and must fail loudly instead of spawning something else.
 */
function resolvePiRpcEntry(packageDir: string): string {
  const manifestPath = join(packageDir, "package.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error(`unsupported Pi install: cannot read ${manifestPath}`);
  }
  if (!isRecord(manifest) || manifest.name !== PI_PACKAGE_NAME) {
    throw new Error(`unsupported Pi install: ${manifestPath} is not ${PI_PACKAGE_NAME}`);
  }
  const entry = join(packageDir, "dist", "rpc-entry.js");
  if (!isFile(entry)) {
    throw new Error(`unsupported Pi install: RPC entry not found at ${entry}`);
  }
  const minimum = minNodeFromEngines(manifest.engines);
  if (minimum !== undefined && compareVersions(process.versions.node, minimum) < 0) {
    throw new Error(
      `unsupported Node runtime ${process.versions.node}: ${PI_PACKAGE_NAME} requires node ${minimum.join(".")}+`,
    );
  }
  return entry;
}

/**
 * Refuse parent profiles that cannot be reproduced as child CLI flags.
 *
 * Only reproducible, allowlisted CLI/config resources are inherited. An
 * explicit `--api-key` lives only in the parent's process state, and an
 * extension flag registered by an arbitrary loaded extension has no stable
 * child-side meaning. Both are identifiable unsupported profiles: fail loudly
 * instead of dropping a credential or a possible restriction.
 */
function assertReproducibleParentArgs(parentArgs: Args): void {
  if (parentArgs.apiKey !== undefined) {
    throw new Error(
      "cannot reproduce an ephemeral --api-key parent profile for a child run; relaunch without --api-key or use persisted credentials",
    );
  }
  if (parentArgs.unknownFlags.size > 0) {
    const flags = [...parentArgs.unknownFlags.keys()].sort();
    throw new Error(
      `unsupported parent invocation: extension flag(s) ${flags.map((flag) => `--${flag}`).join(", ")} cannot be reproduced for a child run`,
    );
  }
}

/**
 * Accept both the CLI argument list (`process.argv.slice(2)`) and a full
 * `process.argv`. The full form is detected by its executable at index 0 and
 * additionally exposes the parent entry script for the SDK check below.
 */
function parentArgv(context: LaunchContext): { args: string[]; entry?: string } {
  const argv = Array.isArray(context.argv) ? context.argv : [];
  if (argv.length >= 2 && argv[0] === context.executable) {
    return { args: argv.slice(2), entry: argv[1] };
  }
  return { args: argv };
}

function looksLikePiEntry(entry: string, packageDir: string): boolean {
  if (entry === packageDir || entry.startsWith(packageDir + sep)) return true;
  const base = basename(entry);
  return base === "cli.js" || base === "rpc-entry.js" || base === "pi" || base === "pi.js";
}

/** Resolve a resource path against the parent cwd, keeping builtins verbatim. */
function resolveResource(cwd: string, value: string): string {
  if (value.length === 0) return value;
  if (isAbsolute(value) || /^(?:builtin:|npm:|git:|https?:\/\/)/.test(value)) return value;
  return resolve(cwd, value);
}

function appendResourceArgs(args: string[], parent: Args, cwd: string): void {
  if (parent.noExtensions) args.push("--no-extensions");
  for (const value of parent.extensions ?? []) {
    args.push("--extension", resolveResource(cwd, value));
  }
  if (parent.noSkills) args.push("--no-skills");
  for (const value of parent.skills ?? []) {
    args.push("--skill", resolveResource(cwd, value));
  }
  if (parent.noPromptTemplates) args.push("--no-prompt-templates");
  for (const value of parent.promptTemplates ?? []) {
    args.push("--prompt-template", resolveResource(cwd, value));
  }
  if (parent.noContextFiles) args.push("--no-context-files");
  if (parent.systemPrompt !== undefined) args.push("--system-prompt", parent.systemPrompt);
  for (const value of parent.appendSystemPrompt ?? []) {
    args.push("--append-system-prompt", value);
  }
}

/**
 * Reproduce the parent's tool restrictions exactly, then always exclude this
 * package's own tools. `--tools` replaces the whole selection and
 * `--exclude-tools` filters afterwards, so the peeps names are removed from
 * the allowlist and re-added to the exclusion list; unknown names are ignored
 * by Pi, so the exclusion is safe even when the child guard already removed
 * the tool definitions.
 */
function appendToolArgs(args: string[], parent: Args): void {
  if (parent.noTools) args.push("--no-tools");
  if (parent.noBuiltinTools) args.push("--no-builtin-tools");
  if (parent.tools !== undefined) {
    const tools = parent.tools.filter((name) => !PEEPS_TOOL_SET.has(name));
    args.push("--tools", tools.join(","));
  }
  const excluded = new Set<string>(parent.excludeTools ?? []);
  for (const name of PEEPS_TOOL_NAMES) excluded.add(name);
  args.push("--exclude-tools", [...excluded].join(","));
}

function childEnv(context: LaunchContext, agentDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...context.env };
  for (const key of STALE_CHILD_ENV_KEYS) env[key] = undefined;
  env[PEEPS_CHILD_ENV] = "1";
  env.PI_CODING_AGENT_DIR = agentDir;
  return env;
}

function assertWithinDir(root: string, candidate: string, label: string): void {
  const rootAbs = resolve(root);
  const candidateAbs = resolve(candidate);
  if (candidateAbs !== rootAbs && !candidateAbs.startsWith(rootAbs + sep)) {
    throw new Error(`${label} escapes its directory: ${candidate}`);
  }
  if (existsSync(rootAbs) && existsSync(candidateAbs)) {
    const realRoot = realpathSync(rootAbs);
    const realCandidate = realpathSync(candidateAbs);
    if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + sep)) {
      throw new Error(`${label} resolves outside its directory: ${candidate}`);
    }
  }
}

/**
 * Build the child launch for one run.
 *
 * Persistent parents get a fresh native session id inside a private run
 * directory nested beside the parent session file (see `childArchiveDir`), or reopen
 * the recorded one to resume. Ephemeral parents get `--no-session`. Messages
 * are never placed on argv.
 */
export async function buildLaunch(
  context: LaunchContext,
  run: Pick<RunView, "id" | "task" | "model" | "thinking">,
  resume?: { sessionId: string },
): Promise<LaunchSpec> {
  const executable = requireString(context.executable, "executable");
  assertNodeExecutable(executable);

  const cwd = requireString(context.cwd, "cwd");
  const agentDir = resolve(requireString(context.agentDir, "agentDir"));
  const runId = requireString(run.id, "run id");
  if (!SAFE_PATH_SEGMENT.test(runId)) {
    throw new Error(`unsafe run id for an archive directory: ${runId}`);
  }

  const packageDir = resolve(requireString(context.packageDir, "packageDir"));
  const rpcEntry = resolvePiRpcEntry(packageDir);

  const parent = parentArgv(context);
  if (parent.entry !== undefined && !looksLikePiEntry(parent.entry, packageDir)) {
    // An SDK host embeds Pi in its own entry script, so its inline extensions
    // and providers live only in memory and cannot become child CLI flags.
    throw new Error(
      `unsupported parent invocation "${basename(parent.entry)}": inline SDK resources cannot be reproduced for a child run`,
    );
  }
  const parentArgs = parseArgs(parent.args);
  const errors = parentArgs.diagnostics.filter((diagnostic) => diagnostic.type === "error");
  if (errors.length > 0) {
    throw new Error(
      `unsupported parent invocation: ${errors.map((diagnostic) => diagnostic.message).join("; ")}`,
    );
  }
  assertReproducibleParentArgs(parentArgs);

  const args: string[] = ["--provider", run.model.provider, "--model", run.model.id, "--thinking", run.thinking];
  let runDir: string | undefined;
  if (context.parentSessionFile !== undefined) {
    runDir = join(childArchiveDir(requireString(context.parentSessionFile, "parentSessionFile")), runId);
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    await chmod(runDir, 0o700);
    // Exact ids only: never --continue/--resume pickers or --fork. Pi creates a new
    // session if a resumed id is missing, so validateChildState checks the file.
    if (resume && !SAFE_PATH_SEGMENT.test(resume.sessionId)) throw new Error(`unsafe session id: ${resume.sessionId}`);
    args.push("--session-dir", runDir, "--session-id", resume?.sessionId ?? randomUUID());
  } else if (resume) {
    throw new Error("an ephemeral parent keeps no child session to resume");
  } else {
    args.push("--no-session");
  }

  // Preserve the parent's effective project trust for the same cwd.
  args.push(context.trusted ? "--approve" : "--no-approve");

  appendResourceArgs(args, parentArgs, cwd);
  appendToolArgs(args, parentArgs);

  const options: RpcProcessOptions = {
    command: executable,
    args: [rpcEntry, ...args],
    cwd,
    env: childEnv(context, agentDir),
  };
  const spec: LaunchSpec = { options };
  if (runDir !== undefined) spec.runDir = runDir;
  return spec;
}

/**
 * Validate the child's `get_state` snapshot.
 *
 * The requested model must match exactly: Pi must never silently substitute a
 * model for a delegated run. The returned thinking level is the child's actual
 * (already clamped) level, not the requested one. When `runDir` is provided
 * the reported session file must stay inside it; an ephemeral run must not
 * report a persisted session file at all. A resumed child must report exactly
 * the recorded session, never a fresh one Pi created in its place.
 */
export function validateChildState(
  state: unknown,
  run: Pick<RunView, "model">,
  runDir?: string,
  resume?: { sessionId: string; sessionFile: string },
): { sessionFile?: string; sessionId?: string; thinking: ThinkingLevel } {
  if (!isRecord(state)) {
    throw new Error("child get_state returned a non-object state");
  }

  const model = state.model;
  if (!isRecord(model)) {
    throw new Error("child get_state did not report a model");
  }
  const provider = model.provider;
  const id = model.id;
  if (
    typeof provider !== "string" ||
    provider.length === 0 ||
    typeof id !== "string" ||
    id.length === 0
  ) {
    throw new Error("child get_state reported a malformed model");
  }
  if (provider !== run.model.provider || id !== run.model.id) {
    throw new Error(
      `child model mismatch: requested ${run.model.provider}/${run.model.id}, got ${provider}/${id}`,
    );
  }

  const thinking = state.thinkingLevel;
  if (typeof thinking !== "string" || !(THINKING_LEVELS as readonly string[]).includes(thinking)) {
    throw new Error(`child get_state reported an invalid thinking level: ${String(thinking)}`);
  }

  const sessionId = typeof state.sessionId === "string" ? state.sessionId : undefined;
  const rawSessionFile = state.sessionFile;
  if (resume && (rawSessionFile !== resume.sessionFile || sessionId !== resume.sessionId)) {
    throw new Error("resumed child did not reopen its recorded session; refusing to continue in a fresh one");
  }
  if (rawSessionFile === undefined) {
    return { thinking: thinking as ThinkingLevel };
  }
  if (typeof rawSessionFile !== "string" || rawSessionFile.length === 0) {
    throw new Error("child get_state reported a malformed sessionFile");
  }
  if (runDir === undefined) {
    throw new Error("child reported a persisted session file for an ephemeral run");
  }
  assertWithinDir(runDir, rawSessionFile, "child session file");
  return { sessionFile: rawSessionFile, ...(sessionId ? { sessionId } : {}), thinking: thinking as ThinkingLevel };
}
