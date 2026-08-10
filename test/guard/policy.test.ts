import { describe, expect, it } from "vitest";
import { decide } from "../../src/guard/policy.ts";
import { computeFingerprint } from "../../src/guard/fingerprint.ts";
import { makeIntent } from "../helpers/fixtures.ts";

describe("decide()", () => {
  it("asks for git-mutate at any tier", () => {
    for (const tier of ["readonly", "auto", "full"] as const) {
      const d = decide({ tier, intent: makeIntent({ category: "git-mutate", targets: [] }), grants: [] });
      expect(d.verdict).toBe("ask");
    }
  });

  it("asks for destructive operations even at full tier", () => {
    const d = decide({
      tier: "full",
      intent: makeIntent({ category: "fs-write", targets: ["/"], destructive: true }),
      grants: [],
    });
    expect(d.verdict).toBe("ask");
    expect(d.reason).toContain("destructive");
  });

  describe("readonly tier", () => {
    it("allows filesystem, Git, and capability metadata reads", () => {
      for (const category of ["fs-read", "git-read", "capability-read"] as const) {
        const d = decide({ tier: "readonly", intent: makeIntent({ category }), grants: [] });
        expect(d.verdict).toBe("allow");
      }
    });

    it("asks for other categories", () => {
      for (const category of ["fs-write", "exec", "network", "mcp-tool"] as const) {
        const d = decide({ tier: "readonly", intent: makeIntent({ category }), grants: [] });
        expect(d.verdict).toBe("ask");
      }
    });
  });

  describe("auto tier", () => {
    it("asks for exec, network, and unknown MCP calls", () => {
      for (const category of ["exec", "network", "mcp-tool"] as const) {
        const d = decide({ tier: "auto", intent: makeIntent({ category }), grants: [] });
        expect(d.verdict).toBe("ask");
      }
    });

    it("allows fs-write", () => {
      const d = decide({ tier: "auto", intent: makeIntent({ category: "fs-write" }), grants: [] });
      expect(d.verdict).toBe("allow");
    });

    it("asks before writing outside the workspace while allowing an in-workspace edit", () => {
      const inside = decide({
        tier: "auto",
        intent: makeIntent({ category: "fs-write", cwd: "C:\\repo", targets: ["C:\\repo\\src\\a.ts"] }),
        grants: [],
      });
      const outside = decide({
        tier: "auto",
        intent: makeIntent({ category: "fs-write", cwd: "C:\\repo", targets: ["C:\\Windows\\system.ini"] }),
        grants: [],
      });
      expect(inside.verdict).toBe("allow");
      expect(outside.verdict).toBe("ask");
    });
  });

  describe("full tier", () => {
    it("allows routine operations", () => {
      const d = decide({ tier: "full", intent: makeIntent({ category: "fs-write" }), grants: [] });
      expect(d.verdict).toBe("allow");
    });
  });

  describe("danger-full-access tier", () => {
    it("allows every intent without approval, including destructive and Git ownership operations", () => {
      const intents = [
        makeIntent({ category: "fs-write", targets: ["/"], destructive: true }),
        makeIntent({ category: "exec", command: "rm -rf build", destructive: true }),
        makeIntent({ category: "network", targets: ["https://example.com"] }),
        makeIntent({ category: "mcp-tool", targets: ["server:write"] }),
        makeIntent({ category: "git-mutate", command: "git push", targets: ["origin"] }),
      ];
      for (const intent of intents) {
        expect(decide({ tier: "danger-full-access", intent, grants: [] })).toEqual({
          verdict: "allow",
          reason: "danger-full-access tier: approvals disabled",
        });
      }
    });
  });

  describe("grants", () => {
    it("allows on exact fingerprint match", () => {
      const intent = makeIntent({ category: "exec", command: "npm test", targets: [] });
      const fp = computeFingerprint(intent);
      const d = decide({
        tier: "readonly",
        intent,
        grants: [{ kind: "fingerprint", value: fp, scope: "session" }],
      });
      expect(d.verdict).toBe("allow");
      expect(d.reason).toContain("grant");
    });

    it("allows on pattern grant command prefix match", () => {
      const intent = makeIntent({ category: "exec", command: "npm test -- --watch", targets: [] });
      const d = decide({
        tier: "readonly",
        intent,
        grants: [{ kind: "pattern", value: "npm test", scope: "session" }],
      });
      expect(d.verdict).toBe("allow");
    });
  });
});
