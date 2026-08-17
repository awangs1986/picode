import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function scriptedModel(pi: ExtensionAPI): void {
  pi.registerProvider("picode-scripted-test", {
    api: "picode-scripted-test",
    apiKey: "fixture-only",
    baseUrl: "http://127.0.0.1.invalid",
    models: [{ id: "fixture", name: "Scripted fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16_000, maxTokens: 1_000 }],
    streamSimple(model, context): AssistantMessageEventStream {
      const stream = createAssistantMessageEventStream();
      const base: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "pending", timestamp: Date.now() };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: base });
        const latestUser = context.messages.filter((message) =>
          message.role === "user" && !JSON.stringify(message.content).includes("<picode_"),
        ).at(-1);
        const userText = latestUser === undefined ? "" : JSON.stringify(latestUser.content);
        if (context.systemPrompt?.includes("packaging the current Picode conversation") === true) {
          const text = JSON.stringify({
            decisions: [],
            failedApproaches: [],
            nextSteps: ["Continue the requested Slice intent"],
            narrative: "",
          });
          const partial = { ...base, content: [{ type: "text" as const, text }] };
          stream.push({ type: "text_start", contentIndex: 0, partial: base });
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
          stream.push({ type: "done", reason: "stop", message: { ...partial, stopReason: "stop" } });
          return;
        }
        const requestedTool = userText.includes("TOOL:");
        const requestedTaskFailure = userText.includes("TASK:FAIL_PREFLIGHT");
        const toolResultCount = context.messages.filter((message) => message.role === "toolResult").length;
        if (requestedTaskFailure && toolResultCount === 0) {
          const toolCall = {
            type: "toolCall" as const,
            id: "scripted-task-failure",
            name: "task_outcome",
            arguments: {
              outcome: "failed_preflight",
              summary: "Scripted preflight could not satisfy the required policy",
              evidenceRefs: ["fixture:preflight"],
            },
          };
          const partial = { ...base, content: [toolCall] };
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: base });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
          stream.push({ type: "done", reason: "toolUse", message: { ...partial, stopReason: "toolUse" } });
          return;
        }
        const requestedCalls = userText.includes("TOOL:TWICE") || userText.includes("TOOL:MUTATE") ? 2 : 1;
        if (requestedTool && toolResultCount < requestedCalls) {
          const command = userText.includes("TOOL:WRITE")
            ? `node -e "require('node:fs').writeFileSync('approval-effect.txt','created')"`
            : userText.includes("TOOL:HANG")
              ? `node -e "setInterval(() => {}, 1000)"`
            : userText.includes("TOOL:MUTATE") && toolResultCount === 1
              ? `node -p "process.platform"`
              : "node --version";
          const toolCall = { type: "toolCall" as const, id: `scripted-call-${toolResultCount + 1}`, name: "bash", arguments: { command } };
          const partial = { ...base, content: [toolCall] };
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: base });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
          stream.push({ type: "done", reason: "toolUse", message: { ...partial, stopReason: "toolUse" } });
          return;
        }
        const partial = { ...base, content: [{ type: "text" as const, text: "scripted-ok" }] };
        stream.push({ type: "text_start", contentIndex: 0, partial: base });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "scripted-ok", partial });
        stream.push({ type: "text_end", contentIndex: 0, content: "scripted-ok", partial });
        const done = { ...partial, stopReason: "stop" as const };
        stream.push({ type: "done", reason: "stop", message: done });
      });
      return stream;
    },
  });
}
