import type { RunStatus, RunView } from "../contracts.ts";

type StatusColor = "accent" | "success" | "muted" | "error";

const STYLE: Record<RunStatus, { glyph: string; color: StatusColor }> = {
  starting: { glyph: "○", color: "muted" },
  working: { glyph: "●", color: "accent" },
  idle: { glyph: "◇", color: "success" },
  closed: { glyph: "✓", color: "muted" },
  failed: { glyph: "✗", color: "error" },
};

export const statusGlyph = (run: RunView): string => STYLE[run.status].glyph;
export const statusColor = (run: RunView): StatusColor => STYLE[run.status].color;

/** "2 working · 1 idle · 3 closed", omitting empty groups. Starting counts as working. */
export const summarize = (runs: readonly RunView[]): string => {
  const order = ["working", "idle", "closed", "failed"] as const;
  const counts = new Map<string, number>();
  for (const run of runs) {
    const group = run.status === "starting" ? "working" : run.status;
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return order.filter((group) => counts.has(group)).map((group) => counts.get(group) + " " + group).join(" · ");
};
