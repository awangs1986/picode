import { describe, expect, it, vi } from "vitest";
import { canInject } from "../../src/devloop/task/capsule.ts";
import { applySubagentContextPolicy } from "../../src/extension/subagent-context-policy.ts";
import { ok } from "../../src/shared/types.ts";
import { sealedCapsule } from "../helpers/fixtures.ts";

describe("subagent context policy", () => {
  it("defaults direct delegations to fresh and appends the latest valid sealed Capsule", async () => {
    const capsule = sealedCapsule({
      taskId: "task-1",
      taskRevision: 3,
      intent: "Keep save migration lossless",
    });
    const input: Record<string, unknown> = { agent: "reviewer", task: "Review the migration" };
    const loadLatestSealedCapsule = vi.fn(async () => ok(capsule));

    const result = await applySubagentContextPolicy("subagent", input, {
      binding: { taskId: "task-1", taskRevision: 3 },
      loadLatestSealedCapsule,
      canInjectCapsule: canInject,
    });

    expect(result).toEqual({ applied: true, capsuleId: capsule.capsuleId });
    expect(input.context).toBe("fresh");
    expect(input.task).toContain("Review the migration");
    expect(input.task).toContain("<picode_task_capsule>");
    expect(input.task).toContain("Keep save migration lossless");
    expect(loadLatestSealedCapsule).toHaveBeenCalledWith("task-1");
  });

  it("honors an explicit fork without loading or injecting a Capsule", async () => {
    const input: Record<string, unknown> = { agent: "reviewer", task: "Review", context: "fork" };
    const loadLatestSealedCapsule = vi.fn(async () => ok(sealedCapsule()));

    expect(await applySubagentContextPolicy("subagent", input, {
      binding: { taskId: "task-1", taskRevision: 1 },
      loadLatestSealedCapsule,
      canInjectCapsule: canInject,
    })).toEqual({ applied: false });
    expect(input).toEqual({ agent: "reviewer", task: "Review", context: "fork" });
    expect(loadLatestSealedCapsule).not.toHaveBeenCalled();
  });

  it("does not change management actions or scripted workflows", async () => {
    for (const input of [
      { action: "list" },
      { workflowScript: "return await runs.run('review', {agent:'reviewer', task:'Review'})" },
    ] as Record<string, unknown>[]) {
      const original = structuredClone(input);
      expect(await applySubagentContextPolicy("subagent", input, {
        binding: { taskId: "task-1", taskRevision: 1 },
        loadLatestSealedCapsule: async () => ok(undefined),
        canInjectCapsule: canInject,
      })).toEqual({ applied: false });
      if ("workflowScript" in input) expect(input.context).toBe("fresh");
      else expect(input).toEqual(original);
    }
  });

  it("keeps the child fresh but refuses a Capsule bound to another revision", async () => {
    const input: Record<string, unknown> = { agent: "reviewer", task: "Review" };
    const result = await applySubagentContextPolicy("subagent", input, {
      binding: { taskId: "task-1", taskRevision: 2 },
      loadLatestSealedCapsule: async () => ok(sealedCapsule({ taskId: "task-1", taskRevision: 1 })),
      canInjectCapsule: canInject,
    });

    expect(input).toEqual({ agent: "reviewer", task: "Review", context: "fresh" });
    expect(result.applied).toBe(false);
    expect(result.warning).toContain("revision");
  });
});
