/**
 * Read-only archive access for peeps runs.
 *
 * Two independent readers:
 *
 * - {@link readRunRecords} scans the owning session's entries for the latest
 *   valid `peeps/run` custom record per run id. Records are untrusted input:
 *   every field is validated and malformed records are skipped.
 * - {@link readArchive} reads a finished child's session JSONL directly. It
 *   never uses `SessionManager.open` (which would migrate or open the file as
 *   live session state), only reads the file, verifies real-path containment
 *   under `<archiveRoot>/peeps`, and reconstructs the last entry's branch
 *   without letting compaction hide pre-compaction history.
 */
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  parseSessionEntries,
  sessionEntryToContextMessages,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { DeliveryStatus, RunStatus, RunView } from "./contracts.ts";

/** Subdirectory of the agent dir that holds peeps child session archives. */
const ARCHIVE_DIR_NAME = "peeps";
/** Inspection ceiling, not a task/output limit. The full native file is retained. */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export class ArchiveTooLargeError extends Error {
  constructor() {
    super("Child archive too large to display (maximum 64 MiB). The native JSONL remains available on disk.");
    this.name = "ArchiveTooLargeError";
  }
}

/** Custom-entry type that persists one run record in the owning session. */
export const RUN_RECORD_TYPE = "peeps/run";

export interface RunRecord {
  version: 1;
  owner: string;
  anchor: string | null;
  run: Omit<RunView, "transcript" | "finalText">;
}

const RUN_STATUSES: readonly RunStatus[] = [
  "starting",
  "working",
  "idle",
  "closed",
  "failed",
];

const DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  "none",
  "held",
  "queued",
  "appended",
  "unconfirmed",
  "suppressed",
  "failed",
];

