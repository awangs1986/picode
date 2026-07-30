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
      pickFolder: vi.fn(async () => "D:\\game"),
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
    expect(transport.previewExternalCapabilityImport).not.toHaveBeenCalled();
    expect(transport.setProfessionalExtensionEnabled).not.toHaveBeenCalled();
    expect(panel.textContent).toContain("0 resident processes");

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
});
