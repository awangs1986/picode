// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import "./professional-extensions.js";

describe("picode-professional-extensions", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("loads only state and requires manual selective import and enablement", async () => {
    const transport = {
      extensionSnapshot: vi.fn(async () => ({
        installations: [
          {
            id: "review",
            schemaVersion: 1,
            permissions: ["workspaceRead"],
            enabled: false,
          },
        ],
        runs: [],
        imports: [],
        mcpConfigs: [],
        residentProcessCount: 0,
        firstmate: { enabled: false, trusted: false, root: null },
        skills: [
          {
            id: "tdd",
            name: "tdd",
            description: "Test-driven development",
            source: "git:github.com/mattpocock/skills",
            enabled: true,
            trusted: true,
          },
          {
            id: "grill-with-docs",
            name: "grill-with-docs",
            description: "Planning interview",
            source: "git:github.com/mattpocock/skills",
            enabled: true,
            trusted: true,
          },
        ],
        catalogComponents: [
          { id: "rust-lsp", kind: "lsp", enabled: true, trusted: false },
          {
            id: "herdr-terminal-host",
            kind: "native-helper",
            enabled: false,
            trusted: false,
          },
        ],
        components: [
          {
            id: "rust-lsp",
            kind: "lsp",
            state: "enabled",
            source: "builtin:picode",
            version: "2",
            license: "MIT",
            permissions: ["workspace.read", "process.exec"],
            taskBindings: ["task-a"],
            runningProcesses: [],
            lastError: "server stopped",
            modelDiscoverable: true,
          },
          {
            id: "tdd",
            kind: "skill",
            state: "trusted",
            source: "git:github.com/mattpocock/skills",
            version: "runtime",
            license: "provided-by-package",
            permissions: [],
            taskBindings: [],
            runningProcesses: [],
            modelDiscoverable: true,
          },
          {
            id: "grill-with-docs",
            kind: "skill",
            state: "trusted",
            source: "https://github.com/mattpocock/skills.git@v1",
            version: "runtime",
            license: "provided-by-package",
            permissions: [],
            taskBindings: [],
            runningProcesses: [],
            modelDiscoverable: true,
          },
          {
            id: "herdr-terminal-host",
            kind: "native-helper",
            state: "discovered",
            source: "https://github.com/herdrdev/herdr#44b3adb",
            version: "0.7.5",
            license: "Apache-2.0",
            permissions: ["ProcessExecute", "Network"],
            taskBindings: [],
            runningProcesses: [],
            modelDiscoverable: false,
          },
        ],
      })),
      herdrStatus: vi.fn(async () => ({
        decision: "declined",
        installed: false,
        enabled: false,
        trusted: false,
        running: false,
      })),
      resetHerdrDecision: vi.fn(async () => ({})),
      capabilitySnapshot: vi.fn(async () => ({
        capabilities: [
          {
            id: "firstmate-crew-orchestrator",
            summary: "Optional external crew",
            tier: "disabled",
          },
        ],
      })),
      listSkills: vi.fn(async () => [
        {
          name: "tdd",
          description: "Test-driven development",
          scope: "personal",
          source: "git:github.com/mattpocock/skills",
          origin: "package",
        },
        {
          name: "grill-with-docs",
          description: "Planning interview",
          scope: "personal",
          source: "git:github.com/mattpocock/skills",
          origin: "package",
        },
      ]),
      syncExtensionSkills: vi.fn(async () => ({})),
      setCapabilityTier: vi.fn(async () => ({})),
      pickFolder: vi.fn(async () => "D:\\game"),
      setFirstmateRoot: vi.fn(async () => ({})),
      previewExternalCapabilityImport: vi.fn(async () => ({
        id: "preview-a",
        candidates: [
          { id: "rule-a", kind: "rule", relativePath: "AGENTS.md", version: "sha256:a" },
          {
            id: "command-b",
            kind: "command",
            relativePath: ".cursor/commands/build.ps1",
            unsupportedReason: "only Markdown",
          },
        ],
      })),
      applyExternalCapabilityImport: vi.fn(async () => []),
      setProfessionalExtensionEnabled: vi.fn(async () => ({})),
      setProfessionalExtensionTrusted: vi.fn(async () => ({})),
      setExtensionComponentEnabled: vi.fn(async () => ({})),
      setExtensionComponentTrusted: vi.fn(async () => ({})),
      effectiveCapabilityReport: vi.fn(async () => ({
        residentCore: ["conversation", "task-control"],
        capabilities: [
          {
            id: "task-build",
            promptVisible: true,
            activeForTask: true,
            loaded: false,
            provenance: "TOOLS.md task binding",
          },
        ],
        rules: [{ id: "AGENTS.md", provenance: "workspace/AGENTS.md", active: true }],
        skills: [],
        overrides: [],
      })),
    };
    const Panel = customElements.get("picode-professional-extensions");
    const panel = new Panel();
    panel.transport = transport;
    document.body.appendChild(panel);
    await panel.refresh();

    expect(transport.extensionSnapshot).toHaveBeenCalled();
    expect(transport.capabilitySnapshot).toHaveBeenCalled();
    expect(transport.listSkills).toHaveBeenCalled();
    expect(transport.previewExternalCapabilityImport).not.toHaveBeenCalled();
    expect(transport.setProfessionalExtensionEnabled).not.toHaveBeenCalled();
    expect(panel.querySelector('[data-extension-trust="review"]').disabled).toBe(true);
    expect(panel.textContent).toContain("0 resident processes");
    expect(
      panel.querySelectorAll(".picode-skill-bundle:not(.picode-component-skill-bundle)"),
    ).toHaveLength(1);
    expect(
      panel.querySelector(".picode-skill-bundle:not(.picode-component-skill-bundle) > summary")
        ?.textContent,
    ).toContain("mattpocock/skills");
    expect(
      panel.querySelectorAll(
        ".picode-skill-bundle:not(.picode-component-skill-bundle) .picode-skill-row",
      ),
    ).toHaveLength(2);
    expect(panel.querySelector('[data-capability="firstmate-crew-orchestrator"]')).not.toBeNull();
    expect(panel.querySelector("[data-firstmate-pick-root]")).not.toBeNull();
    expect(panel.querySelector('[data-component="rust-lsp"]')?.textContent).toContain(
      "builtin:picode @ 2",
    );
    expect(panel.querySelector('[data-component="rust-lsp"]')?.textContent).toContain(
      "server stopped",
    );
    expect(panel.querySelector('[data-component-trust="rust-lsp"]')).not.toBeNull();
    expect(panel.querySelector('[data-component="herdr-terminal-host"]')?.textContent).toContain(
      "Apache-2.0",
    );
    expect(panel.querySelector('[data-component-enable="herdr-terminal-host"]')).toBeNull();
    expect(panel.querySelector("[data-herdr-reset]")).not.toBeNull();
    const componentSkillBundle = panel.querySelector(
      '[data-component-skill-bundle="github.com/mattpocock/skills"]',
    );
    expect(componentSkillBundle).not.toBeNull();
    expect(componentSkillBundle.open).toBe(false);
    expect(componentSkillBundle.querySelector("summary")?.textContent).toContain(
      "mattpocock/skills",
    );
    expect(componentSkillBundle.querySelectorAll('[data-component-kind="skill"]')).toHaveLength(2);

    panel.querySelector("[data-effective-task]").value = "task-a";
    panel.querySelector("[data-effective-report]").click();
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.effectiveCapabilityReport).toHaveBeenCalledWith(
      "task-a",
      [],
      expect.arrayContaining([
        expect.objectContaining({ id: "tdd", provenance: "git:github.com/mattpocock/skills" }),
      ]),
      [],
    );
    expect(panel.querySelector("[data-effective-output]").textContent).toContain("task-build");
    expect(panel.querySelector("[data-effective-output]").textContent).toContain("AGENTS.md");

    panel.querySelector("[data-herdr-reset]").click();
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.resetHerdrDecision).toHaveBeenCalledTimes(1);

    const tier = panel.querySelector('[data-capability-tier="firstmate-crew-orchestrator"]');
    tier.value = "discoverable";
    tier.dispatchEvent(new Event("change"));
    await Promise.resolve();
    expect(transport.setCapabilityTier).toHaveBeenCalledWith(
      "firstmate-crew-orchestrator",
      "discoverable",
    );

    panel.querySelector("[data-pick-import-root]").click();
    await Promise.resolve();
    await Promise.resolve();
    panel.querySelector("[data-preview-import]").click();
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.previewExternalCapabilityImport).toHaveBeenCalledWith("codex", "D:\\game");
    expect(panel.querySelector('[data-import-candidate="rule-a"]').checked).toBe(false);
    expect(panel.querySelector('[data-import-candidate="command-b"]').disabled).toBe(true);
    expect(transport.applyExternalCapabilityImport).not.toHaveBeenCalled();

    panel.querySelector('[data-import-candidate="rule-a"]').click();
    panel.querySelector("[data-apply-import]").click();
    await Promise.resolve();
    expect(transport.applyExternalCapabilityImport).toHaveBeenCalledWith(
      "preview-a",
      ["rule-a"],
      "global",
    );
  });

  it("still renders optional capabilities when the task snapshot is unavailable", async () => {
    const transport = {
      extensionSnapshot: vi.fn(async () => {
        throw new Error("task snapshot timed out");
      }),
      capabilitySnapshot: vi.fn(async () => ({
        capabilities: [
          { id: "browser-automation", summary: "Local browser checks", tier: "discoverable" },
        ],
      })),
    };
    const Panel = customElements.get("picode-professional-extensions");
    const panel = new Panel();
    panel.transport = transport;
    document.body.appendChild(panel);
    await panel.refresh();

    expect(panel.querySelector('[data-capability="browser-automation"]')).not.toBeNull();
    expect(panel.textContent).toContain("Optional capabilities");
    expect(panel.textContent).toContain("task snapshot timed out");
  });
});
