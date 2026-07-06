import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionSidebar } from "./session-sidebar.js";

describe("SessionSidebar Super Agent pinned session", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="sessions"></div>';
    localStorage.clear();
  });

  it("renders latest Super Agent session before normal projects and selects it through the normal callback", () => {
    const onSessionSelect = vi.fn();
    const sidebar = new SessionSidebar(
      document.getElementById("sessions"),
      onSessionSelect,
      vi.fn(),
      {
        superAgentPath: "/Users/me/.pi/agent/super-agent",
      },
    );
    sidebar.projects = [
      {
        path: "/Users/me/project",
        dirName: "project",
        sessions: [{ filePath: "/project.jsonl", name: "Project chat", timestamp: "2026-06-02" }],
      },
      {
        path: "/Users/me/.pi/agent/super-agent",
        dirName: "super-agent",
        sessions: [
          { filePath: "/sa-old.jsonl", name: "Old", timestamp: "2026-06-01" },
          { filePath: "/sa-new.jsonl", name: "New", timestamp: "2026-06-03" },
        ],
      },
    ];

    sidebar.render();

    const firstSession = document.querySelector(".session-item");
    expect(firstSession?.dataset.filePath).toBe("/sa-new.jsonl");
    expect(firstSession?.textContent).toContain("Super Agent");

    firstSession?.click();

    expect(onSessionSelect).toHaveBeenCalledTimes(1);
    expect(onSessionSelect.mock.calls[0][0]).toMatchObject({
      filePath: "/sa-new.jsonl",
      kind: "super-agent",
      name: "Super Agent",
    });
    expect(onSessionSelect.mock.calls[0][1]).toMatchObject({
      path: "/Users/me/.pi/agent/super-agent",
      kind: "super-agent",
    });
  });

  it("does not duplicate the pinned Super Agent session in the regular project list", () => {
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
      superAgentPath: "/Users/me/.pi/agent/super-agent",
    });
    sidebar.projects = [
      {
        path: "/Users/me/.pi/agent/super-agent",
        dirName: "super-agent",
        sessions: [{ filePath: "/sa.jsonl", name: "Super Agent", timestamp: "2026-06-03" }],
      },
    ];

    sidebar.render();

    expect(document.querySelectorAll('.session-item[data-file-path="/sa.jsonl"]')).toHaveLength(1);
  });

  it("hides non-pinned Super Agent sessions from regular project groups", () => {
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
      superAgentPath: "/Users/me/.pi/agent/super-agent",
    });
    sidebar.projects = [
      {
        path: "/Users/me/.pi/agent/super-agent",
        dirName: "super-agent",
        sessions: [
          { filePath: "/sa-pinned.jsonl", name: "Pinned", timestamp: "2026-06-03" },
          { filePath: "/sa-other.jsonl", name: "Other", timestamp: "2026-06-02" },
        ],
      },
      {
        path: "/Users/me/project",
        dirName: "project",
        sessions: [{ filePath: "/project.jsonl", name: "Project", timestamp: "2026-06-01" }],
      },
    ];

    sidebar.render();

    expect(
      document.querySelector('.session-item[data-file-path="/sa-pinned.jsonl"]'),
    ).not.toBeNull();
    expect(document.querySelector('.session-item[data-file-path="/sa-other.jsonl"]')).toBeNull();
    expect(document.querySelector('.session-item[data-file-path="/project.jsonl"]')).not.toBeNull();
  });
});
