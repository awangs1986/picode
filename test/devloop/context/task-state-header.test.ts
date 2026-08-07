import { describe, expect, it } from "vitest";
import {
  renderTaskStateHeader,
  shouldRestateTaskState,
  taskStateDigest,
} from "../../../src/devloop/context/task-state-header.ts";

describe("Task State Header", () => {
  const state = {
    taskId: "task-1",
    revision: 2,
    mode: "tdd" as const,
    sliceId: "slice-3",
    goal: "Add deterministic combat replay",
    acceptance: ["same seed produces same result"],
    phase: "green",
    currentGate: "combat-replay",
    blockedBy: [],
    requiredContextRefs: ["docs/combat.md"],
  };

  it("renders a compact authority-labelled header", () => {
    expect(renderTaskStateHeader(state)).toContain('"taskId":"task-1"');
    expect(renderTaskStateHeader(state)).toContain("<picode_task_state>");
  });

  it("repeats after material change or 25000 tokens without rewriting history", () => {
    expect(shouldRestateTaskState({ current: state, tokensSinceLast: 0 })).toBe(true);
    const first = shouldRestateTaskState({ current: state, previousDigest: "wrong", tokensSinceLast: 0 });
    expect(first).toBe(true);
    const digest = taskStateDigest(state);
    expect(shouldRestateTaskState({ current: state, previousDigest: digest, tokensSinceLast: 24_999 })).toBe(false);
    expect(shouldRestateTaskState({ current: state, previousDigest: digest, tokensSinceLast: 25_000 })).toBe(true);
  });
});
