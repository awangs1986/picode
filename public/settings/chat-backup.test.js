import { beforeEach, describe, expect, test, vi } from "vitest";
import { setupChatBackup } from "./chat-backup.js";

function markup() {
  document.body.innerHTML = `
    <section id="settings-chat-backup-section">
      <button id="chat-backup-scan"></button>
      <div id="chat-backup-status" hidden></div>
      <div id="chat-backup-results" hidden></div>
      <div id="chat-backup-options" hidden>
        <input type="checkbox" id="chat-backup-encrypted" checked>
        <div id="chat-backup-passwords"></div>
        <input id="chat-backup-password" type="password">
        <input id="chat-backup-password-confirm" type="password">
        <div id="chat-backup-plaintext-warning" hidden></div>
        <span id="chat-backup-selection"></span>
        <button id="chat-backup-create" disabled></button>
      </div>
    </section>
    <section id="settings-chat-restore-section">
      <button id="chat-restore-open"></button>
      <div id="chat-restore-status" hidden></div>
      <div id="chat-restore-verify" hidden>
        <div id="chat-restore-meta"></div>
        <label id="chat-restore-password-field" hidden>
          <input id="chat-restore-password" type="password">
        </label>
        <button id="chat-restore-inspect"></button>
      </div>
      <div id="chat-restore-results" hidden></div>
      <div id="chat-restore-actions" hidden>
        <span id="chat-restore-selection"></span>
        <button id="chat-restore-apply" disabled></button>
      </div>
    </section>`;
}

const backupScan = {
  scanId: "scan-1",
  workspaceGroups: [{ id: "group-1", workspacePath: "D:\\old", candidateCount: 1 }],
  candidates: [
    {
      id: "candidate-1",
      title: "Backup me",
      workspaceGroupId: "group-1",
      workspacePath: "D:\\old",
      sessionFile: "session-1.jsonl",
      sizeBytes: 2048,
    },
  ],
};

describe("chat backup settings", () => {
  beforeEach(() => {
    markup();
    localStorage.clear();
  });

  test("defaults to encryption and includes selected organization metadata", async () => {
    localStorage.setItem("pi-studio-archived", JSON.stringify(["session-1.jsonl"]));
    const transport = {
      scanBackupSessions: vi.fn().mockResolvedValue(backupScan),
      pickBackupSavePath: vi.fn().mockResolvedValue("C:\\backup.picot-backup"),
      createChatBackup: vi.fn().mockResolvedValue({
        path: "C:\\backup.picot-backup",
        encrypted: true,
        chatCount: 1,
      }),
    };
    setupChatBackup({ transport });

    expect(document.getElementById("chat-backup-encrypted").checked).toBe(true);
    document.getElementById("chat-backup-scan").click();
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-backup-candidate]")).toHaveLength(1),
    );
    const candidate = document.querySelector("[data-backup-candidate]");
    expect(candidate.checked).toBe(false);
    candidate.click();
    document.getElementById("chat-backup-password").value = "password-123";
    document.getElementById("chat-backup-password-confirm").value = "password-123";
    document.getElementById("chat-backup-create").click();

    await vi.waitFor(() => expect(transport.createChatBackup).toHaveBeenCalled());
    expect(transport.createChatBackup).toHaveBeenCalledWith({
      scanId: "scan-1",
      candidateIds: ["candidate-1"],
      flags: { "candidate-1": { archived: true, favourite: false } },
      encrypted: true,
      password: "password-123",
      destination: "C:\\backup.picot-backup",
    });
    expect(document.getElementById("chat-backup-password").value).toBe("");
  });

  test("verifies the complete backup before selection and binds each workspace group once", async () => {
    const preview = {
      restoreId: "restore-1",
      encrypted: true,
      workspaceGroups: [{ id: "group-1", workspacePath: "/old/work", candidateCount: 2 }],
      chats: [
        { id: "chat-1", title: "One", workspaceGroupId: "group-1", sizeBytes: 100 },
        { id: "chat-2", title: "Two", workspaceGroupId: "group-1", sizeBytes: 200 },
      ],
    };
    const restored = {
      added: 2,
      skipped: 0,
      conflicted: 0,
      chats: [{ sessionFile: "one.jsonl", archived: true, favourite: false }],
    };
    const transport = {
      pickBackupOpenPath: vi.fn().mockResolvedValue("C:\\backup.picot-backup"),
      probeChatBackup: vi.fn().mockResolvedValue({
        encrypted: true,
        chatCount: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
        applicationVersion: "0.3.0",
      }),
      inspectChatBackup: vi.fn().mockResolvedValue(preview),
      pickFolder: vi.fn().mockResolvedValue("C:\\current\\work"),
      restoreChatBackup: vi.fn().mockResolvedValue(restored),
    };
    const onRestored = vi.fn();
    setupChatBackup({ transport, onRestored });

    document.getElementById("chat-restore-open").click();
    await vi.waitFor(() => expect(transport.probeChatBackup).toHaveBeenCalled());
    document.getElementById("chat-restore-password").value = "password-123";
    document.getElementById("chat-restore-inspect").click();
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-restore-candidate]")).toHaveLength(2),
    );
    expect(
      Array.from(document.querySelectorAll("[data-restore-candidate]")).every(
        (item) => !item.checked,
      ),
    ).toBe(true);
    for (const item of document.querySelectorAll("[data-restore-candidate]")) item.click();
    document.getElementById("chat-restore-apply").click();

    await vi.waitFor(() => expect(transport.restoreChatBackup).toHaveBeenCalled());
    expect(transport.pickFolder).toHaveBeenCalledTimes(1);
    expect(transport.restoreChatBackup).toHaveBeenCalledWith("restore-1", ["chat-1", "chat-2"], {
      "group-1": "C:\\current\\work",
    });
    expect(onRestored).toHaveBeenCalledWith(restored);
    expect(document.getElementById("chat-restore-password").value).toBe("");
  });
});
