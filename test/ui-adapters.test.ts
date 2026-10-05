import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme, type Theme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, type TUI, type Component, type OverlayOptions } from "@earendil-works/pi-tui";
import { Transcript } from "../src/transcript.ts";
import { mountOverview } from "../src/ui/overview.ts";
import { openViewer } from "../src/ui/open.ts";
import { createNativeItemFactory } from "../src/ui/native.ts";
import { closeAllViewers } from "../src/ui/viewer.ts";
import type { RunView, ViewSource } from "../src/contracts.ts";

initTheme("dark", false); // Built-in theme, no filesystem watcher or personal config.
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text,
  bold: (text: string) => text, italic: (text: string) => text } as unknown as Theme;
function source() {
  const listeners = new Set<() => void>();
  const runs: RunView[] = [];
  const view: ViewSource = {
    list: () => runs, get: id => runs.find(r => r.id === id),
    subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    loadTranscript: async () => {},
  };
  const run = (id: string, status: RunView["status"], delivery: RunView["delivery"] = "none"): RunView => ({
    id, label: id, task: "task", status, delivery, createdAt: runs.length,
    model: { provider: "fake", id: "scripted" }, thinking: "off", activity: status, reports: 0, transcript: new Transcript(),
  });
  return { view, runs, listeners, run };
}
function terminal() {
  const raw = { terminal: { columns: 80, rows: 24 }, requestRender() {} };
  return { raw, tui: raw as unknown as TUI };
}
const keys = new KeybindingsManager({
  ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o" }, "app.thinking.toggle": { defaultKeys: "ctrl+t" },
});

test("overview caps child rows with an overflow line, shows working children before idle ones, and disposes its subscription", () => {
  const s = source(), { tui } = terminal();
  s.runs.push(s.run("old", "closed"), s.run("live", "working"), s.run("waiting", "idle", "held"));
  let widget: (Component & { dispose?: () => void }) | undefined;
  const ctx = { ui: { setWidget: (_key: string, factory: any) => { widget = factory?.(tui, theme); } } } as unknown as ExtensionContext;
  const dispose = mountOverview(ctx, s.view);
  const lines = widget!.render(100);
  assert.equal(lines.length, 3, "a closed child with nothing pending is left to /peeps");
  assert.ok(lines[0]!.includes("1 working · 1 idle") && !lines[0]!.includes("closed"));
  assert.ok(lines[1]!.includes("live"));
  assert.ok(lines[2]!.includes("waiting") && lines[2]!.includes("result held"));
  s.runs.push(s.run("unsent", "closed", "held"));
  assert.ok(widget!.render(100).some(line => line.includes("unsent")), "a closed child with a pending result stays");
  assert.equal(s.listeners.size, 1);
  for (let i = 0; i < 2; i++) s.runs.push(s.run("extra" + i, "working"));
  assert.equal(widget!.render(100).length, 6);
  s.runs.push(s.run("extra3", "working"));
  let overflow = widget!.render(100);
  assert.equal(overflow.length, 7);
  assert.equal(overflow[6]!.trim(), "1 more agent, /peeps to check");
  s.runs.push(s.run("extra4", "working"));
  overflow = widget!.render(100);
  assert.equal(overflow[6]!.trim(), "2 more agents, /peeps to check");
  dispose();
  assert.equal(s.listeners.size, 0);
  assert.equal(widget, undefined);
});

test("native overlay fills the terminal and adapts to shrink/growth", async t => {
  t.after(() => closeAllViewers());
  const s = source(), { tui, raw } = terminal();
  const run = s.run("native-thread", "closed");
  const transcript = new Transcript();
  transcript.restore([
    { role: "user", content: "Native user", timestamp: 1 },
    { role: "custom", customType: "test", content: "Native notice", display: true, timestamp: 2 },
  ]);
  run.transcript = transcript;
  s.runs.push(run);
  let component!: Component & { dispose(): void };
  let overlay!: OverlayOptions;
  let done!: () => void;
  const ctx = {
    mode: "tui", hasUI: true, cwd: "/tmp",
    ui: { theme, custom: async (factory: any, options: any) => new Promise<void>(resolve => {
      done = () => { component.dispose(); resolve(); };
      component = factory(tui, theme, keys, done);
      overlay = typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
    }) },
  } as unknown as ExtensionContext;
  const opened = openViewer(ctx, s.view, run.id);
  assert.deepEqual([overlay.width, overlay.maxHeight, overlay.margin], ["100%", "100%", 0]);
  for (const [columns, rows] of [[80, 24], [60, 12], [140, 60], [80, 24]] as const) {
    raw.terminal.columns = columns;
    raw.terminal.rows = rows;
    const lines = component.render(columns); // The compositor renders a 100% overlay at full width.
    assert.equal(lines.length, rows, "the viewer fills the screen so the parent cannot show through");
    assert.ok(lines.at(-1)!.includes("following"), "footer stays inside composited viewport after resize");
    for (const line of lines) assert.equal(visibleWidth(line), columns);
    if (rows >= 22) assert.ok(lines.join("\n").includes("Native user"));
  }
  closeAllViewers();
  await opened;
  assert.equal(s.listeners.size, 0);
});

