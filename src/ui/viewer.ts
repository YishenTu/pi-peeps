import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, KeybindingsManager, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { isTerminal } from "../contracts.ts";
import type { RunView, ViewSource } from "../contracts.ts";
import { clamp, fitLine, frameFreeRows, frameInnerWidth, overlayLayout, padLine, renderFrame, ScrollWindow } from "./window.ts";
import { TranscriptRenderer } from "./render.ts";
import type { ItemFactory } from "./render.ts";
import { statusColor, statusGlyph, summarize } from "./status.ts";

export interface ViewerOptions {
  source: ViewSource;
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  cwd: string;
  factory: ItemFactory;
  initialId?: string;
  getTheme?: () => Theme;
  done: () => void;
}


/** One display line; the frame truncates it to fit. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Read-only overlay for the peeps list and a single run transcript.
 *
 * The overlay owns keyboard focus while open but never replaces the editor or
 * touches the Pi session. Closing it via done() restores the previous focus.
 */
export class ViewerComponent implements Component {
  private readonly options: ViewerOptions;
  private readonly renderer: TranscriptRenderer;
  private readonly unsubscribe: () => void;
  private readonly windows = new Map<string, ScrollWindow>();
  private readonly requested = new Set<string>();
  private readonly loadErrors = new Map<string, { transcript: RunView["transcript"] | undefined; message: string }>();
  private mode: "list" | "thread";
  private selectedId: string | undefined;
  private renderedRunId: string | undefined;
  private renderedTranscript: RunView["transcript"] | undefined;
  private pinnedId: string | undefined;
  private releasePin?: () => void;
  private theme: Theme;
  private expanded = false;
  private hideThinking = true;
  private hideFinished = false;
  private disposed = false;
  private closed = false;
  private scheduled = false;

  constructor(options: ViewerOptions) {
    this.options = options;
    this.theme = options.theme;
    this.selectedId = options.initialId;
    this.mode = options.initialId ? "thread" : "list";
    this.renderer = new TranscriptRenderer(options.factory, options.theme);
    this.unsubscribe = options.source.subscribe(() => this.schedule());
    if (options.initialId) this.ensureLoaded(options.initialId);
  }

  invalidate(): void {
    this.renderer.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.releaseThread();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.options.done();
  }

  render(width: number): string[] {
    const theme = this.resolveTheme();
    const height = overlayLayout(this.options.tui).height;
    const lines = this.mode === "list" ? this.renderList(width, height, theme) : this.renderThread(width, height, theme);
    return lines.slice(0, height);
  }

