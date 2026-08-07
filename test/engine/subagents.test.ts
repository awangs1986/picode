import { describe, expect, it } from "vitest";
import {
  WATCHDOG_PRESETS,
  gateSubagentWrite,
  type SubagentStatus,
} from "../../src/engine/subagents.ts";

describe("WATCHDOG_PRESETS", () => {
  it("normal enables scopeDrift and lsp but not adversarialReview", () => {
    expect(WATCHDOG_PRESETS.normal).toEqual({
      level: "normal",
      scopeDriftReporting: true,
      adversarialReview: false,
      lspDiagnostics: true,
    });
  });

  it("strict enables all watchdog features", () => {
    expect(WATCHDOG_PRESETS.strict).toEqual({
      level: "strict",
      scopeDriftReporting: true,
      adversarialReview: true,
      lspDiagnostics: true,
    });
  });

  it("off disables all watchdog features", () => {
    expect(WATCHDOG_PRESETS.off).toEqual({
      level: "off",
      scopeDriftReporting: false,
      adversarialReview: false,
      lspDiagnostics: false,
    });
  });
});

describe("gateSubagentWrite", () => {
  const baseStatus: SubagentStatus = {
    subagentId: "sub-1",
    state: "running",
    sandboxAcknowledged: false,
    artifacts: [],
  };

  it("returns ok when hasWriteScope is false regardless of acknowledgment", () => {
    expect(gateSubagentWrite(baseStatus, false).ok).toBe(true);
    expect(
      gateSubagentWrite({ ...baseStatus, sandboxAcknowledged: true }, false).ok,
    ).toBe(true);
  });

  it("returns engine/subagent-sandbox-unconfirmed when write scope and not acknowledged", () => {
    const r = gateSubagentWrite(baseStatus, true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("engine/subagent-sandbox-unconfirmed");
  });

  it("returns ok when write scope and sandbox acknowledged", () => {
    const r = gateSubagentWrite({ ...baseStatus, sandboxAcknowledged: true }, true);
    expect(r.ok).toBe(true);
  });
});
