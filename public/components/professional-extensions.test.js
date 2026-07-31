// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import "./professional-extensions.js";

describe("picode-professional-extensions", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("loads only state and requires manual selective import and enablement", async () => {
    const transport = {
      taskSnapshot: vi.fn(async () => ({
        extensions: {
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
        },
      })),
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
      firstmateStatus: vi.fn(async () => ({ enabled: false, available: false, root: null })),
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
    };
    const Panel = customElements.get("picode-professional-extensions");
    const panel = new Panel();
    panel.transport = transport;
    document.body.appendChild(panel);
    await panel.refresh();

    expect(transport.taskSnapshot).toHaveBeenCalled();
    expect(transport.capabilitySnapshot).toHaveBeenCalled();
    expect(transport.listSkills).toHaveBeenCalled();
    expect(transport.previewExternalCapabilityImport).not.toHaveBeenCalled();
    expect(transport.setProfessionalExtensionEnabled).not.toHaveBeenCalled();
    expect(panel.textContent).toContain("0 resident processes");
    expect(panel.querySelectorAll(".picode-skill-bundle")).toHaveLength(1);
    expect(panel.querySelector(".picode-skill-bundle > summary")?.textContent).toContain(
      "mattpocock/skills",
    );
    expect(panel.querySelectorAll(".picode-skill-bundle .picode-skill-row")).toHaveLength(2);
    expect(panel.querySelector('[data-capability="firstmate-crew-orchestrator"]')).not.toBeNull();
    expect(panel.querySelector("[data-firstmate-pick-root]")).not.toBeNull();

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
      taskSnapshot: vi.fn(async () => {
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
