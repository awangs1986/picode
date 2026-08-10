import { describe, expect, it } from "vitest";
import {
  compileSandboxPolicy,
  DEFAULT_SECRET_ZONES,
} from "../../src/guard/sandbox-policy.ts";

describe("compileSandboxPolicy", () => {
  const roots = ["/workspace/a", "/workspace/b"];

  it("readonly tier asks for network, exec, and fsWrite", () => {
    const policy = compileSandboxPolicy("readonly", roots);
    expect(policy.network).toBe("ask");
    expect(policy.exec).toBe("ask");
    expect(policy.fsWrite).toBe("ask");
  });

  it("auto tier allows fsWrite but asks for network and exec", () => {
    const policy = compileSandboxPolicy("auto", roots);
    expect(policy.network).toBe("ask");
    expect(policy.exec).toBe("ask");
    expect(policy.fsWrite).toBe("allow");
  });

  it("full tier allows network, exec, and fsWrite", () => {
    const policy = compileSandboxPolicy("full", roots);
    expect(policy.network).toBe("allow");
    expect(policy.exec).toBe("allow");
    expect(policy.fsWrite).toBe("allow");
  });

  it("danger-full-access requests an unrestricted sandbox", () => {
    const policy = compileSandboxPolicy("danger-full-access", roots);
    expect(policy.unrestricted).toBe(true);
    expect(policy.network).toBe("allow");
    expect(policy.exec).toBe("allow");
    expect(policy.fsWrite).toBe("allow");
    expect(policy.fsWriteOutsideWorkspace).toBe("allow");
    expect(policy.gitMutate).toBe("allow");
  });

  it("all tiers set fsWriteOutsideWorkspace and gitMutate to ask", () => {
    for (const tier of ["readonly", "auto", "full"] as const) {
      const policy = compileSandboxPolicy(tier, roots);
      expect(policy.fsWriteOutsideWorkspace).toBe("ask");
      expect(policy.gitMutate).toBe("ask");
    }
  });

  it("secretZones include DEFAULT_SECRET_ZONES and extraSecretZones", () => {
    const extra = ["**/secrets/**", "**/private.key"];
    const policy = compileSandboxPolicy("auto", roots, extra);
    for (const zone of DEFAULT_SECRET_ZONES) {
      expect(policy.secretZones).toContain(zone);
    }
    for (const zone of extra) {
      expect(policy.secretZones).toContain(zone);
    }
  });

  it("writableRoots is a copy of workspaceRoots, not a shared reference", () => {
    const input = ["/workspace/a"];
    const policy = compileSandboxPolicy("auto", input);
    expect(policy.writableRoots).toEqual(input);
    expect(policy.writableRoots).not.toBe(input);
    policy.writableRoots.push("/mutated");
    expect(input).toEqual(["/workspace/a"]);
  });
});
