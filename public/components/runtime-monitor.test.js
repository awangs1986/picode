// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./runtime-monitor.js";

describe("picode-runtime-monitor", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        json: async () => ({
          success: true,
          data: {
            processId: 4700,
            memoryBytes: 33554432,
            shellSessions: 1,
            javascriptKernels: 1,
            pythonKernels: 0,
            tabs: 1,
            piSubagents: [
              {
                id: "async-1",
                processId: 4710,
                mode: "chain",
                agents: ["scout", "worker"],
                goal: "Inspect then implement",
                state: "running",
                startedAt: 1,
              },
            ],
          },
        }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders exact Agent Run identity, uncertainty labels, hierarchy, and controls", async () => {
    const transport = {
      taskSnapshot: vi.fn(async () => ({
        execution: { chats: [], tasks: [{ id: "task-a", goal: "Ship feature" }] },
        agentRuns: [
          {
            id: "run-main",
            taskId: "task-a",
            chatId: "chat-a",
            epochId: "epoch-a",
            provider: "codex",
            accountId: "account-a",
            model: "gpt-5",
            processId: 4200,
            state: "modelWait",
            currentAction: "provider response",
            startedAt: 10,
            lastProgressAt: 20,
            samples: [{ memoryBytes: 268435456, cpuPercent: 1.2, attribution: "shared" }],
            usage: {
              requests: { value: 1, attribution: "providerReported" },
              inputTokens: { value: 100, attribution: "providerReported" },
              outputTokens: { value: null, attribution: "unavailable" },
              costMicros: { value: null, attribution: "unavailable" },
            },
          },
          {
            id: "run-child",
            parentId: "run-main",
            taskId: "task-a",
            chatId: "chat-a",
            epochId: "epoch-a",
            provider: "deepseek",
            accountId: "account-d",
            model: "search",
            processId: 4300,
            state: "running",
            currentAction: "searching",
            startedAt: 11,
            lastProgressAt: 21,
            samples: [],
          },
        ],
        orchestration: {
          jobs: [
            {
              id: "job-build",
              taskId: "task-a",
              agentRunId: "run-main",
              processId: 4400,
              command: "cargo test",
              status: "running",
              liveTail: [98, 117, 105, 108, 100, 105, 110, 103],
              artifactPath: "D:/state/job-build.log",
              fullOutputHash: "abc",
            },
          ],
          routingDecisions: [
            {
              id: "route-a",
              parentRunId: "run-main",
              class: "repository-search",
              decision: { modelId: "search-model", reason: "qualified by evaluation" },
            },
          ],
        },
        extensions: {
          runs: [
            {
              id: "extension-a",
              extensionId: "review",
              taskId: "task-a",
              processId: 4500,
              state: "running",
              observedMemoryBytes: 1048576,
              fullOutputHash: "def",
            },
          ],
          mcpRuns: [
            { id: "mcp-a", ownerId: "memory", taskId: "task-a", processId: 4600, state: "running" },
          ],
          dapSessions: [],
        },
      })),
      cancelAgentRun: vi.fn(async () => {}),
      cancelBackgroundJob: vi.fn(async () => {}),
      cancelProfessionalExtension: vi.fn(async () => {}),
    };
    const Monitor = customElements.get("picode-runtime-monitor");
    const monitor = new Monitor();
    monitor.transport = transport;
    document.body.appendChild(monitor);
    await monitor.refresh();

    expect(monitor.querySelectorAll("[data-agent-run]")).toHaveLength(2);
    expect(monitor.textContent).toContain("run-main");
    expect(monitor.textContent).toContain("Shared");
    expect(monitor.textContent).toContain("Unavailable");
    expect(
      monitor.querySelector('[data-agent-run="run-child"]').getAttribute("data-parent-run"),
    ).toBe("run-main");
    expect(monitor.textContent).toContain("job-build");
    expect(monitor.textContent).toContain("search-model");
    expect(monitor.textContent).toContain("extension-a");
    expect(monitor.textContent).toContain("memory");
    expect(monitor.querySelectorAll('[data-pi-subagent="async-1"]')).toHaveLength(1);
    expect(monitor.textContent).toContain("Inspect then implement");
    expect(monitor.textContent).toContain("Manage with /subagents");
    expect(monitor.querySelectorAll("[data-tool-runtime]")).toHaveLength(3);
    expect(monitor.textContent).toContain("JavaScript Eval");
    monitor.querySelector('[data-cancel-extension="extension-a"]').click();
    await Promise.resolve();
    expect(transport.cancelProfessionalExtension).toHaveBeenCalledWith("extension-a");
    monitor.querySelector('[data-cancel-job="job-build"]').click();
    await Promise.resolve();
    expect(transport.cancelBackgroundJob).toHaveBeenCalledWith("job-build");
    monitor.querySelector('[data-cancel-run="run-child"]').click();
    await Promise.resolve();
    expect(transport.cancelAgentRun).toHaveBeenCalledWith("run-child");
  });
});
