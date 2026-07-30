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
      <div id="chat-migration-review-controls" hidden>
        <select id="chat-migration-sort">
          <option value="updated-desc">Newest first</option>
          <option value="updated-asc">Oldest first</option>
          <option value="size-desc">Largest first</option>
          <option value="size-asc">Smallest first</option>
        </select>
        <select id="chat-migration-source-filter">
          <option value="all">All agents</option>
          <option value="codex">Codex</option>
          <option value="cursor">Cursor</option>
          <option value="claude">Claude</option>
        </select>
        <select id="chat-migration-archive-filter">
          <option value="all">All</option>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
        </select>
      </div>
      <div id="chat-migration-results" hidden></div>
      <div id="chat-migration-actions" hidden>
        <input id="chat-migration-include-reasoning" type="checkbox">
      </div>
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
      lastMessageSnippet: "The latest meaningful assistant reply",
      updatedAt: 100,
      fileSizeBytes: 2048,
      workspaceGroupId: "group-a",
      archived: true,
    },
    {
      id: "chat-a2",
      source: "codex",
      title: "Alpha two",
      lastMessageSnippet: "A smaller, newer conversation",
      updatedAt: 300,
      fileSizeBytes: 512,
      workspaceGroupId: "group-a",
      archived: false,
    },
    {
      id: "chat-b1",
      source: "cursor",
      title: "Beta one",
      lastMessageSnippet: "A large active conversation",
      updatedAt: 200,
      fileSizeBytes: 4096,
      workspaceGroupId: "group-b",
      archived: false,
    },
  ],
};

describe("local chat migration settings", () => {
  beforeEach(markup);

  test("defaults the archive review filter to non-archived chats", () => {
    setupChatMigration({
      transport: {
        scanLocalChats: vi.fn(),
        pickFolder: vi.fn(),
        importLocalChats: vi.fn(),
      },
    });

    expect(document.getElementById("chat-migration-archive-filter").value).toBe("active");
    expect(document.getElementById("chat-migration-include-reasoning").checked).toBe(false);
  });

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
    document.getElementById("chat-migration-archive-filter").value = "all";

    document.getElementById("chat-migration-scan").click();
    await vi.waitFor(() => expect(transport.scanLocalChats).toHaveBeenCalled());
    const candidates = Array.from(document.querySelectorAll("[data-chat-candidate]"));
    expect(candidates).toHaveLength(3);
    expect(document.getElementById("chat-migration-results").dataset.chatScanId).toBe("scan-1");
    expect(candidates.every((candidate) => !candidate.checked)).toBe(true);
    expect(document.querySelectorAll(".chat-migration-workspace")).toHaveLength(2);
    expect(document.querySelector(".chat-migration-archive-badge")?.textContent).toBe("Archived");

    candidates[0].click();
    candidates[1].click();
    document.getElementById("chat-migration-import").click();

    await vi.waitFor(() => expect(transport.importLocalChats).toHaveBeenCalled());
    expect(transport.pickFolder).toHaveBeenCalledTimes(1);
    expect(transport.importLocalChats).toHaveBeenCalledWith(
      "scan-1",
      ["chat-a1", "chat-a2"],
      { "group-a": "C:\\current\\alpha" },
      { includeReasoning: false },
    );
    expect(onImported).toHaveBeenCalledWith(result);
  });

  test("cancelling any required workspace picker writes no partial import", async () => {
    const transport = {
      scanLocalChats: vi.fn().mockResolvedValue(scan),
      pickFolder: vi.fn().mockResolvedValueOnce("C:\\current\\alpha").mockResolvedValueOnce(null),
      importLocalChats: vi.fn(),
    };
    setupChatMigration({ transport });
    document.getElementById("chat-migration-archive-filter").value = "all";
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

  test("passes the explicit full-reasoning choice to the importer", async () => {
    const transport = {
      scanLocalChats: vi.fn().mockResolvedValue(scan),
      pickFolder: vi.fn().mockResolvedValue("C:\\current\\alpha"),
      importLocalChats: vi.fn().mockResolvedValue({ imported: 1, skipped: 0, chats: [] }),
    };
    setupChatMigration({ transport });
    document.getElementById("chat-migration-scan").click();
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-chat-candidate]")).toHaveLength(2),
    );
    document.querySelector('[data-chat-candidate="chat-a2"]').click();
    document.getElementById("chat-migration-include-reasoning").click();
    document.getElementById("chat-migration-import").click();

    await vi.waitFor(() => expect(transport.importLocalChats).toHaveBeenCalled());
    expect(transport.importLocalChats).toHaveBeenCalledWith(
      "scan-1",
      ["chat-a2"],
      { "group-a": "C:\\current\\alpha" },
      { includeReasoning: true },
    );
  });

  test("shows readable chat summaries and can sort and filter the review list", async () => {
    const transport = {
      scanLocalChats: vi.fn().mockResolvedValue(scan),
      pickFolder: vi.fn(),
      importLocalChats: vi.fn(),
    };
    setupChatMigration({ transport });
    document.getElementById("chat-migration-scan").click();
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-chat-candidate]")).toHaveLength(2),
    );

    const visibleTitles = () =>
      Array.from(document.querySelectorAll(".chat-migration-candidate-title"), (node) =>
        node.textContent.trim(),
      );
    expect(visibleTitles()).toEqual(["Alpha two", "Beta one"]);
    expect(document.querySelector(".chat-migration-candidate-snippet")?.textContent).toBe(
      "A smaller, newer conversation",
    );
    expect(document.querySelector(".chat-migration-candidate-size")?.textContent).toContain("512");

    const sort = document.getElementById("chat-migration-sort");
    sort.value = "size-desc";
    sort.dispatchEvent(new Event("change", { bubbles: true }));
    expect(visibleTitles()).toEqual(["Beta one", "Alpha two"]);

    const archiveFilter = document.getElementById("chat-migration-archive-filter");
    archiveFilter.value = "archived";
    archiveFilter.dispatchEvent(new Event("change", { bubbles: true }));
    expect(visibleTitles()).toEqual(["Alpha one"]);

    archiveFilter.value = "active";
    const sourceFilter = document.getElementById("chat-migration-source-filter");
    sourceFilter.value = "cursor";
    sourceFilter.dispatchEvent(new Event("change", { bubbles: true }));
    expect(visibleTitles()).toEqual(["Beta one"]);
  });

  test("opens a read-only full-context window without selecting the chat", async () => {
    const transport = {
      scanLocalChats: vi.fn().mockResolvedValue(scan),
      openChatMigrationContext: vi.fn().mockResolvedValue(true),
      pickFolder: vi.fn(),
      importLocalChats: vi.fn(),
    };
    setupChatMigration({ transport });
    document.getElementById("chat-migration-scan").click();
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-chat-context]")).toHaveLength(2),
    );

    document.querySelector('[data-chat-context="chat-a2"]').click();

    await vi.waitFor(() =>
      expect(transport.openChatMigrationContext).toHaveBeenCalledWith("scan-1", "chat-a2"),
    );
    expect(document.querySelector('[data-chat-candidate="chat-a2"]').checked).toBe(false);
  });
});
