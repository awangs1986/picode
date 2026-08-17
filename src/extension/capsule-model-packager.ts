import { type Message, uuidv7 } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  serializeConversation,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  parseCapsuleSemanticDraft,
  redactCapsuleSecrets,
  type CapsuleSemanticDraft,
} from "../devloop/index.ts";
import type { Result } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";

type AgentMessage = Parameters<typeof convertToLlm>[0][number];

const CAPSULE_PACKING_PROMPT = `You are packaging the current Picode conversation for its direct continuation in a fresh Pi session.

Return JSON only with this exact shape:
{"decisions":[{"decision":"...","rationale":"..."}],"failedApproaches":["..."],"nextSteps":["..."],"narrative":"..."}

Rules:
- Use only information present in the supplied conversation.
- Preserve confirmed decisions and failed approaches; do not invent facts.
- The Host supplies task identity, acceptance criteria, todos, files, Git state, and evidence separately. Do not repeat them.
- Keep the narrative very short. Prefer omission over speculation.
- Do not include secrets, credentials, full tool logs, full diffs, reasoning traces, or skill bodies.
- This is a no-tool extraction call. Do not request or describe tool use.`;

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === "message") return entry.message;
  if (entry.type === "custom_message") {
    return {
      role: "custom",
      customType: entry.customType,
      content: entry.content,
      display: entry.display,
      ...(entry.details === undefined ? {} : { details: entry.details }),
      timestamp: new Date(entry.timestamp).getTime(),
    };
  }
  if (entry.type === "compaction") {
    return {
      role: "compactionSummary",
      summary: entry.summary,
      tokensBefore: entry.tokensBefore,
      timestamp: new Date(entry.timestamp).getTime(),
    };
  }
  return undefined;
}

/** Same compaction-aware branch selection as the pinned Pi handoff example. */
function handoffMessages(branch: SessionEntry[]): AgentMessage[] {
  let compactionIndex = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (branch[index]?.type === "compaction") {
      compactionIndex = index;
      break;
    }
  }
  if (compactionIndex < 0) return branch.map(entryToMessage).filter((message) => message !== undefined);
  const compaction = branch[compactionIndex];
  const firstKeptIndex = compaction?.type === "compaction"
    ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId)
    : -1;
  const selected = [
    ...(compaction === undefined ? [] : [compaction]),
    ...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
    ...branch.slice(compactionIndex + 1),
  ];
  return selected.map(entryToMessage).filter((message) => message !== undefined);
}

export async function packCapsuleWithCurrentModel(
  ctx: ExtensionContext,
  nextIntent: string,
): Promise<Result<CapsuleSemanticDraft>> {
  if (ctx.model === undefined) {
    return err("extension/capsule-model-unavailable", "Auto Slice requires the current session model");
  }
  const messages = handoffMessages(ctx.sessionManager.getBranch());
  if (messages.length === 0) {
    return err("extension/capsule-history-empty", "current session has no conversation to package");
  }
  const conversation = redactCapsuleSecrets(serializeConversation(convertToLlm(messages)));
  const request: Message = {
    role: "user",
    content: [{
      type: "text",
      text: `## Conversation\n\n${conversation}\n\n## Next intent\n\n${redactCapsuleSecrets(nextIntent)}`,
    }],
    timestamp: Date.now(),
  };
  try {
    const response = await ctx.modelRegistry.complete(
      ctx.model,
      { systemPrompt: CAPSULE_PACKING_PROMPT, messages: [request] },
      {
        signal: ctx.signal,
        cacheRetention: "none",
        sessionId: uuidv7(),
        maxTokens: 4_096,
        ...(ctx.model.reasoning && ctx.thinkingLevel !== undefined && ctx.thinkingLevel !== "off"
          ? { reasoning: ctx.thinkingLevel }
          : {}),
      } as never,
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      return err(
        "extension/capsule-model-failed",
        response.errorMessage ?? `Capsule packing stopped: ${response.stopReason}`,
      );
    }
    const text = response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const parsed = parseCapsuleSemanticDraft(redactCapsuleSecrets(text));
    return parsed.ok ? ok(parsed.value) : parsed;
  } catch (cause) {
    return err("extension/capsule-model-failed", "current-session model could not package the Capsule", cause);
  }
}
