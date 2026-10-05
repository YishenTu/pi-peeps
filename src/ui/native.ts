import {
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  createBashToolDefinition,
  createCodemodeExtension,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { TranscriptItem } from "../contracts.ts";
import type { ItemComponent, ItemFactory } from "./render.ts";

type MessageItem = Extract<TranscriptItem, { kind: "message" }>;
type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

export interface NativeFactoryOptions {
  tui: TUI;
  theme: Theme;
  cwd: string;
  hiddenThinkingLabel?: string;
  outputPad?: number;
}

const contentToText = (content: string | (TextContent | ImageContent)[]): string => {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text") parts.push(part.text);
    else parts.push("[image]");
  }
  return parts.join("\n");
};

const wrap = (component: ItemComponent): ItemComponent => component;

const createAssistant = (item: MessageItem, options: NativeFactoryOptions, markdownTheme: ReturnType<typeof getMarkdownTheme>): ItemComponent => {
  const message = item.message.role === "assistant" ? item.message : undefined;
  const component = new AssistantMessageComponent(
    message,
    false,
    markdownTheme,
    options.hiddenThinkingLabel ?? "Thinking...",
    options.outputPad ?? 1,
  );
  let hideThinking = false;
  return wrap({
    render: (width: number) => component.render(width),
    invalidate: () => component.invalidate(),
    setHideThinking: (hide: boolean) => {
      if (hide === hideThinking) return;
      hideThinking = hide;
      component.setHideThinkingBlock(hide);
    },
    update: (next: TranscriptItem) => {
      if (next.kind !== "message" || next.message.role !== "assistant") return;
      component.updateContent(next.message, next.streaming);
    },
  });
};

type NamedRenderers = ToolRenderers & { name: string };

/**
 * Pi's built-in codemode extension publishes its tool only through registration.
 * Record that one call; the host-dependent closures (execute, loadout) never run.
 */
const codemodeDefinition = (): NamedRenderers[] => {
  const registered: NamedRenderers[] = [];
  try {
    createCodemodeExtension()({ registerTool: (tool: NamedRenderers) => { registered.push(tool); } } as unknown as ExtensionAPI);
  } catch {
    return []; // A host that needs more at registration falls back to native rendering.
  }
  return registered;
};

/**
 * Pi's built-in renderers by tool name, taken from the public tool definitions
 * the main view also renders with. Only presentation is kept; nothing executes.
 */
const builtInRenderers = (cwd: string): Record<string, ToolRenderers> => {
  const renderers: Record<string, ToolRenderers> = {};
  for (const definition of [
    ...[
      createReadToolDefinition(cwd), createBashToolDefinition(cwd), createPowerShellToolDefinition(cwd),
      createEditToolDefinition(cwd), createWriteToolDefinition(cwd), createGrepToolDefinition(cwd),
      createFindToolDefinition(cwd), createLsToolDefinition(cwd),
    ] as unknown as NamedRenderers[], // Child args are untyped; Pi's renderers tolerate that.
    ...codemodeDefinition(),
  ]) {
    const { renderShell, renderCall, renderResult } = definition;
    renderers[definition.name] = {
      renderShell,
      renderCall,
      // The shell renderer ticks its elapsed time with a timer that only a final
      // result stops. A closed viewer never gets one, and the transcript cache
      // redraws only on new child output, so stop the timer at once.
      renderResult: renderResult && ((result, renderOptions, theme, context) => {
        const component = renderResult(result, renderOptions, theme, context);
        const state = context.state as { interval?: ReturnType<typeof setInterval> };
        if (state.interval) clearInterval(state.interval);
        state.interval = undefined;
        return component;
      }),
    };
  }
  return renderers;
};

