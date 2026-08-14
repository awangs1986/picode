import { describe, expect, it } from "vitest";
import {
  buildSummarizationChunks,
  isThirdPartyOpenAiResponses,
  reasoningFreeFetch,
} from "../../src/extension/compaction-compat.ts";

describe("third-party compaction compatibility", () => {
  it("only applies to non-official OpenAI Responses endpoints", () => {
    expect(isThirdPartyOpenAiResponses({ api: "openai-responses", baseUrl: "https://api.openai.com/v1" })).toBe(false);
    expect(isThirdPartyOpenAiResponses({ api: "openai-responses", baseUrl: "https://gateway.example/v1" })).toBe(true);
    expect(isThirdPartyOpenAiResponses({ api: "openai-completions", baseUrl: "https://gateway.example/v1" })).toBe(false);
    expect(isThirdPartyOpenAiResponses(undefined)).toBe(false);
  });

  it("removes reasoning-only fields without changing the summary payload", async () => {
    let sent: Record<string, unknown> | undefined;
    const wrapped = reasoningFreeFetch(async (_input, init) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("ok");
    });
    await wrapped("https://gateway.example/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt", input: ["summary"], reasoning: { effort: "none" }, include: ["reasoning.encrypted_content"] }),
    });
    expect(sent).toEqual({ model: "gpt", input: ["summary"] });
  });

  it("bounds a 300k-token history into provider-safe summarization chunks", () => {
    const messages = Array.from({ length: 300 }, (_, index) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: `entry-${index} ${"x".repeat(3_900)}` }],
      timestamp: index,
    }));

    const chunks = buildSummarizationChunks(messages, 48_000);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.estimatedTokens <= 48_000)).toBe(true);
    expect(chunks.flatMap((chunk) => chunk.messages)).toHaveLength(messages.length);
  });
});
