import { truncateToWidth, visibleWidth, type OverlayOptions } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * Full-screen and opaque: a partial overlay lets the parent transcript show
 * around it, which is indistinguishable from the child's thread.
 */
export const VIEWER_OVERLAY_OPTIONS = { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } as const satisfies OverlayOptions;

export interface TerminalSize {
  terminal: { columns: number; rows: number };
}

export const clamp = (value: number, min: number, max: number): number => {
  if (max < min) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
};

/** Width-safe single line: truncates only when the visible width exceeds the frame. */
export const fitLine = (text: string, width: number): string => {
  if (width <= 0) return "";
  const line = text.replace(/[\r\n\u2028\u2029]/g, " ");
  return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
};

export const padLine = (text: string, width: number): string => {
  if (width <= 0) return "";
  const visible = visibleWidth(text);
  if (visible > width) return truncateToWidth(text, width);
  if (visible === width) return text;
  return text + " ".repeat(width - visible);
};

/**
 * Overlay geometry shared by the component render path and the overlay options
 * callback so the component always returns exactly the window the overlay shows.
 */
export const overlayLayout = (tui: TerminalSize | undefined): { width: number; height: number } => {
  const columns = tui ? tui.terminal.columns : 80;
  const rows = tui ? tui.terminal.rows : 24;
  return { width: Math.max(1, Math.floor(columns)), height: Math.max(1, Math.floor(rows)) };
};

const RESET = "\x1b[0m";

export interface Frame {
  /** Left side of the top border. */
  title: string;
  /** Right side of the top border. */
  status?: string;
  /** Content blocks, separated by rules. Lines are clamped and padded to the inner width. */
  blocks: string[][];
  footerLeft?: string;
  footerRight?: string;
}

/** Columns available to content inside the frame's borders and padding. */
export const frameInnerWidth = (width: number): number => Math.max(1, width - 4);

/** Rows left for one flexible block after borders, rules, and the other blocks. */
export const frameFreeRows = (height: number, fixedRows: number, blocks: number): number =>
  Math.max(1, height - 2 - Math.max(0, blocks - 1) - fixedRows);

/**
 * Draw a rounded box of exactly `width` columns. Every row is opaque: content is
 * reset and padded so neither child styling nor the parent screen leaks through.
 */
export const renderFrame = (theme: Theme, width: number, height: number, frame: Frame): string[] => {
  if (width < 8 || height < 3) {
    return frame.blocks.flat().slice(0, Math.max(1, height)).map((line) => fitLine(line, width));
  }
  const border = (text: string) => theme.fg("border", text);
  const inner = frameInnerWidth(width);
  // Labels sit inside the border. When space runs out the title shrinks; footer hints are dropped.
  const edge = (left: string, right: string, start: string, end: string, dropRight: boolean): string => {
    if (dropRight && visibleWidth(left) + visibleWidth(right) + 4 > width - 4) right = "";
    const room = width - 4 - (left ? 2 : 0) - (right ? 2 : 0);
    const lw = visibleWidth(left), rw = visibleWidth(right);
    let lMax = lw, rMax = rw;
    if (lw + rw > room) {
      if (lw <= rw) { lMax = Math.min(lw, Math.floor(room / 2)); rMax = room - lMax; }
      else { rMax = Math.min(rw, Math.floor(room / 2)); lMax = room - rMax; }
    }
    const l = left && lMax > 0 ? " " + fitLine(left, lMax) + " " : "";
    const r = right && rMax > 0 ? " " + fitLine(right, rMax) + " " : "";
    const fill = Math.max(0, width - 4 - visibleWidth(l) - visibleWidth(r));
    return border(start + "─") + l + RESET + border("─".repeat(fill)) + r + RESET + border("─" + end);
  };
  const row = (line: string): string => {
    const content = fitLine(line, inner);
    return border("│") + " " + content + RESET + " ".repeat(Math.max(0, inner - visibleWidth(content))) + " " + border("│");
  };
  const out: string[] = [edge(frame.title, frame.status ?? "", "╭", "╮", false)];
  frame.blocks.forEach((block, index) => {
    if (index > 0) out.push(border("├" + "─".repeat(width - 2) + "┤"));
    for (const line of block) out.push(row(line));
  });
  const bodyRows = height - 1;
  while (out.length < bodyRows) out.push(row(""));
  out.length = Math.min(out.length, bodyRows);
  out.push(edge(frame.footerLeft ?? "", frame.footerRight ?? "", "╰", "╯", true));
  return out;
};

/**
 * Bounded scroll window. Overlay compositing slices rendered output from the
 * top, so the component must own scrolling and return only the visible window.
 * Scrolling up pauses follow; end()/scrolling back to the bottom resumes it.
 */
export class ScrollWindow {
  private top = 0;
  private following = true;
  private contentHeight = 0;
  private viewportHeight = 1;

  get scrollTop(): number {
    return this.top;
  }

  get follow(): boolean {
    return this.following;
  }

  get content(): number {
    return this.contentHeight;
  }

  get viewport(): number {
    return this.viewportHeight;
  }

  get maxTop(): number {
    return Math.max(0, this.contentHeight - this.viewportHeight);
  }

  setViewport(height: number): void {
    this.viewportHeight = Math.max(1, Math.floor(Number.isFinite(height) ? height : 1));
    this.clampTop();
  }

  setContentHeight(height: number): void {
    this.contentHeight = Math.max(0, Math.floor(Number.isFinite(height) ? height : 0));
    this.clampTop();
  }

  scrollUp(lines = 1): void {
    this.following = false;
    this.top = clamp(this.top - Math.max(1, lines), 0, this.maxTop);
  }

  scrollDown(lines = 1): void {
    this.top = clamp(this.top + Math.max(1, lines), 0, this.maxTop);
    this.following = this.top >= this.maxTop;
  }

  pageUp(): void {
    this.scrollUp(Math.max(1, this.viewportHeight - 1));
  }

  pageDown(): void {
    this.scrollDown(Math.max(1, this.viewportHeight - 1));
  }

  home(): void {
    this.following = false;
    this.top = 0;
  }

  end(): void {
    this.following = true;
    this.top = this.maxTop;
  }

  refresh(): void {
    this.clampTop();
  }

  window<T>(lines: readonly T[]): T[] {
    return lines.slice(this.top, this.top + this.viewportHeight);
  }

  private clampTop(): void {
    this.top = this.following ? this.maxTop : clamp(this.top, 0, this.maxTop);
  }
}
