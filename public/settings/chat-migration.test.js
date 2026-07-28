import { beforeEach, describe, expect, test, vi } from "vitest";
import { setupChatMigration } from "./chat-migration.js";

function markup() {
  document.body.innerHTML = `
    <section id="settings-chat-migration-section">
      <div id="chat-migration-sources">
        <input type="checkbox" value="codex" checked>
        <input type="checkbox" value="cursor" checked>
        <input type="checkbox" value="claude" checked>
      </div>
      <button id="chat-migration-scan"></button>
      <div id="chat-migration-status" hidden></div>
      <div id="chat-migration-results" hidden></div>
      <div id="chat-migration-actions" hidden></div>
      <span id="chat-migration-selection"></span>
      <button id="chat-migration-import" disabled></button>
    </section>`;
}

const scan = {
  scanId: "scan-1",
  warnings: [],
  workspaceGroups: [
    {
      id: "group-a",
      source: "codex",
      originalWorkspace: "D:\\old\\alpha",
      candidateCount: 2,
    },
    {
      id: "group-b",
      source: "cursor",
      originalWorkspace: "/old/beta",
      candidateCount: 1,
    },
  ],
  candidates: [
    {
      id: "chat-a1",
      source: "codex",
      title: "Alpha one",
      workspaceGroupId: "group-a",
      archived: true,
    },
    {
      id: "chat-a2",
      source: "codex",
      title: "Alpha two",
      workspaceGroupId: "group-a",
      archived: false,
    },
    {
      id: "chat-b1",
      source: "cursor",
      title: "Beta one",
      workspaceGroupId: "group-b",
      archived: false,
    },
  ],
};

describe("local chat migration settings", () => {
  beforeEach(markup);

  test("renders every candidate unchecked and binds a workspace group exactly once", async () => {
    const result = {
      imported: 2,
      skipped: 0,
      chats: [
        { candidateId: "chat-a1", sessionFile: "a1.jsonl", archived: true },
        { candidateId: "chat-a2", sessionFile: "a2.jsonl", archived: false },
      ],
    };
    const transport = {
      scanLocalChats: vi.fn().mockResolvedValue(scan),
      pickFolder: vi.fn().mockResolvedValue("C:\\current\\alpha"),
      importLocalChats: vi.fn().mockResolvedValue(result),
    };
    const onImported = vi.fn();
    setupChatMigration({ transport, onImported });

    document.getElementById("chat-migration-scan").click();
    await vi.waitFor(() => expect(transport.scanLocalChats).toHaveBeenCalled());
    const candidates = Array.from(document.querySelectorAll("[data-chat-candidate]"));
    expect(candidates).toHaveLength(3);
    expect(candidates.every((candidate) => !candidate.checked)).toBe(true);
    expect(document.querySelectorAll(".chat-migration-workspace")).toHaveLength(2);
    expect(document.querySelector(".chat-migration-archive-badge")?.textContent).toBe("Archived");

    candidates[0].click();
    candidates[1].click();
    document.getElementById("chat-migration-import").click();

    await vi.waitFor(() => expect(transport.importLocalChats).toHaveBeenCalled());
    expect(transport.pickFolder).toHaveBeenCalledTimes(1);
    expect(transport.importLocalChats).toHaveBeenCalledWith("scan-1", ["chat-a1", "chat-a2"], {
      "group-a": "C:\\current\\alpha",
    });
    expect(onImported).toHaveBeenCalledWith(result);
  });

  test("cancelling any required workspace picker writes no partial import", async () => {
    const transport = {
      scanLocalChats: vi.fn().mockResolvedValue(scan),
      pickFolder: vi.fn().mockResolvedValueOnce("C:\\current\\alpha").mockResolvedValueOnce(null),
      importLocalChats: vi.fn(),
    };
    setupChatMigration({ transport });
    document.getElementById("chat-migration-scan").click();
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-chat-candidate]")).toHaveLength(3),
    );
    document.querySelector('[data-chat-candidate="chat-a1"]').click();
    document.querySelector('[data-chat-candidate="chat-b1"]').click();
    document.getElementById("chat-migration-import").click();

    await vi.waitFor(() => expect(transport.pickFolder).toHaveBeenCalledTimes(2));
    expect(transport.importLocalChats).not.toHaveBeenCalled();
    expect(document.getElementById("chat-migration-status").textContent).toContain("cancelled");
  });
});
