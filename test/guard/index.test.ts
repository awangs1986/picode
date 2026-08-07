import { describe, expect, it } from "vitest";
import { Guard } from "../../src/guard/index.ts";
import { computeFingerprint } from "../../src/guard/fingerprint.ts";
import { makeIntent } from "../helpers/fixtures.ts";

describe("Guard + GrantStore integration", () => {
  it("session fingerprint grant from grant() immediately affects decide() as allow", () => {
    const guard = new Guard("readonly");
    const intent = makeIntent({ category: "exec", command: "npm test", targets: [] });
    const before = guard.decide(intent);
    expect(before.verdict).toBe("ask");

    const fp = computeFingerprint(intent);
    guard.grant({ kind: "fingerprint", value: fp, scope: "session" });

    const after = guard.decide(intent);
    expect(after.verdict).toBe("allow");
    expect(after.reason).toContain("grant");
  });

  it("emits every allow/ask/deny decision through the configured evidence sink", () => {
    const decisions: unknown[] = [];
    const guard = new Guard("full", undefined, (record) => decisions.push(record));
    const intent = makeIntent({ category: "fs-read", targets: ["README.md"] });

    expect(guard.decide(intent).verdict).toBe("allow");
    expect(decisions).toEqual([
      expect.objectContaining({ intent, decision: expect.objectContaining({ verdict: "allow" }) }),
    ]);
  });
});
