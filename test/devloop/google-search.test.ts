import { describe, expect, it } from "vitest";
import {
  buildGroundingQuery,
  buildResearchPacket,
  renderResearchPacket,
  validateResearchBriefs,
  validateResearchSynthesis,
} from "../../src/devloop/index.ts";

describe("Google Search research contract", () => {
  it("accepts 1-10 unique briefs and rejects oversized fanout", () => {
    expect(validateResearchBriefs([{ id: "fr", question: "French Hmong life in 2025" }])).toHaveLength(1);
    expect(() => validateResearchBriefs(Array.from({ length: 11 }, (_, i) => ({
      id: `b${i}`,
      question: `question ${i}`,
    })))).toThrow(/1-10/u);
    expect(() => validateResearchBriefs([
      { id: "same", question: "one" },
      { id: "same", question: "two" },
    ])).toThrow(/duplicate/u);
  });

  it("includes locale and constraints in the deterministic Grounding query", () => {
    expect(buildGroundingQuery({
      id: "fr-hmong",
      question: "  life   in 2025 ",
      locale: "fr-FR",
      constraints: ["prefer first-party sources", "include Hmong-language sources"],
    })).toBe([
      "life in 2025",
      "Preferred locale/language: fr-FR",
      "Constraint: prefer first-party sources",
      "Constraint: include Hmong-language sources",
    ].join("\n"));
  });

  it("rejects citations that were not returned in provider grounding metadata", () => {
    const evidence = {
      answer: "grounded",
      sources: [{ title: "Official", url: "https://example.test/official", snippet: "fact" }],
      actualProvider: "google-gemini-api",
      queries: ["test"],
    };
    expect(validateResearchSynthesis({
      summary: "summary",
      claims: [{ text: "fact", sourceUrls: ["https://example.test/official"] }],
      limitations: [],
    }, evidence).claims).toHaveLength(1);
    expect(() => validateResearchSynthesis({
      summary: "summary",
      claims: [{ text: "invented", sourceUrls: ["https://invented.test/"] }],
      limitations: [],
    }, evidence)).toThrow(/absent from provider grounding metadata/u);
  });

  it("keeps the injected view bounded and points to the complete artifact", () => {
    const packet = buildResearchPacket("plan-1", [{
      briefId: "a",
      groundingAnswer: "complete provider evidence",
      summary: "x".repeat(2_000),
      claims: [{ text: "claim", sourceUrls: ["https://example.test"] }],
      limitations: [],
      sources: [{ title: "source", url: "https://example.test", snippet: "s" }],
      queries: ["q"],
      actualProvider: "google-gemini-api",
    }], "2026-08-19T00:00:00.000Z", ".pi-subagents/artifacts/google-search/plan-1.json");
    const rendered = renderResearchPacket(packet, 500);
    expect(rendered.length).toBeLessThanOrEqual(500);
    expect(rendered).toContain("plan-1.json");
  });
});
