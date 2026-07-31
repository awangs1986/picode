import { beforeEach, describe, expect, test, vi } from "vitest";
import { createContextRecord, setupChatContextViewer } from "./chat-context-viewer.js";

function markup() {
  document.body.innerHTML = `
    <div id="context-source"></div>
    <h1 id="context-title"></h1>
    <div id="context-meta"></div>
    <div id="context-messages"></div>
    <div id="context-empty" hidden></div>
    <button id="context-load-more"></button>
    <div id="context-status"></div>`;
  window.history.replaceState({}, "", "/chat-context-viewer.html?scanId=scan-1&candidateId=chat-1");
}

describe("chat context viewer", () => {
  beforeEach(markup);

  test("renders imported text as text instead of executable markup", () => {
    const record = createContextRecord({
      kind: "message",
      role: "assistant",
      content: '<img src=x onerror="window.pwned=true">',
    });
    expect(record.querySelector("img")).toBeNull();
    expect(record.querySelector("pre").textContent).toContain("<img");
    expect(window.pwned).toBeUndefined();
  });

  test.each([
    ["reasoning", "assistant"],
    ["toolCall", "tool"],
    ["toolResult", "tool"],
    ["summary", "system"],
    ["system", "system"],
  ])("renders %s records collapsed until the user expands them", (kind, role) => {
    const record = createContextRecord({ kind, role, content: "Hidden auxiliary context" });

    expect(record.tagName).toBe("DETAILS");
    expect(record.open).toBe(false);
    expect(record.querySelector("summary")).not.toBeNull();
    expect(record.querySelector("pre").textContent).toBe("Hidden auxiliary context");
  });

  test("loads bounded pages, keeps source identity, and folds reasoning", async () => {
    const transport = {
      readChatMigrationContext: vi
        .fn()
        .mockResolvedValueOnce({
          candidate: {
            source: "cursor",
            title: "Large refactor",
            originalWorkspace: "D:\\game",
            updatedAt: "2026-07-30T08:00:00Z",
            fileSizeBytes: 4096,
          },
          records: [
            { kind: "message", role: "user", content: "Continue" },
            { kind: "reasoning", role: "assistant", content: "Inspect dependencies" },
          ],
          nextCursor: "page-2",
          complete: false,
        })
        .mockResolvedValueOnce({
          candidate: { source: "cursor", title: "Large refactor", fileSizeBytes: 4096 },
          records: [{ kind: "message", role: "assistant", content: "Finished" }],
          nextCursor: null,
          complete: true,
        }),
    };
    const viewer = setupChatContextViewer({ transport, env: window });
    await vi.waitFor(() => expect(transport.readChatMigrationContext).toHaveBeenCalledTimes(1));
    expect(document.getElementById("context-title").textContent).toBe("Large refactor");
    expect(document.getElementById("context-source").textContent).toBe("Cursor");
    expect(document.querySelectorAll(".context-record")).toHaveLength(2);

    const reasoning = document.querySelector('[data-context-category="reasoning"]');
    expect(reasoning.tagName).toBe("DETAILS");
    expect(reasoning.open).toBe(false);

    await viewer.loadNext();
    expect(transport.readChatMigrationContext).toHaveBeenLastCalledWith(
      "scan-1",
      "chat-1",
      "page-2",
    );
    expect(document.getElementById("context-load-more").hidden).toBe(true);
  });

  test("loads later conversation pages only when requested and keeps newest content first", async () => {
    const transport = {
      readChatMigrationContext: vi
        .fn()
        .mockResolvedValueOnce({
          candidate: { source: "codex", title: "Long chat", fileSizeBytes: 90 * 1024 * 1024 },
          records: [{ kind: "message", role: "user", content: "First page" }],
          nextCursor: "page-2",
          complete: false,
        })
        .mockResolvedValueOnce({
          candidate: { source: "codex", title: "Long chat", fileSizeBytes: 90 * 1024 * 1024 },
          records: [{ kind: "message", role: "assistant", content: "Second page" }],
          nextCursor: null,
          complete: true,
        }),
    };

    const viewer = setupChatContextViewer({ transport, env: window });

    await vi.waitFor(() => expect(transport.readChatMigrationContext).toHaveBeenCalledTimes(1));
    expect(document.querySelectorAll(".context-record")).toHaveLength(1);
    expect(document.getElementById("context-messages").textContent).toContain("First page");
    expect(document.getElementById("context-messages").textContent).not.toContain("Second page");
    expect(document.getElementById("context-load-more").hidden).toBe(false);

    await viewer.loadNext();

    expect(transport.readChatMigrationContext).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll(".context-record")).toHaveLength(2);
    expect(document.getElementById("context-messages").textContent).toContain("Second page");
    const records = [...document.querySelectorAll(".context-record")];
    expect(records[0].textContent).toContain("Second page");
    expect(records[1].textContent).toContain("First page");
    expect(document.getElementById("context-load-more").hidden).toBe(true);
  });
});
