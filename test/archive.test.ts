import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { readArchive, readRunRecords, RUN_RECORD_TYPE, MAX_ARCHIVE_BYTES } from "../src/archive.ts";

test("oversized archives fail read-only inspection clearly without reading or changing the whole file", async t => {
  const fixture = await makeArchive(t);
  const file = join(fixture.archiveRoot, "large.jsonl");
  await writeFile(file, "");
  await truncate(file, MAX_ARCHIVE_BYTES + 1); // Sparse fixture: no large allocation.
  await assert.rejects(readArchive(file, fixture.agentDir), /too large to display.*64 MiB/);
  assert.equal((await stat(file)).size, MAX_ARCHIVE_BYTES + 1);
});

const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";

interface Archive {
  root: string;
  agentDir: string;
  archiveRoot: string;
}

async function makeArchive(t: TestContext): Promise<Archive> {
  const root = await mkdtemp(join(tmpdir(), "peeps-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const archiveRoot = join(agentDir, "peeps", "hash", "run");
  await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
  return { root, agentDir, archiveRoot };
}

async function writeArchive(
  archiveRoot: string,
  name: string,
  lines: ReadonlyArray<unknown>,
): Promise<string> {
  const file = join(archiveRoot, name);
  await writeFile(
    file,
    lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n",
    "utf8",
  );
  return file;
}

const header = (version = 3) => ({
  type: "session",
  version,
  id: "session-id",
  timestamp: "2024-01-01T00:00:00.000Z",
  cwd: "/tmp/project",
});

const userMessage = (id: string | undefined, parentId: string | null, content: unknown) => {
  const entry: Record<string, unknown> = {
    type: "message",
    timestamp: "2024-01-01T00:00:01.000Z",
    message: { role: "user", content, timestamp: 1 },
  };
  if (id !== undefined) entry.id = id;
  if (parentId !== null || id !== undefined) entry.parentId = parentId;
  return entry;
};

const assistantMessage = (id: string, parentId: string | null, text: string) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2024-01-01T00:00:02.000Z",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  },
});

// ---------------------------------------------------------------------------
// readArchive
// ---------------------------------------------------------------------------

test("readArchive restores pre-compaction history on the last entry's branch", async (t) => {
  const a = await makeArchive(t);
  const file = await writeArchive(a.archiveRoot, "compact.jsonl", [
    header(),
    userMessage("aaaaaaa1", null, "first"),
    assistantMessage("aaaaaaa2", "aaaaaaa1", "second"),
    {
      type: "compaction",
      id: "aaaaaaa3",
      parentId: "aaaaaaa2",
      timestamp: "2024-01-01T00:00:03.000Z",
      summary: "summary of earlier work",
      firstKeptEntryId: "aaaaaaa1",
      tokensBefore: 1234,
    },
    userMessage("aaaaaaa4", "aaaaaaa3", "after"),
  ]);

  const messages = await readArchive(file, a.agentDir);
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant", "user"],
  );
  assert.deepEqual(
    messages.map((message) => (message as { content: unknown }).content),
    ["first", [{ type: "text", text: "second" }], "after"],
  );
});

test("readArchive follows the branch containing the last entry", async (t) => {
  const a = await makeArchive(t);
  const file = await writeArchive(a.archiveRoot, "branch.jsonl", [
    header(),
    userMessage("aaaaaaa1", null, "a"),
    assistantMessage("aaaaaaa2", "aaaaaaa1", "b"),
    userMessage("aaaaaaa3", "aaaaaaa1", "c"),
  ]);

  const messages = await readArchive(file, a.agentDir);
  assert.deepEqual(
    messages.map((message) => (message as { content: unknown }).content),
    ["a", "c"],
  );
});

test("readArchive reads legacy linear sessions without migrating them", async (t) => {
  const a = await makeArchive(t);
  const file = await writeArchive(a.archiveRoot, "legacy.jsonl", [
    header(1),
    userMessage(undefined, null, "one"),
    userMessage(undefined, null, "two"),
  ]);

  const messages = await readArchive(file, a.agentDir);
  assert.deepEqual(
    messages.map((message) => (message as { content: unknown }).content),
    ["one", "two"],
  );
});

test("readArchive converts custom messages and tolerates corrupt records", async (t) => {
  const a = await makeArchive(t);
  const file = await writeArchive(a.archiveRoot, "custom.jsonl", [
    header(),
    "not json at all",
    userMessage("aaaaaaa1", null, "kept"),
    {
      type: "custom_message",
      id: "bbbbbbb1",
      parentId: "aaaaaaa1",
      timestamp: "2024-01-01T00:00:04.000Z",
      customType: "permission",
      content: "injected context",
      display: true,
    },
    {
      type: "message",
      id: "../escape",
      parentId: "aaaaaaa1",
      message: { role: "user", content: "unsafe id", timestamp: 3 },
    },
    { type: "message", id: "ccccccc1", parentId: "aaaaaaa1" },
  ]);

  const messages = await readArchive(file, a.agentDir);
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "custom"],
  );
  assert.equal((messages[1] as { content: unknown }).content, "injected context");
});

