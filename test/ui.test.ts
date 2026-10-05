import test from "node:test";
import assert from "node:assert/strict";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RunView, TranscriptItem, ViewSource } from "../src/contracts.ts";
import { fitLine, overlayLayout, renderFrame, ScrollWindow } from "../src/ui/window.ts";
import { TranscriptRenderer } from "../src/ui/render.ts";
import type { ItemComponent, ItemFactory } from "../src/ui/render.ts";
import { ViewerComponent } from "../src/ui/viewer.ts";
import { Transcript } from "../src/transcript.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as unknown as Theme;

const otherTheme = {} as unknown as Theme;

const messageItem = (id: string, version: number): TranscriptItem => ({
  kind: "message",
  id,
  version,
  streaming: false,
  message: { role: "user", content: "hello", timestamp: 1 } as AgentMessage,
});

class StubComponent implements ItemComponent {
  renders = 0;
  updates = 0;
  expanded = false;
  hideThinking = false;

  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(): string[] {
    this.renders += 1;
    return [this.text];
  }

  invalidate(): void {}

  update(): void {
    this.updates += 1;
  }

  setExpanded(value: boolean): void {
    this.expanded = value;
  }

  setHideThinking(value: boolean): void {
    this.hideThinking = value;
  }
}

class FakeSource implements ViewSource {
  subscribed = 0;
  unsubscribed = 0;
  loadCalls = 0;
  runs: RunView[] = [];
  private listeners = new Set<() => void>();

  list(): readonly RunView[] {
    return this.runs;
  }

  get(id: string): RunView | undefined {
    return this.runs.find((run) => run.id === id);
  }

  subscribe(listener: () => void): () => void {
    this.subscribed += 1;
    this.listeners.add(listener);
    return () => {
      this.unsubscribed += 1;
      this.listeners.delete(listener);
    };
  }

  async loadTranscript(id: string): Promise<void> {
    this.loadCalls += 1;
    void id;
  }

  emit(): void {
    for (const listener of Array.from(this.listeners)) listener();
  }
}

const fakeTui = (columns = 80, rows = 24): { tui: TUI; requests: () => number } => {
  let requests = 0;
  const tui = {
    terminal: { columns, rows },
    requestRender: () => {
      requests += 1;
    },
  } as unknown as TUI;
  return { tui, requests: () => requests };
};

const keybindings = new KeybindingsManager({
  ...TUI_KEYBINDINGS,
  "app.tools.expand": { defaultKeys: "ctrl+o" },
  "app.thinking.toggle": { defaultKeys: "ctrl+t" },
});

const runView = (id: string, transcript: Transcript): RunView => ({
  id,
  label: id,
  task: "task text",
  status: "working",
  model: { provider: "test", id: "model" },
  thinking: "off",
  createdAt: 0,
  activity: "working",
  reports: 0,
  delivery: "none",
  transcript,
});

test("scroll window follows content and pauses follow on scroll up", () => {
  const window = new ScrollWindow();
  window.setViewport(5);
  window.setContentHeight(20);
  window.refresh();
  assert.equal(window.scrollTop, 15);
  assert.equal(window.follow, true);

  window.scrollUp(3);
  assert.equal(window.scrollTop, 12);
  assert.equal(window.follow, false);

  window.scrollDown(100);
  assert.equal(window.scrollTop, 15);
  assert.equal(window.follow, true, "scrolling back to the bottom resumes follow");

  window.home();
  assert.equal(window.scrollTop, 0);
  assert.equal(window.follow, false);
  window.end();
  assert.equal(window.scrollTop, 15);
  assert.equal(window.follow, true);

  window.setContentHeight(30);
  window.refresh();
  assert.equal(window.scrollTop, 25, "followed content anchors to the new bottom");
});

test("scroll window pages by viewport and clamps at the edges", () => {
  const window = new ScrollWindow();
  window.setViewport(10);
  window.setContentHeight(50);
  window.end();
  window.pageUp();
  assert.equal(window.scrollTop, 31);
  window.pageDown();
  assert.equal(window.scrollTop, 40);
  window.home();
  window.scrollUp(5);
  assert.equal(window.scrollTop, 0);
});

