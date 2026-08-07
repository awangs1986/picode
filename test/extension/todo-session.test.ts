import { describe, expect, it } from "vitest";
import { Store } from "../../src/store/index.ts";
import { TodoSessionController } from "../../src/extension/todo-session.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("TodoSessionController", () => {
  it("persists one task authority and restores it in a fresh controller", async () => {
    await withTempPicodeDir(async () => {
      const first = new TodoSessionController(new Store());
      await first.bind("task-1");
      const written = await first.replace([
        { id: "design", content: "Review contract", status: "completed" },
        { id: "build", content: "Implement adapter", status: "in_progress" },
      ]);
      expect(written.ok).toBe(true);

      const restored = new TodoSessionController(new Store());
      await restored.bind("task-1");
      expect(restored.snapshot()).toEqual([
        { id: "design", content: "Review contract", status: "completed" },
        { id: "build", content: "Implement adapter", status: "in_progress" },
      ]);
    });
  });

  it("rejects ambiguous lists with multiple active items", async () => {
    await withTempPicodeDir(async () => {
      const todos = new TodoSessionController(new Store());
      await todos.bind("task-2");
      const result = await todos.replace([
        { id: "a", content: "A", status: "in_progress" },
        { id: "b", content: "B", status: "in_progress" },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("devloop/todo-multiple-active");
    });
  });
});
