import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ViewSource } from "../contracts.ts";
import { VIEWER_OVERLAY_OPTIONS } from "./window.ts";
import { ViewerComponent, trackViewer } from "./viewer.ts";
import { createNativeItemFactory } from "./native.ts";

/**
 * Open the read-only peeps viewer as a capturing overlay.
 *
 * The overlay never replaces the editor and never switches or aborts the real
 * Pi session. It resolves when the user closes it; the owner can also call
 * closeAllViewers() on session shutdown.
 */
export async function openViewer(
  ctx: ExtensionContext,
  source: ViewSource,
  initialId?: string,
): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  await ctx.ui.custom<void>(
    (viewerTui, theme, keybindings, done) => {
      const component = new ViewerComponent({
        source,
        tui: viewerTui,
        theme,
        keybindings,
        cwd: ctx.cwd,
        factory: createNativeItemFactory({ tui: viewerTui, theme, cwd: ctx.cwd }),
        initialId,
        getTheme: () => ctx.ui.theme,
        done: () => done(undefined),
      });
      const untrack = trackViewer(component);
      return {
        render: (width: number): string[] => component.render(width),
        invalidate: (): void => component.invalidate(),
        handleInput: (data: string): void => component.handleInput(data),
        handleMouse: (event: TuiMouseEvent) => component.handleMouse(event),
        dispose: (): void => {
          untrack();
          component.dispose();
        },
      } satisfies Component & { dispose(): void };
    },
    {
      overlay: true,
      // Pi resolves options callbacks only once. Constant caps are clamped by
      // the compositor to live terminal dimensions on every render.
      overlayOptions: VIEWER_OVERLAY_OPTIONS,
    },
  );
}
