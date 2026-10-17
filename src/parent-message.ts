import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const PARENT_MESSAGE_TYPE = "peeps-message";
export const RECEIVE_COMMAND = "peeps-receive";
export interface ParentMessage { id: string; text: string }

/** JSON preserves whitespace and prevents message text from becoming a command. */
export const parentMessageCommand = (message: ParentMessage): string =>
  `/${RECEIVE_COMMAND} ${JSON.stringify(message)}`;

export function parseParentMessage(args: string): ParentMessage {
  const value: unknown = JSON.parse(args);
  if (!value || typeof value !== "object" || !("id" in value) || !("text" in value)
    || typeof value.id !== "string" || !value.id || typeof value.text !== "string" || !value.text.trim()) {
    throw new Error("Invalid Peeps parent message.");
  }
  return { id: value.id, text: value.text };
}

/** Correlate native message events with this process's outstanding submissions. */
export function parentMessageId(message: AgentMessage): string | undefined {
  if (message.role !== "custom" || message.customType !== PARENT_MESSAGE_TYPE) return;
  const details = message.details as { messageId?: unknown } | undefined;
  return typeof details?.messageId === "string" ? details.messageId : undefined;
}
