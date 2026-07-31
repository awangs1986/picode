import { beforeEach, describe, expect, test, vi } from "vitest";
import { SessionSidebar } from "./index.js";

describe("archived chat deletion", () => {
  let sidebar;
  let deleteSessions;
  const session = { filePath: "C:\\sessions\\chat.jsonl", name: "Important chat" };

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("pi-studio-archived", JSON.stringify([session.filePath]));
    deleteSessions = vi.fn(async (filePaths) => ({ deleted: filePaths.length, errors: [] }));
    sidebar = new SessionSidebar(document.createElement("div"), vi.fn(), vi.fn(), {
      deleteSessions,
    });
    sidebar.loadSessions = vi.fn(async () => []);
  });

  test("requires two positive confirmations before deleting one archived chat", async () => {
    sidebar.showFallbackConfirmDialog = vi.fn().mockResolvedValue(true);

    await sidebar.deleteArchivedSession(session);

    expect(sidebar.showFallbackConfirmDialog).toHaveBeenCalledTimes(2);
    expect(deleteSessions).toHaveBeenCalledTimes(1);
    expect(deleteSessions).toHaveBeenCalledWith([session.filePath]);
    expect(sidebar.archived).toEqual([]);
    expect(sidebar.loadSessions).toHaveBeenCalledTimes(1);
  });

  test("does not delete when the second confirmation is cancelled", async () => {
    sidebar.showFallbackConfirmDialog = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await sidebar.deleteArchivedSession(session);

    expect(sidebar.showFallbackConfirmDialog).toHaveBeenCalledTimes(2);
    expect(deleteSessions).not.toHaveBeenCalled();
    expect(sidebar.archived).toEqual([session.filePath]);
  });

  test("requires the same two confirmations before deleting all eligible archived chats", async () => {
    const secondPath = "C:\\sessions\\second.jsonl";
    sidebar.archived.push(secondPath);
    sidebar.showFallbackConfirmDialog = vi.fn().mockResolvedValue(true);

    await sidebar.deleteAllArchived();

    expect(sidebar.showFallbackConfirmDialog).toHaveBeenCalledTimes(2);
    expect(deleteSessions).toHaveBeenCalledWith([session.filePath, secondPath]);
  });

  test("refuses to delete an active or running archived chat", async () => {
    sidebar.showFallbackConfirmDialog = vi.fn().mockResolvedValue(true);
    sidebar.activeSessionFile = session.filePath;

    await sidebar.deleteArchivedSession(session);
    sidebar.activeSessionFile = null;
    sidebar.streamingFiles.add(session.filePath);
    await sidebar.deleteArchivedSession(session);

    expect(sidebar.showFallbackConfirmDialog).not.toHaveBeenCalled();
    expect(deleteSessions).not.toHaveBeenCalled();
  });

  test("keeps local archive metadata when native deletion fails", async () => {
    deleteSessions.mockResolvedValue({ deleted: 0, errors: [session.filePath] });
    sidebar.showFallbackConfirmDialog = vi.fn().mockResolvedValue(true);

    await sidebar.deleteArchivedSession(session);

    expect(sidebar.archived).toEqual([session.filePath]);
  });
});
