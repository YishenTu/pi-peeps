import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PARENT_MESSAGE_TYPE, RECEIVE_COMMAND, parseParentMessage } from "./parent-message.ts";

/** Loaded explicitly in every child, even when discovered extensions are disabled. */
export default function childReceiver(pi: ExtensionAPI): void {
  if (process.env.PI_PEEPS_CHILD !== "1") return;
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
