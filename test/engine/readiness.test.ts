import { describe, expect, it, vi } from "vitest";
import { CapabilityReadinessRegistry, filterToolNamesForReadiness } from "../../src/engine/readiness.ts";

describe("Capability Readiness", () => {
  it.runIf(process.platform === "win32")("treats Windows environment variable names case-insensitively", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "picode-path-case-"));
    const bin = join(root, "bin");
    const project = join(root, "project");
    try {
      mkdirSync(bin);
      mkdirSync(join(project, ".git"), { recursive: true });
      writeFileSync(join(bin, "git.cmd"), "@exit /b 0\r\n", "utf8");
      const registry = CapabilityReadinessRegistry.defaults({ env: { Path: bin } });
      const result = await registry.inspect("git", { cwd: project, harnessTier: "standard" });
      expect(result.status).toBe("Ready");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not report pi-lens ready outside the tdd tier", async () => {
    const registry = CapabilityReadinessRegistry.defaults({ env: {}, commandExists: () => true });
    const result = await registry.inspect("pi-lens", { cwd: process.cwd(), harnessTier: "standard" });
    expect(result.status).toBe("NeedsSetup");
    expect(result.summary).toContain("inactive outside");
  });

  it("finds the vendored TypeScript language server for a TDD project without global PATH setup", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "picode-lsp-ready-"));
    const project = join(root, "project");
    try {
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, "tsconfig.json"), "{}", "utf8");
      const bin = join(root, "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, process.platform === "win32" ? "typescript-language-server.cmd" : "typescript-language-server"), "", "utf8");
      const registry = CapabilityReadinessRegistry.defaults({
        env: { PATH: "", PICODE_PACKAGE_ROOT: root },
      });
      const result = await registry.inspect("pi-lens", { cwd: project, harnessTier: "tdd" });
      expect(result.status).toBe("Ready");
      expect(result.summary).toContain("TypeScript");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not claim a mismatched language server is ready", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const project = mkdtempSync(join(tmpdir(), "picode-rust-lsp-"));
    try {
      writeFileSync(join(project, "Cargo.toml"), "[package]\nname='fixture'\nversion='0.0.0'\n", "utf8");
      const registry = CapabilityReadinessRegistry.defaults({ env: {}, commandExists: (name) => name === "typescript-language-server" });
      const result = await registry.inspect("pi-lens", { cwd: project, harnessTier: "tdd" });
      expect(result.status).toBe("Degraded");
      expect(result.missing).toContain("rust-analyzer");
    } finally { rmSync(project, { recursive: true, force: true }); }
  });

  it("recognizes a C# project and csharp-ls using the same readiness semantics as pi-lens", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const project = mkdtempSync(join(tmpdir(), "picode-csharp-lsp-"));
    try {
      writeFileSync(join(project, "Game.csproj"), "<Project Sdk=\"Godot.NET.Sdk\" />", "utf8");
      const registry = CapabilityReadinessRegistry.defaults({
        env: {},
        commandExists: (name) => name === "csharp-ls",
      });

      const result = await registry.inspect("pi-lens", { cwd: project, harnessTier: "tdd" });

      expect(result.status).toBe("Ready");
      expect(result.summary).toContain("C#");
    } finally { rmSync(project, { recursive: true, force: true }); }
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
