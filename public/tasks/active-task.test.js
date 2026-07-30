import { describe, expect, test } from "vitest";
import { activePromptContext, loadActiveTask, rememberActiveTask } from "./active-task.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

describe("active Picode task", () => {
  test("survives an in-window Pi session transition without losing durable identity", () => {
    const storage = memoryStorage();
    rememberActiveTask(storage, { id: "task-a", chatId: "pending-chat", kind: "simple" });

    expect(loadActiveTask(storage)).toEqual({
      id: "task-a",
      chatId: "pending-chat",
      kind: "simple",
    });
  });

  test("adds exact task, model, and Pi port identity to prompt preparation", () => {
    expect(
      activePromptContext(
        { id: "task-a", chatId: "pending-chat", kind: "harness" },
        47_821,
        "gpt-5",
      ),
    ).toEqual({ taskId: "task-a", sourcePort: 47_821, model: "gpt-5" });
    expect(activePromptContext(null, 47_821, "gpt-5")).toEqual({ sourcePort: 47_821 });
  });
});
