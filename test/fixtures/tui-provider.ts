// Local-only provider for the optional PTY smoke test. Never contacts a service.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import scripted from "./scripted-provider.ts";
export default function(pi: ExtensionAPI) {
  globalThis.fetch = async () => { throw new Error("NETWORK DISABLED"); };
  if (process.env.PI_PEEPS_CHILD === "1") { scripted(pi); return; }
  pi.registerProvider("peeps-scripted", {
    api: "peeps-ui-test", baseUrl: "https://invalid.invalid", apiKey: "fake",
    models: [{id:"peeps-scripted-1",name:"Peeps UI",reasoning:false,input:["text"],contextWindow:128000,maxTokens:2000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const spawned = context.messages.some(m => m.role === "toolResult");
      const notice = context.messages.some(m => m.role === "user" && JSON.stringify(m.content).includes("Peeps automated result"));
      const message: AssistantMessage = {
        role:"assistant",api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),
        content: spawned ? [{type:"text",text:notice?"PARENT-RECEIVED":"PARENT-WAITING"}] : [{type:"toolCall",id:"spawn-ui",name:"peeps_spawn",arguments:{task:"UI child task",label:"UI-peep"}}],
        stopReason:spawned?"stop":"toolUse",
        usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}
      };
      queueMicrotask(() => { stream.push({type:"done",reason:spawned?"stop":"toolUse",message}); stream.end(message); });
      return stream;
    }
  });
}