test("frame lines and overlay geometry are width and row safe", () => {
  assert.equal(fitLine("abc", 10), "abc");
  assert.ok(visibleWidth(fitLine("日本語日本語", 5)) <= 5);
  // Full-screen: the component renders exactly the compositor's 100% x 100% rectangle.
  assert.deepEqual(overlayLayout({ terminal: { columns: 100, rows: 30 } }), { width: 100, height: 30 });
  assert.deepEqual(overlayLayout(undefined), { width: 80, height: 24 });
  for (const [width, height] of [[100, 30], [30, 10], [8, 3], [5, 2]] as const) {
    const lines = renderFrame(theme, width, height, {
      title: "a-very-long-subagent-label-that-overflows", status: "● running",
      blocks: [["header ".repeat(30)], ["日本語".repeat(20), "x"]],
      footerLeft: "1–2 of 2 · following", footerRight: "↑↓ scroll · ^O tools · ^T thinking · esc back",
    });
    assert.equal(lines.length, height, `exactly ${height} rows at ${width}x${height}`);
    for (const line of lines) assert.equal(visibleWidth(line), width, `opaque rows are exactly ${width} wide: ${line}`);
  }
});

test("transcript renderer clamps width and caches by version, width, and theme", () => {
  const created: StubComponent[] = [];
  const factory: ItemFactory = {
    create: () => {
      const component = new StubComponent("日本語".repeat(10));
      created.push(component);
      return component;
    },
  };
  const renderer = new TranscriptRenderer(factory, theme);
  const item = messageItem("m:1", 0);

  const first = renderer.render([item], 6, { expanded: false, hideThinking: true });
  assert.equal(created.length, 1);
  assert.equal(first.anchors.length, 1);
  assert.equal(first.anchors[0]?.start, 0);
  for (const line of first.lines) assert.ok(visibleWidth(line) <= 6, "every line fits the frame width");
  const firstRenders = created[0]!.renders;

  renderer.render([item], 6, { expanded: false, hideThinking: true });
  assert.equal(created.length, 1, "unchanged item reuses its component");
  assert.equal(created[0]!.renders, firstRenders, "unchanged item does not re-render");

  const versioned = messageItem("m:1", 1);
  renderer.render([versioned], 6, { expanded: false, hideThinking: true });
  assert.equal(created.length, 1);
  assert.equal(created[0]!.updates, 1, "version bump updates in place");

  renderer.render([versioned], 6, { expanded: true, hideThinking: true });
  assert.equal(created.length, 1);
  assert.equal(created[0]!.expanded, true, "expansion state triggers a re-render");

  renderer.setTheme(otherTheme);
  renderer.render([versioned], 6, { expanded: true, hideThinking: true });
  assert.equal(created.length, 2, "theme change clears the cache");
});

test("viewer subscribes on mount, disposes subscriptions, and closes once", async () => {
  const source = new FakeSource();
  const { tui, requests } = fakeTui();
  const created: StubComponent[] = [];
  const factory: ItemFactory = {
    create: () => {
      const component = new StubComponent("body");
      created.push(component);
      return component;
    },
  };
  let doneCalls = 0;
  const viewer = new ViewerComponent({
    source,
    tui,
    theme,
    keybindings,
    cwd: "/tmp",
    factory,
    done: () => {
      doneCalls += 1;
    },
  });

  assert.equal(source.subscribed, 1);
  source.emit();
  await Promise.resolve();
  assert.ok(requests() >= 1, "source updates request a coalesced render");

  const transcript = new Transcript();
  transcript.restore([{ role: "user", content: "hello", timestamp: 1 }]);

  viewer.handleInput("\r");
  assert.equal(source.loadCalls, 0, "list selection without a run does not load");

  source.runs = [runView("run-1", transcript)];
  viewer.handleInput("down");
  viewer.handleInput("\r");
  assert.equal(source.loadCalls, 1, "opening a run loads its transcript");

  viewer.handleInput("\u000f"); // ctrl+o expands tools
  const lines = viewer.render(60);
  for (const line of lines) assert.ok(visibleWidth(line) <= 60);
  assert.equal(created.length > 0, true);
  assert.equal(created[created.length - 1]!.expanded, true);

  viewer.close();
  viewer.close();
  assert.equal(doneCalls, 1, "close is idempotent");

  viewer.dispose();
  assert.equal(source.unsubscribed, 1, "dispose releases the source subscription");
});

