// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { TaskExperience } from "./task-experience.js";

function fakeTransport() {
  return {
    createSimpleTask: vi.fn(async () => ({ id: "simple-a", kind: "simple" })),
    pickFolder: vi.fn(async () => "D:\\game"),
    registerWorkspace: vi.fn(async () => ({ id: "workspace-a" })),
    createHarnessTask: vi.fn(async () => ({ id: "harness-a", kind: "harness" })),
  };
}

describe("TaskExperience", () => {
  it("keeps a conversation task free of workspace setup", async () => {
    const transport = fakeTransport();
    const experience = new TaskExperience(transport, { platform: "windows" });

    await experience.createTask({ chatId: "chat-a", goal: "  Discuss architecture  " });

    expect(transport.createSimpleTask).toHaveBeenCalledWith("chat-a", "Discuss architecture");
    expect(transport.pickFolder).not.toHaveBeenCalled();
  });

  it("hides workspace registration behind the project-task interface", async () => {
    const transport = fakeTransport();
    const experience = new TaskExperience(transport, { platform: "windows" });

    await experience.createTask({ chatId: "chat-b", goal: "Implement feature", mode: "project" });

    expect(transport.registerWorkspace).toHaveBeenCalledWith("windows", "D:\\game", "D:\\game");
    expect(transport.createHarnessTask).toHaveBeenCalledWith(
      "chat-b",
      "Implement feature",
      "workspace-a",
    );
  });

  it("returns no task when project selection is cancelled", async () => {
    const transport = fakeTransport();
    transport.pickFolder.mockResolvedValue(null);
    const experience = new TaskExperience(transport, { platform: "windows" });

    await expect(experience.createTask({ chatId: "chat-c", mode: "project" })).resolves.toBeNull();
    expect(transport.registerWorkspace).not.toHaveBeenCalled();
  });
});
