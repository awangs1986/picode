import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { compactWeixinReply } from "../../src/extension/weixin-reply-compactor.ts";

function assistantText(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AssistantMessage;
}

describe("compactWeixinReply", () => {
  it("uses exactly one isolated model completion and returns only its trimmed text", async () => {
    const complete = vi.fn().mockResolvedValue(assistantText("  已完成。请重新发送一条微信消息。  "));

    const result = await compactWeixinReply("完整回答和详细验证过程", complete);

    expect(result).toBe("已完成。请重新发送一条微信消息。");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining("精简成适合微信私聊"),
      tools: [],
      messages: [expect.objectContaining({
        role: "user",
        content: expect.stringContaining("<assistant-reply>\n完整回答和详细验证过程\n</assistant-reply>"),
      })],
    }));
  });

  it("rejects an empty compacted reply instead of silently consuming the message", async () => {
    await expect(compactWeixinReply("完整回答", async () => assistantText("  ")))
      .rejects.toThrow("compaction returned empty text");
  });
});
