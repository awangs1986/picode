// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./super-agent-runtime.js";

describe("super-agent-runtime", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation((url, options) => {
      if (url === "/api/super-agent/tasks" && options?.method === "PUT") {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({
        ok: true,
        text: async () =>
          JSON.stringify({
            tasks: [
              {
                id: "task-1",
                status: "pending",
                title: "Feature: Agent Status Indicator",
                description:
                  "Add a real-time agent status indicator with many implementation notes.",
                targetProject: "/Users/me/project",
              },
            ],
          }),
      });
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("keeps task details collapsed until the card is opened", async () => {
    const Runtime = customElements.get("super-agent-runtime");
    const runtime = new Runtime();
    document.body.appendChild(runtime);

    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.textContent).toContain("Feature: Agent Status Indicator");
    expect(runtime.textContent).not.toContain("many implementation notes");
    expect(runtime.querySelector('[data-action="approve"]')).toBeNull();

    runtime.querySelector(".runtime-task-card").click();

    expect(runtime.textContent).toContain("many implementation notes");
    expect(runtime.querySelector('[data-action="approve"]')).not.toBeNull();
    expect(runtime.querySelector(".runtime-project-select")).toBeNull();
  });

  it("uses the shared side-panel resize handle and close button", async () => {
    const Runtime = customElements.get("super-agent-runtime");
    const runtime = new Runtime();
    document.body.appendChild(runtime);

    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.querySelector(".app-side-panel-resize-handle")).not.toBeNull();
    expect(
      runtime.querySelector('[data-collapse-btn][aria-label="Close runtime panel"]'),
    ).not.toBeNull();
  });

  it("starts collapsed by default unless the user explicitly left it open", () => {
    const Runtime = customElements.get("super-agent-runtime");
    const runtime = new Runtime();
    document.body.appendChild(runtime);

    expect(runtime.classList.contains("collapsed")).toBe(true);

    document.body.innerHTML = "";
    localStorage.setItem("sa-runtime-collapsed", "0");
    const reopenedRuntime = new Runtime();
    document.body.appendChild(reopenedRuntime);

    expect(reopenedRuntime.classList.contains("collapsed")).toBe(false);
  });

  it("shows the task panel body immediately while the first task fetch is pending", () => {
    fetch.mockImplementation(() => new Promise(() => {}));

    const Runtime = customElements.get("super-agent-runtime");
    const runtime = new Runtime();
    document.body.appendChild(runtime);

    expect(runtime.querySelector("[data-task-list]").textContent).toContain("Connecting");
    expect(runtime.querySelector("[data-pending-count]").textContent).toBe("0");
  });

  it("formats markdown-like task descriptions into readable sections", async () => {
    fetch.mockImplementation((url, options) => {
      if (url === "/api/super-agent/tasks" && options?.method === "PUT") {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({
        ok: true,
        text: async () =>
          JSON.stringify({
            tasks: [
              {
                id: "task-1",
                status: "pending",
                title: "Feature: Agent Status Indicator",
                description:
                  "Add a real-time agent status indicator. ## Status States - 🟢 **Idle** — Pi is waiting for input - 🟡 **Working** — Pi is actively processing ## Goal Users should not switch panes. ## Implementation Hints 1. Detect state changes 2. Show the status dot",
                targetProject: "/Users/me/project",
              },
            ],
          }),
      });
    });

    const Runtime = customElements.get("super-agent-runtime");
    const runtime = new Runtime();
    document.body.appendChild(runtime);

    await Promise.resolve();
    await Promise.resolve();

    runtime.querySelector(".runtime-task-card").click();

    expect(runtime.querySelectorAll(".runtime-task-section-title")).toHaveLength(3);
    expect(runtime.querySelector(".runtime-task-desc").textContent).not.toContain("##");
    expect(runtime.querySelector(".runtime-task-desc").textContent).not.toContain("**Idle**");
    expect(
      [...runtime.querySelectorAll(".runtime-task-list-item")].map((item) => item.textContent),
    ).toEqual([
      "🟢 Idle — Pi is waiting for input",
      "🟡 Working — Pi is actively processing",
      "Detect state changes",
      "Show the status dot",
    ]);
  });

  it("approves with the project chosen at task creation", async () => {
    const Runtime = customElements.get("super-agent-runtime");
    const runtime = new Runtime();
    document.body.appendChild(runtime);

    await Promise.resolve();
    await Promise.resolve();

    runtime.querySelector(".runtime-task-card").click();

    expect(runtime.querySelector(".runtime-project-select")).toBeNull();
    expect(runtime.querySelector(".runtime-task-target").textContent).toContain("project");

    runtime.querySelector('[data-action="approve"]').click();

    await Promise.resolve();

    expect(fetch).toHaveBeenCalledWith(
      "/api/super-agent/tasks",
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining('"targetProject":"/Users/me/project"'),
      }),
    );
  });

  it("does not allow approval when a task was created without a project", async () => {
    fetch.mockImplementation((url, options) => {
      if (url === "/api/super-agent/tasks" && options?.method === "PUT") {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({
        ok: true,
        text: async () =>
          JSON.stringify({
            tasks: [
              {
                id: "task-1",
                status: "pending",
                title: "Missing target",
                description: "Needs a project.",
              },
            ],
          }),
      });
    });

    const Runtime = customElements.get("super-agent-runtime");
    const runtime = new Runtime();
    document.body.appendChild(runtime);

    await Promise.resolve();
    await Promise.resolve();

    runtime.querySelector(".runtime-task-card").click();

    expect(runtime.querySelector('[data-action="approve"]')).toBeNull();
    expect(runtime.querySelector(".runtime-project-select")).toBeNull();
    expect(runtime.textContent).toContain("Choose a project when creating this task");

    expect(fetch).not.toHaveBeenCalledWith(
      "/api/super-agent/tasks",
      expect.objectContaining({
        method: "PUT",
      }),
    );
  });
});
