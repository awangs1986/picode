import { describe, expect, test } from "vitest";
import {
  buildConversationIdentityPrompt,
  buildImportedWorkflowPrompt,
  buildPiSubagentsPrompt,
  buildTaskCapabilityPrompt,
  type PiSubagentRuntimeRun,
  recordPiSubagentComplete,
  recordPiSubagentStarted,
  resolveConversationId,
  searchTaskCapabilities,
  selectPiSubagentTools,
  type TaskCapabilityContext,
} from "./embedded-server.ts";

const context: TaskCapabilityContext = {
  taskId: "task-a",
  taskKind: "harness",
  catalogEnabled: true,
  taskCapabilities: ["task-build"],
  toolsDeclarationState: "bound",
  compactPrompt: "Use lazy tools.",
};

describe("embedded Picode capability bridge", () => {
  test("current conversation identity is exact, read-only, and never confused with its file path", () => {
    expect(
      resolveConversationId(
        [{ type: "session", id: "conversation-123" }],
        "C:/Users/test/.pi/agent/sessions/other-name.jsonl",
      ),
    ).toBe("conversation-123");
    const prompt = buildConversationIdentityPrompt("conversation-123");
    expect(prompt).toContain('Current conversation ID: "conversation-123"');
    expect(prompt).toContain("return this exact value");
    expect(prompt).toContain("read-only runtime metadata");
  });

  test("search is deterministic, bounded, and unavailable before explicit enablement", () => {
    expect(searchTaskCapabilities({ ...context, catalogEnabled: false }, "rust", 5)).toEqual([]);
    expect(searchTaskCapabilities(context, "rust symbols", 2)).toEqual([
      expect.objectContaining({ id: "rust-lsp", activation: "onDemand" }),
    ]);
    expect(searchTaskCapabilities(context, "build verify", 1)).toEqual([
      expect.objectContaining({ id: "task-build", scope: "task" }),
    ]);
    expect(searchTaskCapabilities(context, "python kernel", 1)).toEqual([
      expect.objectContaining({ id: "persistent-eval", activation: "onDemand" }),
    ]);
    expect(searchTaskCapabilities(context, "browser smoke", 1)).toEqual([
      expect.objectContaining({ id: "browser-automation", activation: "onDemand" }),
    ]);
  });

  test("only an active task context contributes a compact system prompt", () => {
    expect(buildTaskCapabilityPrompt(null)).toBe("");
    expect(buildTaskCapabilityPrompt(context)).toContain("Use lazy tools.");
    expect(buildTaskCapabilityPrompt(context)).toContain("task-a");
  });

  test("explicit imported workflows are task-bound, bounded, and take workflow precedence", () => {
    const prompt = buildImportedWorkflowPrompt("task-a", [
      {
        id: "skill-tdd",
        taskId: "task-a",
        kind: "skill",
        version: "sha256:a",
        content: "Use red-green-refactor.",
      },
      {
        id: "other-task",
        taskId: "task-b",
        kind: "rule",
        version: "sha256:b",
        content: "Must not leak.",
      },
    ]);
    expect(prompt).toContain("Use red-green-refactor");
    expect(prompt).toContain("workflow takes precedence");
    expect(prompt).not.toContain("Must not leak");
  });

  test("pi-subagents is exposed only to Harness Tasks and explains its role beside Picode task", () => {
    const tools = ["read", "subagent", "subagent_wait"];
    expect(selectPiSubagentTools(tools, "simple")).toEqual([]);
    expect(selectPiSubagentTools(tools, "harness")).toEqual(["subagent", "subagent_wait"]);
    expect(selectPiSubagentTools(["read"], "harness")).toEqual([]);

    const prompt = buildPiSubagentsPrompt(tools, "harness");
    expect(prompt).toContain("pi-subagents");
    expect(prompt).toContain("chains");
    expect(prompt).toContain("Picode's task tool");
    expect(buildPiSubagentsPrompt(tools, "simple")).toBe("");
  });

  test("pi-subagents background lifecycle is reflected in the runtime snapshot", () => {
    const runs = new Map<string, PiSubagentRuntimeRun>();
    expect(
      recordPiSubagentStarted(
        runs,
        {
          id: "async-1",
          pid: 4512,
          sessionId: "session-a",
          mode: "chain",
          agents: ["scout", "worker"],
          goal: "Inspect then implement",
        },
        100,
      ),
    ).toEqual(
      expect.objectContaining({
        id: "async-1",
        processId: 4512,
        state: "running",
        agents: ["scout", "worker"],
        startedAt: 100,
      }),
    );

    expect(
      recordPiSubagentComplete(
        runs,
        { runId: "async-1", success: true, summary: "Implemented and verified" },
        250,
      ),
    ).toEqual(
      expect.objectContaining({
        id: "async-1",
        processId: 4512,
        state: "completed",
        endedAt: 250,
        summary: "Implemented and verified",
      }),
    );
  });
});
