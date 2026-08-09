import { describe, expect, it, vi } from "vitest";
import {
  HarnessState,
  TIER_POLICIES,
  handleHarnessCommand,
  restoreHarnessTier,
} from "../../src/extension/harness.ts";

describe("TIER_POLICIES", () => {
  it("simple tier has no sandbox, no MCP, web-only tools, no injection, watchdog off", () => {
    expect(TIER_POLICIES.simple).toEqual({
      sandbox: false,
      mcp: false,
      extensionTools: "web-only",
      promptInjection: "none",
      watchdog: "off",
    });
  });

  it("standard has lean guidance and tdd has full guidance with strict watchdog", () => {
    expect(TIER_POLICIES.standard.promptInjection).toBe("lean");
    expect(TIER_POLICIES.tdd).toMatchObject({
      promptInjection: "full",
      watchdog: "strict",
    });
  });
});

describe("HarnessState.switchTo", () => {
  it("restores the latest session-scoped tier from append-only custom entries", () => {
    expect(restoreHarnessTier([
      { type: "custom", customType: "picode.harness-tier", data: { tier: "standard" } },
      { type: "custom", customType: "other", data: { tier: "simple" } },
      { type: "custom", customType: "picode.harness-tier", data: { tier: "tdd" } },
    ])).toBe("tdd");
  });

  it("does not invoke callback when switching to the same tier", () => {
    const onTierChanged = vi.fn();
    const state = new HarnessState("standard", onTierChanged);
    state.switchTo("standard");
    expect(onTierChanged).not.toHaveBeenCalled();
  });

  it("invokes callback once with correct from/to on tier change", () => {
    const onTierChanged = vi.fn();
    const state = new HarnessState("simple", onTierChanged);
    state.switchTo("tdd");
    expect(onTierChanged).toHaveBeenCalledTimes(1);
    expect(onTierChanged).toHaveBeenCalledWith("simple", "tdd");
    expect(state.current()).toBe("tdd");
  });
});

describe("handleHarnessCommand", () => {
  it("shows current tier when called without args", () => {
    const state = new HarnessState("standard", () => {});
    const msg = handleHarnessCommand(state, undefined);
    expect(msg).toContain("current harness tier: standard");
  });

  it("shows current tier for blank arg", () => {
    const state = new HarnessState("standard", () => {});
    expect(handleHarnessCommand(state, "   ")).toContain("current harness tier: standard");
  });

  it("returns unknown tier message for invalid name", () => {
    const state = new HarnessState("standard", () => {});
    const msg = handleHarnessCommand(state, "turbo");
    expect(msg).toContain('unknown tier "turbo"');
  });

  it("maps harness alias to standard tier", () => {
    const onTierChanged = vi.fn();
    const state = new HarnessState("simple", onTierChanged);
    const msg = handleHarnessCommand(state, "harness");
    expect(msg).toContain("simple → standard");
    expect(state.current()).toBe("standard");
    expect(onTierChanged).toHaveBeenCalledWith("simple", "standard");
  });

  it("reports successful switch with from → to", () => {
    const state = new HarnessState("simple", () => {});
    const msg = handleHarnessCommand(state, "tdd");
    expect(msg).toContain("harness tier: simple → tdd");
    expect(msg).toContain("sandbox: off → on");
    expect(msg).toContain("MCP: off → on");
    expect(msg).toContain("tools: web-only → full");
    expect(msg).toContain("default prompt: none → full");
    expect(msg).toContain("system prompt: reset to harness default full");
    expect(state.current()).toBe("tdd");
  });

  it("reports already on when switching to current tier", () => {
    const state = new HarnessState("standard", () => {});
    const msg = handleHarnessCommand(state, "standard");
    expect(msg).toBe("already on standard");
  });
});
