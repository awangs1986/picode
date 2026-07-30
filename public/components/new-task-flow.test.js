// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import "./new-task-flow.js";

function fakeTransport() {
  return {
    createSimpleTask: vi.fn(async () => ({ id: "simple-a", kind: "simple" })),
    pickFolder: vi.fn(async () => "D:\\game"),
    registerWorkspace: vi.fn(async () => ({ id: "workspace-a" })),
    createHarnessTask: vi.fn(async () => ({ id: "harness-a", kind: "harness" })),
  };
}

describe("picode-task-dialog", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("starts a Simple Task without project discovery or optional services", async () => {
    const Dialog = customElements.get("picode-task-dialog");
    const dialog = new Dialog();
    dialog.transport = fakeTransport();
    document.body.appendChild(dialog);
    dialog.open({ chatId: "chat-a" });
    dialog.querySelector('[data-kind="simple"]').click();
    dialog.querySelector("[data-goal]").value = "Discuss architecture";
    dialog
      .querySelector("form")
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(dialog.transport.createSimpleTask).toHaveBeenCalledWith(
      "chat-a",
      "Discuss architecture",
    );
    expect(dialog.transport.pickFolder).not.toHaveBeenCalled();
    expect(dialog.transport.registerWorkspace).not.toHaveBeenCalled();
  });

  it("creates a Simple Task when the optional goal is left blank", async () => {
    const Dialog = customElements.get("picode-task-dialog");
    const dialog = new Dialog();
    dialog.transport = fakeTransport();
    document.body.appendChild(dialog);
    dialog.open({ chatId: "chat-blank" });

    expect(dialog.querySelector("[data-goal]").required).toBe(false);
    dialog
      .querySelector("form")
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(dialog.transport.createSimpleTask).toHaveBeenCalledWith("chat-blank", "");
  });

  it("binds a chosen workspace before creating a Harness Task and supports Escape", async () => {
    const Dialog = customElements.get("picode-task-dialog");
    const dialog = new Dialog();
    dialog.transport = fakeTransport();
    document.body.appendChild(dialog);
    dialog.open({ chatId: "chat-b" });
    dialog.querySelector('[data-kind="harness"]').click();
    dialog.querySelector("[data-goal]").value = "Implement feature";
    dialog
      .querySelector("form")
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(dialog.transport.registerWorkspace).toHaveBeenCalledWith(
      expect.any(String),
      "D:\\game",
      "D:\\game",
    );
    expect(dialog.transport.createHarnessTask).toHaveBeenCalledWith(
      "chat-b",
      "Implement feature",
      "workspace-a",
    );

    dialog.open({ chatId: "chat-c" });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(dialog.hasAttribute("open")).toBe(false);
  });
});