test("readArchive rejects out-of-root, symlinked, and missing files", async (t) => {
  const a = await makeArchive(t);
  const outside = join(a.root, "outside.jsonl");
  await writeFile(outside, JSON.stringify(header()) + "\n", "utf8");

  await assert.rejects(readArchive(outside, a.agentDir), /refusing to read/);
  await assert.rejects(readArchive(join(a.archiveRoot, "missing.jsonl"), a.agentDir), /not found/);
  await assert.rejects(readArchive(a.archiveRoot, a.agentDir), /not a file/);

  const link = join(a.archiveRoot, "link.jsonl");
  await symlink(outside, link);
  await assert.rejects(readArchive(link, a.agentDir), /refusing to read/);

  await assert.rejects(
    readArchive(outside, join(a.root, "no-agent")),
    /archive directory is unavailable/,
  );
});

// ---------------------------------------------------------------------------
// readRunRecords
// ---------------------------------------------------------------------------

function baseRun(id: string): Record<string, unknown> {
  return {
    id,
    label: "label",
    task: "task",
    status: "working",
    model: { provider: "anthropic", id: "claude" },
    thinking: "medium",
    createdAt: 1_000,
    activity: "working",
    delivery: "none",
  };
}

function recordEntry(
  id: string,
  runOverrides: Record<string, unknown> = {},
  dataOverrides: Record<string, unknown> = {},
): SessionEntry {
  return {
    type: "custom",
    id: "entry-" + id,
    parentId: null,
    timestamp: "2024-01-01T00:00:00.000Z",
    customType: RUN_RECORD_TYPE,
    data: {
      version: 1,
      owner: "owner-id",
      anchor: "anchor-id",
      run: { ...baseRun(id), ...runOverrides },
      ...dataOverrides,
    },
  } as unknown as SessionEntry;
}

test("readRunRecords keeps the latest valid v1 record per run", async () => {
  const records = readRunRecords([
    recordEntry(RUN_A, { status: "starting" }),
    recordEntry(RUN_B),
    recordEntry(RUN_A, { status: "idle", finishedAt: 2_000 }),
  ]);

  assert.deepEqual(
    records.map((record) => record.run.id),
    [RUN_A, RUN_B],
  );
  assert.equal(records[0]?.run.status, "idle");
  assert.equal(records[0]?.run.finishedAt, 2_000);
  assert.equal(records[1]?.run.status, "working");
  assert.equal(records[0]?.version, 1);
  assert.equal(records[0]?.owner, "owner-id");
  assert.equal(records[0]?.anchor, "anchor-id");
});

test("readRunRecords strips unknown fields from stored run data", async () => {
  const entry = recordEntry(RUN_A, {
    transcript: { secret: true },
    finalText: "should not survive",
  });
  const records = readRunRecords([entry]);
  assert.equal(records.length, 1);
  assert.ok(!("transcript" in (records[0]?.run ?? {})));
  assert.ok(!("finalText" in (records[0]?.run ?? {})));
});

test("readRunRecords tolerates invalid, forged, and non-peeps records", async () => {
  const entries: SessionEntry[] = [
    recordEntry(RUN_A, { id: "not-a-uuid" }),
    recordEntry(RUN_A, { status: "bogus" }),
    recordEntry(RUN_A, { delivery: "teleported" }),
    recordEntry(RUN_A, { thinking: "galaxy" }),
    recordEntry(RUN_A, { model: { provider: "", id: "claude" } }),
    recordEntry(RUN_A, {}, { version: 2 }),
    recordEntry(RUN_A, {}, { anchor: 42 }),
    recordEntry(RUN_A, {}, { owner: "../bad" }),
    {
      type: "custom",
      id: "other",
      parentId: null,
      timestamp: "2024-01-01T00:00:00.000Z",
      customType: "other/extension",
      data: { version: 1 },
    } as unknown as SessionEntry,
    recordEntry(RUN_B, { model: { provider: "anthropic", id: "claude" } }),
  ];

  const records = readRunRecords(entries);
  assert.deepEqual(
    records.map((record) => record.run.id),
    [RUN_B],
  );
});

test("readRunRecords keeps an earlier valid record when a duplicate is invalid", async () => {
  const records = readRunRecords([
    recordEntry(RUN_A, { status: "closed" }),
    recordEntry(RUN_A, { status: "not-a-status" }),
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.run.status, "closed");
});
