import { describe, expect, it } from "vitest";
import {
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  SUBAGENT_DELEGATION_UPDATE_EVENT,
} from "pi-subagents/delegation";
import { createRuntime } from "../../src/extension/index.ts";
import { registerSubagentEnvelopeBridge } from "../../src/extension/subagent-envelope-bridge.ts";

describe("registerSubagentEnvelopeBridge", () => {
  it("fences an update that arrives after the same owner run became terminal", () => {
    const listeners = new Map<string, (value: unknown) => void>();
    const events = { on(name: string, handler: (value: unknown) => void) { listeners.set(name, handler); return () => {}; } };
    const runtime = createRuntime();
    const observed: string[] = [];
    runtime.bus.subscribe((event) => { observed.push(event.kind); });
    registerSubagentEnvelopeBridge(events, runtime);

    listeners.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.({
      requestId: "request-1",
      ownerRunId: "run-1",
      nodeId: "review",
      status: "completed",
      result: { kind: "text", text: "done" },
    });
    listeners.get(SUBAGENT_DELEGATION_UPDATE_EVENT)?.({
      requestId: "request-1",
      ownerRunId: "run-1",
      nodeId: "review",
      recentOutput: "late",
      toolCount: 9,
    });

    expect(observed).toEqual(["run.completed"]);
  });

  it("does not let one terminal child fence a sibling owned by the same parent run", () => {
    const listeners = new Map<string, (value: unknown) => void>();
    const events = { on(name: string, handler: (value: unknown) => void) { listeners.set(name, handler); return () => {}; } };
    const runtime = createRuntime();
    const observed: Array<{ kind: string; runId: string }> = [];
    runtime.bus.subscribe((event) => {
      const payload = event.payload as { identity?: { runId?: string } };
      observed.push({ kind: event.kind, runId: payload.identity?.runId ?? "missing" });
    });
    registerSubagentEnvelopeBridge(events, runtime);

    listeners.get(SUBAGENT_DELEGATION_RESPONSE_EVENT)?.({
      requestId: "request-a",
      ownerRunId: "parent-run",
      nodeId: "review-a",
      runId: "child-a",
      status: "completed",
      result: { kind: "text", text: "done" },
    });
    listeners.get(SUBAGENT_DELEGATION_UPDATE_EVENT)?.({
      requestId: "request-b",
      ownerRunId: "parent-run",
      nodeId: "review-b",
      runId: "child-b",
      recentOutput: "still running",
      toolCount: 1,
    });

    expect(observed).toEqual([
      { kind: "run.completed", runId: "child-a" },
      { kind: "subagent.update", runId: "child-b" },
    ]);
  });
});