const THINKING_LEVELS: readonly string[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const RUN_STATUS_SET = new Set<string>(RUN_STATUSES);
const DELIVERY_STATUS_SET = new Set<string>(DELIVERY_STATUSES);
const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

/** Run ids are UUIDs; anything else is corrupt or forged metadata. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Safe session-entry / anchor token (8-hex ids or full UUIDs). */
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf(value: unknown, allowed: ReadonlySet<string>): value is string {
  return typeof value === "string" && allowed.has(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

// ---------------------------------------------------------------------------
// Run records
// ---------------------------------------------------------------------------

/**
 * Project one `peeps/run` custom entry's data into a trusted shape.
 * Returns `undefined` for any malformed record rather than throwing.
 */
function parseRunRecord(data: unknown): RunRecord | undefined {
  if (!isRecord(data) || data.version !== 1) return undefined;

  const owner = data.owner;
  if (typeof owner !== "string" || !SAFE_TOKEN.test(owner)) return undefined;

  const anchor = data.anchor;
  if (anchor !== null && (typeof anchor !== "string" || !SAFE_TOKEN.test(anchor))) {
    return undefined;
  }

  const rawRun = data.run;
  if (!isRecord(rawRun)) return undefined;

  const id = rawRun.id;
  if (typeof id !== "string" || !UUID.test(id)) return undefined;

  const label = rawRun.label;
  const task = rawRun.task;
  const activity = rawRun.activity;
  if (typeof label !== "string" || typeof task !== "string" || typeof activity !== "string") {
    return undefined;
  }

  if (!isOneOf(rawRun.status, RUN_STATUS_SET)) return undefined;
  if (!isOneOf(rawRun.delivery, DELIVERY_STATUS_SET)) return undefined;
  if (!isOneOf(rawRun.thinking, THINKING_LEVEL_SET)) return undefined;

  const rawModel = rawRun.model;
  if (!isRecord(rawModel)) return undefined;
  const provider = rawModel.provider;
  const modelId = rawModel.id;
  if (
    typeof provider !== "string" ||
    provider.length === 0 ||
    typeof modelId !== "string" ||
    modelId.length === 0
  ) {
    return undefined;
  }

  const createdAt = optionalFiniteNumber(rawRun.createdAt);
  if (createdAt === undefined) return undefined;

  const run: Omit<RunView, "transcript" | "finalText"> = {
    id,
    label,
    task,
    status: rawRun.status as RunStatus,
    model: { provider, id: modelId },
    thinking: rawRun.thinking as ThinkingLevel,
    createdAt,
    activity,
    reports: typeof rawRun.reports === "number" && Number.isSafeInteger(rawRun.reports) && rawRun.reports >= 0 ? rawRun.reports : 0,
    delivery: rawRun.delivery as DeliveryStatus,
  };

  const startedAt = optionalFiniteNumber(rawRun.startedAt);
  if (startedAt !== undefined) run.startedAt = startedAt;
  const finishedAt = optionalFiniteNumber(rawRun.finishedAt);
  if (finishedAt !== undefined) run.finishedAt = finishedAt;
  const error = optionalString(rawRun.error);
  if (error !== undefined) run.error = error;
  const sessionFile = optionalString(rawRun.sessionFile);
  if (sessionFile !== undefined) run.sessionFile = sessionFile;
  const sessionId = optionalString(rawRun.sessionId);
  if (sessionId !== undefined && SAFE_TOKEN.test(sessionId)) run.sessionId = sessionId;

  return { version: 1, owner, anchor, run };
}

/**
 * Latest valid v1 `peeps/run` record per run id, in first-appearance order.
 * Invalid records and later duplicates that fail validation are ignored.
 */
export function readRunRecords(entries: readonly SessionEntry[]): RunRecord[] {
  const latest = new Map<string, RunRecord>();
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== RUN_RECORD_TYPE) {
      continue;
    }
    const record = parseRunRecord((entry as { data?: unknown }).data);
    if (record === undefined) continue;
    // Map preserves first-insertion order while the value stays the latest.
    latest.set(record.run.id, record);
  }
  return [...latest.values()];
}

// ---------------------------------------------------------------------------
// Child session archives
// ---------------------------------------------------------------------------

/** A structurally safe entry from an untrusted session file. */
type SafeEntry = Record<string, unknown> & { type: string };

function isMessageContent(value: unknown): boolean {
  return typeof value === "string" || Array.isArray(value);
}

/**
 * Structural validation for an untrusted/corrupt session file. Malformed
 * entries are dropped instead of crashing the reader.
 */
function isSafeEntry(value: unknown): value is SafeEntry {
  if (!isRecord(value) || typeof value.type !== "string" || value.type.length === 0) return false;
  if (value.type === "session") return true;
  // Legacy (v1) entries have no id/parentId; when present they must be safe.
  if (value.id !== undefined) {
    if (typeof value.id !== "string" || !SAFE_TOKEN.test(value.id)) return false;
  }
  if (value.parentId !== null && value.parentId !== undefined) {
    if (typeof value.parentId !== "string" || !SAFE_TOKEN.test(value.parentId)) return false;
  }
  if (value.type === "message") {
    return isRecord(value.message) && typeof value.message.role === "string";
  }
  if (value.type === "custom_message") {
    return typeof value.customType === "string" && isMessageContent(value.content);
  }
  return true;
}

function parseSafeEntries(content: string): SafeEntry[] {
  const parsed = parseSessionEntries(content) as unknown[];
  return parsed.filter(isSafeEntry);
}

/**
 * Walk the active branch: the ancestor chain of the last entry that carries an
 * id. Cycles and broken parent links stop the walk rather than looping.
 */
function activeBranch(entries: readonly SafeEntry[]): SafeEntry[] {
  const index = new Map<string, SafeEntry>();
  for (const entry of entries) {
    if (typeof entry.id === "string" && !index.has(entry.id)) index.set(entry.id, entry);
  }

  let leaf: SafeEntry | undefined;
  for (const entry of entries) {
    if (typeof entry.id === "string") leaf = entry;
  }
  if (leaf === undefined) return [];

  const path: SafeEntry[] = [];
  const seen = new Set<string>();
  let current: SafeEntry | undefined = leaf;
  while (current !== undefined) {
    if (typeof current.id === "string") {
      if (seen.has(current.id)) break;
      seen.add(current.id);
    }
    path.push(current);
    const parentId: string | undefined =
      typeof current.parentId === "string" ? current.parentId : undefined;
    current = parentId === undefined ? undefined : index.get(parentId);
  }
  path.reverse();
  return path;
}

/**
 * Select the model-visible history for an archive.
 *
 * Compaction entries are intentionally not filtered through
 * `buildSessionContext`: the branch itself is reconstructed so every message
 * that ever happened on it survives, including pre-compaction history. Plain
 * `message` and `custom_message` entries are converted through the public
 * `sessionEntryToContextMessages`; system prompts are display-internal and are
 * not part of the restored conversation.
 */
function selectHistoryMessages(entries: readonly SafeEntry[]): AgentMessage[] {
  const header = entries.find((entry) => entry.type === "session");
  const version = header !== undefined && typeof header.version === "number" ? header.version : 1;
  const isTree = version >= 2 && entries.some((entry) => typeof entry.id === "string");
  const ordered = isTree ? activeBranch(entries) : entries.filter((entry) => entry.type !== "session");

  const messages: AgentMessage[] = [];
  for (const entry of ordered) {
    if (entry.type !== "message" && entry.type !== "custom_message") continue;
    let converted: AgentMessage[];
    try {
      converted = sessionEntryToContextMessages(entry as unknown as SessionEntry);
    } catch {
      continue;
    }
    for (const message of converted) {
      if (message.role !== "system") messages.push(message);
    }
  }
  return messages;
}

async function resolveArchiveRoot(archiveRoot: string): Promise<string> {
  if (typeof archiveRoot !== "string" || archiveRoot.length === 0) {
    throw new Error("readArchive requires an archive root");
  }
  const peepsDir = join(resolve(archiveRoot), ARCHIVE_DIR_NAME);
  try {
    return await realpath(peepsDir);
  } catch {
    throw new Error(`peeps archive directory is unavailable: ${peepsDir}`);
  }
}

async function resolveArchiveFile(sessionFile: string, allowedRoot: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(resolve(sessionFile));
  } catch {
    throw new Error(`child session archive not found: ${sessionFile}`);
  }
  if (!isWithin(allowedRoot, real)) {
    throw new Error(`refusing to read a session archive outside ${allowedRoot}: ${sessionFile}`);
  }
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(real);
  } catch {
    throw new Error(`child session archive is not readable: ${sessionFile}`);
  }
  if (!info.isFile()) {
    throw new Error(`child session archive is not a file: ${sessionFile}`);
  }
  if (info.size > MAX_ARCHIVE_BYTES) throw new ArchiveTooLargeError();
  return real;
}

/**
 * Read a finished child's session archive as a full historical message list.
 *
 * Strictly read-only: the file is parsed as-is (`parseSessionEntries`, no
 * migration), and the resolved path must stay under `<archiveRoot>/peeps`
 * after symlink resolution. A missing or out-of-root path throws a diagnostic
 * error rather than returning a partial result.
 */
export async function readArchive(
  sessionFile: string,
  archiveRoot: string,
): Promise<AgentMessage[]> {
  if (typeof sessionFile !== "string" || sessionFile.length === 0) {
    throw new Error("readArchive requires a session file path");
  }
  const allowedRoot = await resolveArchiveRoot(archiveRoot);
  const real = await resolveArchiveFile(sessionFile, allowedRoot);
  const chunks: Buffer[] = [];
  let bytes = 0;
  // Inclusive end reads at most cap + 1 bytes, even if a file grows after stat.
  for await (const chunk of createReadStream(real, { start: 0, end: MAX_ARCHIVE_BYTES })) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    if (bytes > MAX_ARCHIVE_BYTES) throw new ArchiveTooLargeError();
    chunks.push(buffer);
  }
  return selectHistoryMessages(parseSafeEntries(Buffer.concat(chunks, bytes).toString("utf8")));
}
