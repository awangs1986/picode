import { beforeEach, describe, expect, test, vi } from "vitest";
import { SessionSidebar } from "./index.js";

const session = {
  id: "chat-42",
  file: "chat-42.jsonl",
  filePath: "C:\\sessions\\chat-42.jsonl",
  name: "Context menu chat",
  timestamp: "2026-08-02T10:00:00.000Z",
};
const project = { dirName: "--work--picode", path: "C:\\work\\picode" };

function rightClick(element) {
  element.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 48,
      clientY: 72,
    }),
  );
}

function findMenuItem(label) {
  return Array.from(document.querySelectorAll(".context-menu-item")).find(
    (element) => element.textContent.trim() === label,
  );
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("session taskbar context menu", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="sessions"></div>';
    localStorage.clear();
    vi.restoreAllMocks();
  });

  test("opens from a session row with the complete action layout", () => {
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn());
    const item = sidebar.buildSessionItem(session, project);
    document.getElementById("sessions").appendChild(item);

    rightClick(item);

    const menu = document.querySelector(".session-context-menu");
    expect(menu).not.toBeNull();
    expect(menu.textContent).toContain("Pin");
    expect(menu.textContent).toContain("Rename");
    expect(menu.textContent).toContain("Mark as Unread");
    expect(menu.textContent).toContain("Copy");
    expect(menu.textContent).toContain("Fork");
    expect(menu.textContent).toContain("Archive");
    expect(menu.textContent).toContain("Remove");
    expect(menu.querySelector('[data-context-action="copy-id"]')?.textContent).toContain("Copy ID");
    expect(menu.querySelector('[data-context-action="copy-transcript"]')?.textContent).toContain(
      "Copy Transcript",
    );
  });

  test("pin and mark-as-unread update the selected chat, including the active chat", () => {
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn());
    sidebar.activeSessionFile = session.filePath;
    const item = sidebar.buildSessionItem(session, project);
    document.getElementById("sessions").appendChild(item);

    rightClick(item);
    findMenuItem("Pin").click();
    expect(sidebar.isFavourite(session.filePath)).toBe(true);

    const rerendered = sidebar.buildSessionItem(session, project);
    document.getElementById("sessions").replaceChildren(rerendered);
    rightClick(rerendered);
    findMenuItem("Mark as Unread").click();

    expect(sidebar.isUnread(session.filePath)).toBe(true);
  });

  test("remove requires two confirmations before deleting a non-archived chat", async () => {
    const deleteSessions = vi.fn(async () => ({ deleted: 1, errors: [] }));
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
      deleteSessions,
    });
    sidebar.showFallbackConfirmDialog = vi.fn().mockResolvedValue(true);
    sidebar.loadSessions = vi.fn(async () => []);
    const item = sidebar.buildSessionItem(session, project);
    document.getElementById("sessions").appendChild(item);

    rightClick(item);
    findMenuItem("Remove").click();
    await vi.waitFor(() => expect(deleteSessions).toHaveBeenCalledTimes(1));

    expect(sidebar.showFallbackConfirmDialog).toHaveBeenCalledTimes(2);
    expect(deleteSessions).toHaveBeenCalledWith([session.filePath]);
  });

  test("active chat removal creates a safe replacement only after both confirmations", async () => {
    const order = [];
    const prepareSessionRemoval = vi.fn(async () => order.push("prepare"));
    const deleteSessions = vi.fn(async () => {
      order.push("delete");
      return { deleted: 1, errors: [] };
    });
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
      deleteSessions,
      prepareSessionRemoval,
    });
    sidebar.activeSessionFile = session.filePath;
    sidebar.showFallbackConfirmDialog = vi.fn(async () => {
      order.push("confirm");
      return true;
    });
    sidebar.loadSessions = vi.fn(async () => []);
    const item = sidebar.buildSessionItem(session, project);
    document.getElementById("sessions").appendChild(item);

    rightClick(item);
    findMenuItem("Remove").click();
    await vi.waitFor(() => expect(deleteSessions).toHaveBeenCalledTimes(1));

    expect(order).toEqual(["confirm", "confirm", "prepare", "delete"]);
  });

  test("copy transcript includes conversation text but omits reasoning and tool logs", async () => {
    const copyText = vi.fn(async () => {});
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
      copyText,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        entries: [
          { type: "message", message: { role: "user", content: "Question" } },
          {
            type: "message",
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "private reasoning" },
                { type: "text", text: "Answer" },
                { type: "toolCall", name: "bash", arguments: { command: "secret" } },
              ],
            },
          },
          { type: "message", message: { role: "toolResult", content: "tool output" } },
        ],
      }),
    });
    const item = sidebar.buildSessionItem(session, project);
    document.getElementById("sessions").appendChild(item);

    rightClick(item);
    document.querySelector('[data-context-action="copy-transcript"]').click();
    await flush();

    expect(copyText).toHaveBeenCalledTimes(1);
    const transcript = copyText.mock.calls[0][0];
    expect(transcript).toContain("Question");
    expect(transcript).toContain("Answer");
    expect(transcript).not.toContain("private reasoning");
    expect(transcript).not.toContain("tool output");
    expect(transcript).not.toContain("secret");
  });

  test("fork delegates the complete selected chat instead of truncating at a user message", async () => {
    const onForkSession = vi.fn(async () => {});
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
      onForkSession,
    });
    const item = sidebar.buildSessionItem(session, project);
    document.getElementById("sessions").appendChild(item);

    rightClick(item);
    findMenuItem("Fork").click();
    await vi.waitFor(() => expect(onForkSession).toHaveBeenCalledTimes(1));

    expect(onForkSession).toHaveBeenCalledWith({ session, project });
  });
});
