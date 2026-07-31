import { describe, expect, test } from "vitest";
import { normalizeTaskToolInput } from "./subagent-runtime";

describe("Picode OMP-style task normalization", () => {
  test("supports mixed batch profiles with strict default envelopes", () => {
    const tasks = normalizeTaskToolInput({
      context: "Inspect the runtime change",
      tasks: [
        { name: "find", agent: "scout", task: "Find call sites" },
        { name: "verify", agent: "tester", task: "Run the focused tests" },
        { name: "fix", agent: "task", task: "Implement the bounded fix" },
      ],
    });
    expect(tasks).toHaveLength(3);
    expect(tasks[0].work).toMatchObject({
      class: "repository-search",
      requiresWrite: false,
    });
    expect(tasks[1].work.envelope.tools).toContain("execute");
    expect(tasks[2].work).toMatchObject({ class: "implementation", requiresWrite: true });
    expect(tasks[2].work.envelope.permissions).toContain("workspace.write");
  });

  test("rejects duplicate names and undeclared tools", () => {
    expect(() =>
      normalizeTaskToolInput({
        tasks: [
          { name: "same", task: "one" },
          { name: "SAME", task: "two" },
        ],
      }),
    ).toThrow("Duplicate Subagent name");
    expect(() => normalizeTaskToolInput({ task: "escape", tools: ["read", "browser"] })).toThrow(
      "unsupported tool",
    );
  });

  test("requires a separately authorized Safe Worktree for isolated writes", () => {
    expect(() =>
      normalizeTaskToolInput({ task: "write in isolation", agent: "task", isolated: true }),
    ).toThrow("Safe Worktree");
  });
});
