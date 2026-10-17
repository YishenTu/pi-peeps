import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { PARENT_MESSAGE_TYPE, RECEIVE_COMMAND, parseParentMessage } from "./parent-message.ts";

/** Loaded explicitly in every child, even when discovered extensions are disabled. */
export default function childReceiver(pi: ExtensionAPI): void {
  if (process.env.PI_PEEPS_CHILD !== "1") return;
  pi.on("context_with_system", (event, ctx) => {
    // Pi 1.0.2 custom startup can declare tools before preparing any system text.
    // Use the public effective prompt; retain the host's tool declarations and
    // leave a prompt already supplied by Pi or another extension untouched.
    if (getCurrentSystemPrompt(event.messages)) return;
    const prompt = ctx.getSystemPrompt();
    if (!prompt) return;
    const [head, ...tail] = event.messages;
    return { messages: head?.role === "system"
      ? [{ ...head, content: prompt }, ...tail]
      : [{ role: "system" as const, content: prompt, timestamp: Date.now() }, ...event.messages] };
  });
  pi.registerCommand(RECEIVE_COMMAND, {
    description: "Receive a message from the owning Peeps parent.",
    async handler(args) {
      const { id, text } = parseParentMessage(args);
      pi.sendMessage({
        customType: PARENT_MESSAGE_TYPE, content: text, display: true,
        details: { messageId: id },
      }, { deliverAs: "steer", triggerTurn: true });
      // sendMessage is void. The RPC `handled` response confirms dispatch only;
      // the parent observes native message events and errors separately.
    },
  });
}