  handleInput(data: string): void {
    const keybindings = this.options.keybindings;
    if (keybindings.matches(data, "app.tools.expand")) {
      this.expanded = !this.expanded;
      this.requestRender();
      return;
    }
    if (keybindings.matches(data, "app.thinking.toggle")) {
      this.hideThinking = !this.hideThinking;
      this.requestRender();
      return;
    }
    if (matchesKey(data, "ctrl+c")) {
      this.close();
      return;
    }
    if (matchesKey(data, "escape")) {
      if (this.mode === "thread") {
        this.releaseThread();
        this.mode = "list";
        this.requestRender();
      } else {
        this.close();
      }
      return;
    }
    if (this.mode === "list") this.handleListInput(data);
    else this.handleThreadInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "wheel") return undefined;
    const delta = event.wheelDelta ?? 0;
    if (delta === 0) return undefined;
    const steps = Math.max(1, Math.abs(Math.round(delta)));
    if (this.mode === "list") {
      this.moveSelection(delta > 0 ? steps : -steps);
    } else {
      const run = this.currentRun();
      if (!run) return undefined;
      const window = this.windowFor(run.id);
      if (delta > 0) window.scrollDown(steps);
      else window.scrollUp(steps);
    }
    this.requestRender();
    return { handled: true };
  }

  private resolveTheme(): Theme {
    const theme = this.options.getTheme ? this.options.getTheme() : this.theme;
    if (theme !== this.theme) {
      this.theme = theme;
      this.renderer.setTheme(theme);
    }
    return theme;
  }

  private currentRun(): RunView | undefined {
    return this.selectedId ? this.options.source.get(this.selectedId) : undefined;
  }

  /** List-mode rows; the status summary still counts every run. */
  private listRuns(): RunView[] {
    const runs = this.options.source.list();
    return this.hideFinished ? runs.filter(run => !isTerminal(run.status)) : [...runs];
  }

  private renderList(width: number, height: number, theme: Theme): string[] {
    const all = this.options.source.list();
    const runs = this.listRuns();
    const selected = runs.length ? clamp(this.listIndex(runs), 0, runs.length - 1) : -1;
    const run = runs[selected];
    const detail = run ? this.runDetail(run, theme) : [];
    const rows = frameFreeRows(height, detail.length, detail.length ? 2 : 1);
    const body: string[] = [];
    if (runs.length === 0) {
      body.push(theme.fg("muted", all.length
        ? "All subagents are finished. Press h to show them."
        : "No subagents yet. Ask the main agent to delegate a task."));
    } else {
      const labelWidth = clamp(Math.max(...runs.map((r) => visibleWidth(r.label || r.id))), 8, 28);
      const start = clamp(selected - rows + 1, 0, Math.max(0, runs.length - rows));
      for (const [offset, item] of runs.slice(start, start + rows).entries()) {
        body.push(this.listRow(item, start + offset === selected, labelWidth, theme));
      }
    }
    while (body.length < rows) body.push(""); // Keep the preview pinned above the footer.
    return renderFrame(theme, width, height, {
      title: theme.bold(theme.fg("accent", "Peeps")),
      status: theme.fg("muted", summarize(all)),
      blocks: detail.length ? [body, detail] : [body],
      footerLeft: theme.fg("dim", (all.length === 1 ? "1 subagent" : all.length + " subagents") +
        (all.length > runs.length ? " · " + (all.length - runs.length) + " hidden" : "")),
      footerRight: theme.fg("dim", "↑↓ select · enter open · " + (this.hideFinished ? "h show all" : "h hide finished") + " · esc close"),
    });
  }

  private listRow(run: RunView, selected: boolean, labelWidth: number, theme: Theme): string {
    const marker = selected ? theme.fg("accent", "› ") : "  ";
    const symbol = theme.fg(statusColor(run), statusGlyph(run));
    const label = padLine(fitLine(run.label || run.id, labelWidth), labelWidth);
    const status = padLine(run.status, 11);
    return marker + symbol + " " + theme.fg(selected ? "accent" : "text", label) + "  " +
      theme.fg(statusColor(run), status) + theme.fg("muted", run.model.id + " · " + (run.activity || run.task));
  }

  /** Model, task, and outcome of one run, shared by the list preview and the thread header. */
  private runDetail(run: RunView, theme: Theme): string[] {
    const info = [
      run.model.provider + "/" + run.model.id,
      run.thinking,
      run.delivery !== "none" ? "result " + run.delivery : "",
      run.id.slice(0, 8),
    ].filter(Boolean).join(" · ");
    const lines = [theme.fg("muted", info), theme.fg("dim", "Task  ") + oneLine(run.task)];
    if (run.error) lines.push(theme.fg("error", oneLine(run.error)));
    return lines;
  }

  private renderThread(width: number, height: number, theme: Theme): string[] {
    const run = this.currentRun();
    if (!run) {
      return renderFrame(theme, width, height, {
        title: theme.bold(theme.fg("accent", "Peeps")),
        blocks: [[theme.fg("error", "This subagent is no longer available.")]],
        footerRight: theme.fg("dim", "esc back"),
      });
    }

    const header = this.runDetail(run, theme);
    const bodyHeight = frameFreeRows(height, header.length, 2);
    const window = this.windowFor(run.id);
    window.setViewport(bodyHeight);
    // Item IDs are local to a transcript, including replacements on resume.
    if (this.renderedRunId !== run.id || this.renderedTranscript !== run.transcript) {
      this.renderer.invalidate();
      this.renderedRunId = run.id;
      this.renderedTranscript = run.transcript;
    }
    const rendered = this.renderer.render(run.transcript.items, frameInnerWidth(width), {
      expanded: this.expanded,
      hideThinking: this.hideThinking,
    });
    window.setContentHeight(rendered.lines.length);
    window.refresh();
    const loadError = this.loadErrors.get(run.id);
    const body = loadError?.transcript === run.transcript
      ? [theme.fg("error", loadError.message)] : window.window(rendered.lines);

    const total = rendered.lines.length;
    const position = total === 0
      ? "empty"
      : (window.scrollTop + 1) + "–" + Math.min(total, window.scrollTop + bodyHeight) + " of " + total +
        (window.follow ? " · following" : " · paused");
    return renderFrame(theme, width, height, {
      title: theme.bold(theme.fg("accent", run.label || run.id)),
      status: theme.fg(statusColor(run), statusGlyph(run) + " " + run.status),
      blocks: [header, body],
      footerLeft: theme.fg("dim", position),
      footerRight: theme.fg("dim", "↑↓ scroll · ^O tools · ^T thinking · esc back"),
    });
  }

  private handleListInput(data: string): void {
    if (matchesKey(data, "h")) {
      this.hideFinished = !this.hideFinished;
      this.requestRender();
      return;
    }
    const runs = this.listRuns();
    if (runs.length === 0) return;
    const index = this.listIndex(runs);
    if (matchesKey(data, "up")) this.setListIndex(runs, index - 1);
    else if (matchesKey(data, "down")) this.setListIndex(runs, index + 1);
    else if (matchesKey(data, "pageUp")) this.setListIndex(runs, index - 8);
    else if (matchesKey(data, "pageDown")) this.setListIndex(runs, index + 8);
    else if (matchesKey(data, "home")) this.setListIndex(runs, 0);
    else if (matchesKey(data, "end")) this.setListIndex(runs, runs.length - 1);
    else if (matchesKey(data, "enter")) {
      const run = runs[index];
      if (run) this.openRun(run.id);
    }
  }

  private handleThreadInput(data: string): void {
    const run = this.currentRun();
    if (!run) return;
    const window = this.windowFor(run.id);
    if (matchesKey(data, "up")) window.scrollUp();
    else if (matchesKey(data, "down")) window.scrollDown();
    else if (matchesKey(data, "pageUp")) window.pageUp();
    else if (matchesKey(data, "pageDown")) window.pageDown();
    else if (matchesKey(data, "home")) window.home();
    else if (matchesKey(data, "end")) window.end();
    else return;
    this.requestRender();
  }

  private moveSelection(delta: number): void {
    const runs = this.listRuns();
    if (runs.length === 0) return;
    this.setListIndex(runs, this.listIndex(runs) + delta);
  }

  private setListIndex(runs: readonly RunView[], index: number): void {
    const run = runs[clamp(index, 0, runs.length - 1)];
    if (!run) return;
    this.selectedId = run.id;
    this.requestRender();
  }

  private listIndex(runs: readonly RunView[]): number {
    if (!this.selectedId) return 0;
    const index = runs.findIndex((run) => run.id === this.selectedId);
    return index < 0 ? 0 : index;
  }

  private openRun(id: string): void {
    this.selectedId = id;
    this.mode = "thread";
    this.ensureLoaded(id);
    this.requestRender();
  }

  private releaseThread(): void {
    this.releasePin?.();
    this.releasePin = undefined;
    if (this.pinnedId) this.requested.delete(this.pinnedId);
    this.pinnedId = undefined;
    this.renderedTranscript = undefined;
    this.renderer.invalidate();
  }

  private ensureLoaded(id: string): void {
    if (this.pinnedId !== id) {
      this.releaseThread();
      this.pinnedId = id;
      this.releasePin = this.options.source.retainTranscript?.(id);
    }
    if (this.requested.has(id)) return;
    this.requested.add(id);
    const transcript = this.options.source.get(id)?.transcript;
    let pending: Promise<void>;
    try {
      pending = this.options.source.loadTranscript(id);
    } catch (error) {
      this.loadErrors.set(id, { transcript, message: String(error) });
      this.requested.delete(id);
      return;
    }
    pending.then(
      () => { this.loadErrors.delete(id); this.requestRender(); },
      error => {
        this.loadErrors.set(id, { transcript, message: String(error) });
        this.requested.delete(id);
        this.requestRender();
      },
    );
  }

  private windowFor(id: string): ScrollWindow {
    const existing = this.windows.get(id);
    if (existing) return existing;
    const created = new ScrollWindow();
    this.windows.set(id, created);
    return created;
  }

  private requestRender(): void {
    if (this.disposed) return;
    this.options.tui.requestRender();
  }

  private schedule(): void {
    if (this.disposed || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.requestRender();
    });
  }
}

const activeViewers = new Set<ViewerComponent>();

/** Track an open viewer so the owner can close it on session shutdown. */
export function trackViewer(viewer: ViewerComponent): () => void {
  activeViewers.add(viewer);
  return () => {
    activeViewers.delete(viewer);
  };
}

/** Close every open viewer overlay (used by the owner on session shutdown). */
export function closeAllViewers(): void {
  for (const viewer of Array.from(activeViewers)) viewer.close();
}
