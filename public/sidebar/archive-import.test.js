import { describe, expect, test, vi } from "vitest";
import { SessionSidebar } from "./index.js";

describe("imported archive state", () => {
  test("adds imported archived sessions without removing existing archive entries", () => {
    localStorage.setItem("pi-studio-archived", JSON.stringify(["existing.jsonl"]));
    const sidebar = new SessionSidebar(document.createElement("div"), vi.fn(), vi.fn());
    sidebar.render = vi.fn();

    sidebar.archiveImportedSessions(["imported.jsonl", "existing.jsonl", "imported.jsonl"]);

    expect(sidebar.archived).toEqual(["existing.jsonl", "imported.jsonl"]);
    expect(JSON.parse(localStorage.getItem("pi-studio-archived"))).toEqual([
      "existing.jsonl",
      "imported.jsonl",
    ]);
    expect(sidebar.render).toHaveBeenCalledTimes(1);
  });
});
