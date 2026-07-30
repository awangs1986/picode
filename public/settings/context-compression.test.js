import { beforeEach, describe, expect, test, vi } from "vitest";
import { setupContextCompression } from "./context-compression.js";

function markup() {
  document.body.innerHTML = `
    <section id="settings-context-compression-section">
      <button id="context-compression-scan"></button>
      <div id="context-compression-status" hidden></div>
      <div id="context-compression-results" hidden></div>
      <div id="context-compression-actions" hidden>
        <span id="context-compression-selection"></span>
        <button id="context-compression-review" disabled></button>
      </div>
      <div id="context-compression-review-panel" hidden>
        <div id="context-compression-review-meta"></div>
        <ul id="context-compression-review-sources"></ul>
        <input type="checkbox" id="context-compression-encrypted" checked>
        <div id="context-compression-passwords"></div>
        <input id="context-compression-password" type="password">
        <input id="context-compression-password-confirm" type="password">
        <div id="context-compression-plaintext-warning" hidden></div>
        <button id="context-compression-create"></button>
      </div>
    </section>`;
}

const scan = {
  scanId: "scan-1",
  workspaceGroups: [{ id: "group-1", workspacePath: "C:\\work", candidateCount: 1 }],
  candidates: [
    {
      id: "chat-1",
      title: "One chat",
      workspaceGroupId: "group-1",
      workspacePath: "C:\\work",
      sizeBytes: 1200,
    },
  ],
};

describe("compressed context settings", () => {
  beforeEach(markup);

  test("requires an explicit privacy review before calling the selected Pi model", async () => {
    const transport = {
      scanBackupSessions: vi.fn().mockResolvedValue(scan),
      reviewContextCompression: vi.fn().mockResolvedValue({
        reviewId: "review-1",
        chats: [{ id: "chat-1", title: "One chat", workspacePath: "C:\\work", updatedAt: null }],
        provider: "openai-codex",
        modelId: "gpt-5.2-codex",
        estimatedInputTokens: 500,
        redactedCredentialLines: 1,
      }),
      pickContextPackageSavePath: vi.fn().mockResolvedValue("C:\\context.picot-context"),
      createContextPackage: vi.fn().mockResolvedValue({
        path: "C:\\context.picot-context",
        memoryCount: 8,
      }),
    };
    setupContextCompression({
      transport,
      getSelectedModel: () => ({ provider: "openai-codex", modelId: "gpt-5.2-codex" }),
    });

    document.getElementById("context-compression-scan").click();
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-context-candidate]")).toHaveLength(1),
    );
    expect(transport.reviewContextCompression).not.toHaveBeenCalled();
    document.querySelector("[data-context-candidate]").click();
    document.getElementById("context-compression-review").click();
    await vi.waitFor(() => expect(transport.reviewContextCompression).toHaveBeenCalled());
    expect(transport.createContextPackage).not.toHaveBeenCalled();
    expect(document.getElementById("context-compression-review-panel").hidden).toBe(false);

    document.getElementById("context-compression-password").value = "password-123";
    document.getElementById("context-compression-password-confirm").value = "password-123";
    document.getElementById("context-compression-create").click();
    await vi.waitFor(() => expect(transport.createContextPackage).toHaveBeenCalled());
    expect(transport.createContextPackage).toHaveBeenCalledWith({
      reviewId: "review-1",
      encrypted: true,
      password: "password-123",
      destination: "C:\\context.picot-context",
    });
    expect(document.getElementById("context-compression-password").value).toBe("");
  });
});
