import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLICE_THRESHOLDS,
  evaluateSlice,
} from "../../../src/devloop/task/slice.ts";

describe("evaluateSlice", () => {
  it("returns advise=false when no signals are active", () => {
    const advice = evaluateSlice({
      userRequested: false,
      contextUsageRatio: 0,
      turnCount: 0,
      scopeDriftReported: false,
    });
    expect(advice.advise).toBe(false);
    expect(advice.channels).toEqual([]);
    expect(advice.reason).toBe("no trigger channel active");
  });

  it("includes user-command channel when userRequested", () => {
    const advice = evaluateSlice({
      userRequested: true,
      contextUsageRatio: 0,
      turnCount: 0,
      scopeDriftReported: false,
    });
    expect(advice.advise).toBe(true);
    expect(advice.channels).toContain("user-command");
    expect(advice.reason).toContain("user requested /slice");
  });

  it("includes soft-threshold when contextUsageRatio reaches default threshold", () => {
    const advice = evaluateSlice({
      userRequested: false,
      contextUsageRatio: 0.6,
      turnCount: 0,
      scopeDriftReported: false,
    });
    expect(advice.channels).toContain("soft-threshold");
    expect(advice.reason).toContain("soft threshold reached");
  });

  it("includes soft-threshold when turnCount reaches default threshold", () => {
    const advice = evaluateSlice({
      userRequested: false,
      contextUsageRatio: 0,
      turnCount: 40,
      scopeDriftReported: false,
    });
    expect(advice.channels).toContain("soft-threshold");
  });

  it("excludes soft-threshold when both context and turn are below defaults", () => {
    const advice = evaluateSlice({
      userRequested: false,
      contextUsageRatio: 0.59,
      turnCount: 39,
      scopeDriftReported: false,
    });
    expect(advice.channels).not.toContain("soft-threshold");
  });

  it("includes watchdog-scope-drift when scopeDriftReported", () => {
    const advice = evaluateSlice({
      userRequested: false,
      contextUsageRatio: 0,
      turnCount: 0,
      scopeDriftReported: true,
    });
    expect(advice.channels).toContain("watchdog-scope-drift");
    expect(advice.reason).toContain("watchdog reported scope drift");
  });

  it("combines all channels and joins reason parts when multiple signals active", () => {
    const advice = evaluateSlice({
      userRequested: true,
      contextUsageRatio: 0.75,
      turnCount: 50,
      scopeDriftReported: true,
    });
    expect(advice.advise).toBe(true);
    expect(advice.channels).toEqual([
      "user-command",
      "soft-threshold",
      "watchdog-scope-drift",
    ]);
    expect(advice.reason).toContain("user requested /slice");
    expect(advice.reason).toContain("soft threshold reached");
    expect(advice.reason).toContain("watchdog reported scope drift");
    expect(advice.reason.split("; ")).toHaveLength(3);
  });

  it("respects custom thresholds", () => {
    const advice = evaluateSlice(
      {
        userRequested: false,
        contextUsageRatio: 0.5,
        turnCount: 10,
        scopeDriftReported: false,
      },
      { contextUsageRatio: 0.5, turnCount: 10 },
    );
    expect(advice.channels).toContain("soft-threshold");

    const below = evaluateSlice(
      {
        userRequested: false,
        contextUsageRatio: 0.49,
        turnCount: 9,
        scopeDriftReported: false,
      },
      { contextUsageRatio: 0.5, turnCount: 10 },
    );
    expect(below.channels).not.toContain("soft-threshold");
    expect(below.advise).toBe(false);
  });

  it("uses DEFAULT_SLICE_THRESHOLDS when thresholds omitted", () => {
    expect(DEFAULT_SLICE_THRESHOLDS.contextUsageRatio).toBe(0.6);
    expect(DEFAULT_SLICE_THRESHOLDS.turnCount).toBe(40);
  });

  it("turns the hard threshold into a deterministic enforcement boundary", () => {
    const advice = evaluateSlice({
      userRequested: false,
      contextUsageRatio: 0.85,
      turnCount: 65,
      scopeDriftReported: false,
    });
    expect(advice.enforce).toBe(true);
    expect(advice.channels).toContain("hard-threshold");
  });

  it("keeps a tool-heavy Slice advisory while the real context remains below the hard boundary", () => {
    const advice = evaluateSlice({
      userRequested: false,
      contextUsageRatio: 0.315,
      turnCount: 65,
      scopeDriftReported: false,
    });

    expect(advice.advise).toBe(true);
    expect(advice.enforce).toBe(false);
    expect(advice.channels).toEqual(["soft-threshold"]);
    expect(advice.reason).not.toContain("hard Slice boundary reached");
  });
});