const createTool = (item: ToolItem, options: NativeFactoryOptions, renderers: Record<string, ToolRenderers>): ItemComponent => {
  const component = new ToolExecutionComponent(
    item.toolName,
    item.id,
    item.args,
    { showImages: false },
    // Child-defined renderers cannot cross RPC. Built-in tools render as in the main view;
    // others get Pi's collapsible fallback (undefined would print raw args and full output).
    Object.hasOwn(renderers, item.toolName) ? renderers[item.toolName] : {},
    options.tui,
    options.cwd,
  );
  let started = false;
  let argsComplete = false;

  const apply = (next: ToolItem): void => {
    component.updateArgs(next.args);
    if (!started && next.started) {
      started = true;
      component.markExecutionStarted();
    }
    if (!argsComplete && next.complete) {
      argsComplete = true;
      component.setArgsComplete();
    }
    if (next.result) {
      component.updateResult(next.result, !next.complete);
    }
  };

  apply(item);

  return wrap({
    render: (width: number) => component.render(width),
    invalidate: () => component.invalidate(),
    setExpanded: (expanded: boolean) => component.setExpanded(expanded),
    update: (next: TranscriptItem) => {
      if (next.kind !== "tool") return;
      apply(next);
    },
  });
};

const createBash = (item: MessageItem, options: NativeFactoryOptions): ItemComponent => {
  const message = item.message;
  if (message.role !== "bashExecution") return createFallback(item, options);
  const component = new BashExecutionComponent(message.command, options.tui, message.excludeFromContext);
  component.appendOutput(message.output);
  component.setComplete(message.exitCode, message.cancelled, undefined, message.fullOutputPath);
  return wrap({
    render: (width: number) => component.render(width),
    invalidate: () => component.invalidate(),
    setExpanded: (expanded: boolean) => component.setExpanded(expanded),
  });
};

const createFallback = (item: MessageItem, options: NativeFactoryOptions): ItemComponent => {
  const message = item.message as { role?: string; content?: unknown };
  const role = typeof message.role === "string" ? message.role : "message";
  const body =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? contentToText(message.content as (TextContent | ImageContent)[])
        : "";
  const text = "[" + role + "] " + body;
  const component = new Text(text, 1, 0);
  return wrap({
    render: (width: number) => component.render(width),
    invalidate: () => component.invalidate(),
  });
};

const createMessage = (item: MessageItem, options: NativeFactoryOptions, markdownTheme: ReturnType<typeof getMarkdownTheme>): ItemComponent => {
  const message = item.message;
  switch (message.role) {
    case "user": {
      const component = new UserMessageComponent(contentToText(message.content), markdownTheme, options.outputPad ?? 1);
      return wrap({
        render: (width: number) => component.render(width),
        invalidate: () => component.invalidate(),
      });
    }
    case "assistant":
      return createAssistant(item, options, markdownTheme);
    case "custom": {
      const component = new CustomMessageComponent(message, undefined, markdownTheme, options.outputPad ?? 1);
      return wrap({
        render: (width: number) => component.render(width),
        invalidate: () => component.invalidate(),
      });
    }
    case "bashExecution":
      return createBash(item, options);
    case "compactionSummary": {
      const component = new CompactionSummaryMessageComponent(message, markdownTheme);
      return wrap({
        render: (width: number) => component.render(width),
        invalidate: () => component.invalidate(),
        setExpanded: (expanded: boolean) => component.setExpanded(expanded),
      });
    }
    case "branchSummary": {
      const component = new BranchSummaryMessageComponent(message, markdownTheme);
      return wrap({
        render: (width: number) => component.render(width),
        invalidate: () => component.invalidate(),
        setExpanded: (expanded: boolean) => component.setExpanded(expanded),
      });
    }
    default:
      return createFallback(item, options);
  }
};

/**
 * Builds native Pi transcript components for child items.
 *
 * Tool renderers cannot cross the RPC boundary, so tool calls use Pi's built-in
 * renderers by name, or the native fallback, rather than a child-defined renderer.
 */
export const createNativeItemFactory = (options: NativeFactoryOptions): ItemFactory => {
  let renderers: Record<string, ToolRenderers> | undefined;
  return {
    create: (item: TranscriptItem): ItemComponent =>
      item.kind === "tool"
        ? createTool(item, options, renderers ??= builtInRenderers(options.cwd))
        : createMessage(item, options, getMarkdownTheme()),
  };
};
