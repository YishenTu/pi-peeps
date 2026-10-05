import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fitLine } from "./window.ts";
import { isTerminal } from "../contracts.ts";
import type { RunView, ViewSource } from "../contracts.ts";
import { statusColor, statusGlyph, summarize } from "./status.ts";

export const OVERVIEW_WIDGET_KEY = "peeps-overview";

const MAX_ROWS = 5; // Plus the counts header and an overflow line: at most seven widget rows.

/**
 * Compact display-only overview. It never takes input ownership; live updates
 * arrive through the ViewSource subscription, so no timers are installed.
 */
export class OverviewComponent implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly source: ViewSource;
  private unsubscribe: () => void;
  private disposed = false;
  private scheduled = false;

  constructor(tui: TUI, theme: Theme, source: ViewSource) {
    this.tui = tui;
    this.theme = theme;
    this.source = source;
    this.unsubscribe = source.subscribe(() => this.schedule());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
  }

  invalidate(): void {
    // Stateless render; nothing cached.
  }

  render(width: number): string[] {
    const pending = (run: RunView) => ["held", "unconfirmed", "failed"].includes(run.delivery);
    // Closed children stay in /peeps; the widget keeps only those whose result may not have arrived.
    const runs = this.source.list().filter(run => run.status !== "closed" || pending(run));
    if (runs.length === 0) return [];
    const lines: string[] = [];
    lines.push(fitLine(this.theme.bold(this.theme.fg("accent", "Peeps")) + this.theme.fg("muted", "  " + summarize(runs)), width));
    // Working children first: idle ones can linger for the whole session.
    const priority = (run: RunView) => run.status === "idle" ? 1 : !isTerminal(run.status) ? 0 : pending(run) ? 2 : 3;
    const visible = [...runs].sort((a, b) => priority(a) - priority(b) || b.createdAt - a.createdAt);
    for (const run of visible.slice(0, MAX_ROWS)) lines.push(this.row(run, width));
    const hidden = visible.length - MAX_ROWS;
    if (hidden > 0) {
      const text = `  ${hidden} more ${hidden === 1 ? "agent" : "agents"}, /peeps to check`;
      lines.push(fitLine(this.theme.fg("muted", text), width));
    }
    return lines;
  }

  private row(run: RunView, width: number): string {
    const marker = this.theme.fg(statusColor(run), statusGlyph(run));
    const label = this.theme.fg("text", run.label || run.id);
    const activity = run.activity || (isTerminal(run.status) ? run.status : run.task);
    const delivery = ["held", "unconfirmed", "failed"].includes(run.delivery) ? " · result " + run.delivery : "";
    const detail = this.theme.fg("muted", "  " + run.model.id + delivery + " · " + activity);
    return fitLine("  " + marker + " " + label + detail, width);
  }

  private schedule(): void {
    if (this.disposed || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.disposed) this.tui.requestRender();
    });
  }
}

export function mountOverview(ctx: ExtensionContext, source: ViewSource): () => void {
  let current: OverviewComponent | undefined;
  ctx.ui.setWidget(
    OVERVIEW_WIDGET_KEY,
    (tui, theme) => {
      current?.dispose();
      current = new OverviewComponent(tui, theme, source);
      return current;
    },
    { placement: "aboveEditor" },
  );
  return () => {
    current?.dispose();
    current = undefined;
    ctx.ui.setWidget(OVERVIEW_WIDGET_KEY, undefined);
  };
}