test("viewer h toggles finished subagents out of the list without changing the summary", () => {
  const source = new FakeSource();
  const { tui } = fakeTui();
  const factory: ItemFactory = { create: () => new StubComponent("body") };
  const viewer = new ViewerComponent({ source, tui, theme, keybindings, cwd: "/tmp", factory, done: () => {} });
  const live = runView("live", new Transcript());
  const done = { ...runView("done", new Transcript()), status: "closed" as const };
  const broke = { ...runView("broke", new Transcript()), status: "failed" as const };
  source.runs = [done, live, broke];
  const text = () => viewer.render(80).join("\n");

  assert.ok(text().includes("done") && text().includes("broke") && text().includes("h hide finished"));
  viewer.handleInput("h");
  let shown = text();
  assert.ok(shown.includes("live") && !shown.includes("done") && !shown.includes("broke"));
  assert.ok(shown.includes("3 subagents · 2 hidden") && shown.includes("h show all"));
  assert.ok(shown.includes("1 working"), "summary still counts hidden runs");

  source.runs = [done, broke];
  assert.ok(text().includes("All subagents are finished. Press h to show them."));
  viewer.handleInput("h");
  shown = text();
  assert.ok(shown.includes("done") && shown.includes("broke"));
  viewer.dispose();
});

test("viewer escape returns from thread to list before closing", () => {
  const source = new FakeSource();
  const transcript = new Transcript();
  transcript.restore([{ role: "user", content: "hello", timestamp: 1 }]);
  source.runs = [runView("run-1", transcript)];
  const { tui } = fakeTui();
  let doneCalls = 0;
  const viewer = new ViewerComponent({
    source,
    tui,
    theme,
    keybindings,
    cwd: "/tmp",
    factory: { create: () => new StubComponent("body") },
    initialId: "run-1",
    done: () => {
      doneCalls += 1;
    },
  });

  viewer.handleInput("\u001b");
  assert.equal(doneCalls, 0, "escape in thread mode returns to the list");
  viewer.handleInput("\u001b");
  assert.equal(doneCalls, 1, "escape in list mode closes the viewer");
  assert.equal(source.loadCalls, 1, "initial id loads its transcript");
  viewer.dispose();
});

test("switching children with identical local item IDs does not reuse another thread", () => {
  const source = new FakeSource();
  const first = new Transcript(), second = new Transcript();
  first.restore([{ role: "user", content: "FIRST-CHILD", timestamp: 1 }]);
  second.restore([{ role: "user", content: "SECOND-CHILD", timestamp: 2 }]);
  source.runs = [runView("one", first), runView("two", second)];
  const { tui } = fakeTui();
  const viewer = new ViewerComponent({
    source, tui, theme, keybindings, cwd: "/tmp", initialId: "one", done: () => {},
    factory: { create: item => new StubComponent(item.kind === "message" && item.message.role === "user" && typeof item.message.content === "string" ? item.message.content : "") },
  });
  assert.ok(viewer.render(80).join("\n").includes("FIRST-CHILD"));
  viewer.handleInput("\u001b");
  viewer.handleInput("\u001b[B");
  viewer.handleInput("\r");
  const lines = viewer.render(80).join("\n");
  assert.ok(lines.includes("SECOND-CHILD"));
  assert.ok(!lines.includes("FIRST-CHILD"));
  viewer.dispose();
});

test("thread reader leases are released on back and disposal, without owning child lifetime", () => {
  const source = new FakeSource();
  const transcript = new Transcript();
  source.runs = [runView("one", transcript)];
  let readers = 0;
  const view: ViewSource = Object.assign(source, {
    retainTranscript: () => { readers++; return () => { readers--; }; },
  });
  const { tui } = fakeTui();
  const viewer = new ViewerComponent({
    source: view, tui, theme, keybindings, cwd: "/tmp", initialId: "one",
    factory: { create: () => new StubComponent("body") }, done: () => {},
  });
  assert.equal(readers, 1);
  viewer.handleInput("\u001b");
  assert.equal(readers, 0);
  viewer.handleInput("\r");
  assert.equal(readers, 1);
  viewer.dispose();
  viewer.dispose();
  assert.equal(readers, 0);
  assert.equal(source.runs[0]!.status, "working");
});

test("viewer closes on ctrl+c without aborting", () => {
  const source = new FakeSource();
  const { tui } = fakeTui();
  let doneCalls = 0;
  const viewer = new ViewerComponent({
    source,
    tui,
    theme,
    keybindings,
    cwd: "/tmp",
    factory: { create: () => new StubComponent("body") },
    done: () => {
      doneCalls += 1;
    },
  });
  viewer.handleInput("\u0003");
  assert.equal(doneCalls, 1);
  viewer.dispose();
});
