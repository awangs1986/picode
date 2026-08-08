import { describe, expect, it, vi } from "vitest";
import { CapabilityReadinessRegistry, filterToolNamesForReadiness } from "../../src/engine/readiness.ts";

describe("Capability Readiness", () => {
  it("does not report pi-lens ready outside the tdd tier", async () => {
    const registry = CapabilityReadinessRegistry.defaults({ env: {}, commandExists: () => true });
    const result = await registry.inspect("pi-lens", { cwd: process.cwd(), harnessTier: "standard" });
    expect(result.status).toBe("NeedsSetup");
    expect(result.summary).toContain("inactive outside");
  });

  it("keeps fetch and the plugin's zero-config search independently ready", async () => {
    const registry = CapabilityReadinessRegistry.defaults({ env: {}, commandExists: () => true });
    const reports = await registry.inspectAll({ cwd: process.cwd(), harnessTier: "standard" });
    expect(reports.find((r) => r.capabilityId === "web.fetch")?.status).toBe("Ready");
    expect(reports.find((r) => r.capabilityId === "web.search")?.status).toBe("Ready");
  });

  it("recognizes the mcpServers shape used by pi-mcp-adapter", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const cwd = mkdtempSync(join(tmpdir(), "picode-mcp-ready-"));
    try {
      writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { local: { command: "node" } } }));
      const registry = CapabilityReadinessRegistry.defaults({ env: {}, commandExists: () => true });
      expect((await registry.inspect("mcp", { cwd, harnessTier: "standard" })).status).toBe("Ready");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it("removes unusable schemas without hiding independent fetch", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const filtered = filterToolNamesForReadiness(["git", "mcp", "web_search", "web_fetch", "read"], [
      { capabilityId: "git", status: "Unavailable", summary: "", missing: [], nextSteps: [], inspectedAt: at },
      { capabilityId: "mcp", status: "NeedsSetup", summary: "", missing: [], nextSteps: [], inspectedAt: at },
      { capabilityId: "web.search", status: "NeedsSetup", summary: "", missing: [], nextSteps: [], inspectedAt: at },
      { capabilityId: "web.fetch", status: "Ready", summary: "", missing: [], nextSteps: [], inspectedAt: at },
    ]);
    expect(filtered).toEqual(["web_fetch", "read"]);
  });

  it("probes without installing, authenticating, or spending network", async () => {
    const commandExists = vi.fn(() => false);
    const registry = CapabilityReadinessRegistry.defaults({ env: {}, commandExists });
    await registry.inspectAll({ cwd: process.cwd(), harnessTier: "standard" });
    expect(commandExists).toHaveBeenCalled();
  });
});
