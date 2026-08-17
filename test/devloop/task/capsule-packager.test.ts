import { describe, expect, it } from "vitest";
import {
  fitCapsuleBudget,
  parseCapsuleSemanticDraft,
  redactCapsuleSecrets,
} from "../../../src/devloop/task/capsule-packager.ts";
import { createCapsule } from "../../../src/devloop/task/capsule.ts";
import { makeCapsuleInput } from "../../helpers/fixtures.ts";

describe("Capsule semantic packaging", () => {
  it("accepts only bounded structured output from the current-session model", () => {
    const result = parseCapsuleSemanticDraft(`\`\`\`json
      {"decisions":[{"decision":"Keep JSONL","rationale":"Pi owns the transcript"}],
       "failedApproaches":["A second SQLite transcript authority drifted"],
       "nextSteps":["Implement the child session switch"],
       "narrative":"The deterministic state is supplied separately."}
    \`\`\``);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.failedApproaches).toEqual([
      "A second SQLite transcript authority drifted",
    ]);
  });

  it("rejects prose and malformed semantic packages", () => {
    const result = parseCapsuleSemanticDraft("Here is the handoff you requested");
    expect(result.ok).toBe(false);
  });

  it("redacts common credentials before history leaves the current session", () => {
    const redacted = redactCapsuleSecrets(
      "API_KEY=sk-secret-value Authorization: Bearer abc.def.ghi password: hunter2",
    );
    expect(redacted).not.toContain("sk-secret-value");
    expect(redacted).not.toContain("abc.def.ghi");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("[REDACTED]");
  });

  it("drops narrative before mandatory facts and refuses an oversized mandatory core", () => {
    const narrativeHeavy = createCapsule(makeCapsuleInput({ narrative: "叙".repeat(30_000) }));
    const fitted = fitCapsuleBudget(narrativeHeavy, { targetTokens: 2_000, hardTokens: 8_000 });
    expect(fitted.ok).toBe(true);
    if (fitted.ok) {
      expect(fitted.value.capsule.narrative.length).toBeLessThan(30_000);
      expect(fitted.value.capsule.intent).toBe("Fix the bug");
      expect(fitted.value.estimatedTokens).toBeLessThanOrEqual(8_000);
    }

    const mandatoryHeavy = createCapsule(makeCapsuleInput({
      narrative: "",
      acceptance: ["验".repeat(30_000)],
    }));
    const rejected = fitCapsuleBudget(mandatoryHeavy, { targetTokens: 2_000, hardTokens: 8_000 });
    expect(rejected.ok).toBe(false);
  });
});