test("failed archive reads are visible in the thread instead of a blank silent view", async () => {
  const s = source(), { tui } = terminal();
  s.runs.push(s.run("missing", "closed"));
  s.view.loadTranscript = async () => { throw new Error("Archive unavailable"); };
  let component!: Component & { dispose(): void };
  const ctx = { mode: "tui", hasUI: true, cwd: "/tmp", ui: { theme,
    custom: async (factory: any) => new Promise<void>(resolve => {
      component = factory(tui, theme, keys, () => { component.dispose(); resolve(); });
    }),
  } } as unknown as ExtensionContext;
  const opened = openViewer(ctx, s.view, "missing");
  await Promise.resolve();
  assert.match(component.render(78).join("\n"), /Archive unavailable/);
  closeAllViewers();
  await opened;
});

test("native tool items collapse long output until expanded", () => {
  const { tui } = terminal();
  const factory = createNativeItemFactory({ tui, theme, cwd: "/tmp" });
  const output = Array.from({ length: 30 }, (_, i) => "line " + i).join("\n");
  const item = factory.create({ kind: "tool", id: "t1", version: 1, toolName: "read", args: { path: "a.txt" }, started: true,
    complete: true, result: { content: [{ type: "text", text: output }], details: undefined, isError: false } } as never);
  item.setExpanded!(false);
  const collapsed = item.render(80);
  item.setExpanded!(true);
  const expanded = item.render(80);
  assert.ok(collapsed.length < expanded.length);
  assert.ok(!collapsed.join("\n").includes("line 29") && expanded.join("\n").includes("line 29"));
});

test("built-in tools render like the main view, and running shell items leave no timer behind", t => {
  const { tui } = terminal();
  const factory = createNativeItemFactory({ tui, theme, cwd: "/tmp" });
  const timers: unknown[] = [];
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
  globalThis.setInterval = ((fn: () => void, ms: number) => { const id = realSet(fn, ms); timers.push(id); return id; }) as typeof setInterval;
  globalThis.clearInterval = ((id: Parameters<typeof clearInterval>[0]) => { timers.splice(timers.indexOf(id), 1); realClear(id); }) as typeof clearInterval;
  t.after(() => { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; });

  const bash = factory.create({ kind: "tool", id: "b1", version: 1, toolName: "bash", args: { command: "echo hi" }, started: true,
    complete: false, result: { content: [{ type: "text", text: "hi" }], details: undefined, isError: false } } as never);
  const text = bash.render(80).join("\n");
  assert.ok(text.includes("$ echo hi"), text);
  assert.ok(!text.includes('"command"'), "no raw JSON args");
  assert.equal(timers.length, 0);

  const custom = factory.create({ kind: "tool", id: "c1", version: 1, toolName: "my_tool", args: { x: 1 }, started: true,
    complete: true, result: { content: [{ type: "text", text: "ok" }], details: undefined, isError: false } } as never);
  assert.ok(custom.render(80).join("\n").includes("my_tool"));
});

test("codemode renders with Pi's own codemode renderer", () => {
  const { tui } = terminal();
  const factory = createNativeItemFactory({ tui, theme, cwd: "/tmp" });
  const code = 'text(await tools.read({path:"a.md"}));';
  const item = factory.create({ kind: "tool", id: "cm1", version: 1, toolName: "codemode", args: { code }, started: true,
    complete: true, result: { content: [{ type: "text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" },
      { type: "text", text: "hello" }], details: { calls: [{ name: "read", args: '{"path":"a.md"}', status: "ok", durationMs: 1 }] },
      isError: false } } as never);
  const text = item.render(80).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(text.includes(code), text);
  assert.ok(text.includes('✓ read {"path":"a.md"}') && text.includes("hello"), text);
  assert.ok(!text.includes("code=") && !text.includes("Script completed"), text);
});
