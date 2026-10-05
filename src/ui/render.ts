import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TranscriptItem } from "../contracts.ts";

/**
 * A rendered transcript item. Native Pi components are wrapped by this surface
 * so the renderer can update them in place across versions instead of
 * recreating them for every streamed delta.
 */
export interface ItemComponent extends Component {
  update?(item: TranscriptItem): void;
  setExpanded?(expanded: boolean): void;
  setHideThinking?(hide: boolean): void;
}

export interface ItemFactory {
  create(item: TranscriptItem): ItemComponent;
}

export interface ItemAnchor {
  id: string;
  kind: TranscriptItem["kind"];
  start: number;
  count: number;
}

export interface RenderResult {
  lines: string[];
  anchors: ItemAnchor[];
}

interface CacheEntry {
  component: ItemComponent;
  lines: string[];
  kind: TranscriptItem["kind"];
  version: number;
  width: number;
  theme: Theme;
  expanded: boolean;
  hideThinking: boolean;
}

export interface RenderOptions {
  expanded: boolean;
  hideThinking: boolean;
}

/**
 * Windowed transcript renderer.
 *
 * Renders each item through an injected factory (native Pi components at
 * runtime), caching by item id, content version, width, theme, and expansion
 * state so unchanged items are not re-rendered. Every returned line is clamped
 * to the requested width with terminal-cell awareness.
 */
export class TranscriptRenderer {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly factory: ItemFactory;
  private theme: Theme;

  constructor(factory: ItemFactory, theme: Theme) {
    this.factory = factory;
    this.theme = theme;
  }

  setTheme(theme: Theme): void {
    if (theme === this.theme) return;
    this.theme = theme;
    this.cache.clear();
  }

  invalidate(): void {
    this.cache.clear();
  }

  render(items: readonly TranscriptItem[], width: number, options: RenderOptions): RenderResult {
    const safeWidth = Math.max(1, Math.floor(Number.isFinite(width) ? width : 1));
    const lines: string[] = [];
    const anchors: ItemAnchor[] = [];

    for (const item of items) {
      const key = item.kind + ":" + item.id;
      let entry = this.cache.get(key);
      const rebuild = !entry || entry.kind !== item.kind;
      let stale = rebuild;
      if (!rebuild && entry) {
        stale =
          entry.version !== item.version ||
          entry.width !== safeWidth ||
          entry.theme !== this.theme ||
          entry.expanded !== options.expanded ||
          entry.hideThinking !== options.hideThinking;
      }

      if (rebuild || !entry) {
        entry = {
          component: this.factory.create(item),
          lines: [],
          kind: item.kind,
          version: -1,
          width: -1,
          theme: this.theme,
          expanded: options.expanded,
          hideThinking: options.hideThinking,
        };
        this.cache.set(key, entry);
      } else if (stale) {
        entry.component.update?.(item);
      }

      if (rebuild || stale) {
        entry.component.setExpanded?.(options.expanded);
        entry.component.setHideThinking?.(options.hideThinking);
        const rendered = entry.component.render(safeWidth);
        entry.lines = rendered.map((line) =>
          visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth) : line,
        );
        entry.version = item.version;
        entry.width = safeWidth;
        entry.theme = this.theme;
        entry.expanded = options.expanded;
        entry.hideThinking = options.hideThinking;
      }

      anchors.push({ id: item.id, kind: item.kind, start: lines.length, count: entry.lines.length });
      for (const line of entry.lines) lines.push(line);
    }

    return { lines, anchors };
  }
}
