import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PiActiveToolAdapter } from "../../src/extension/pi-tool-adapter.ts";
import { createRuntime } from "../../src/extension/index.ts";
import { GoogleSearchSubagentController } from "../../src/extension/google-search-subagent.ts";
import { GOOGLE_SEARCH_SUBAGENT_TOOL_NAME } from "../../src/extension/google-search-manifest.ts";
import { ok } from "../../src/shared/types.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";
import {
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
} from "pi-subagents/delegation";

interface FakePi {
  api: ExtensionAPI;
  active: Set<string>;
  tools: Map<string, any>;
  commands: Map<string, any>;
  events: Map<string, Set<(data: unknown) => void>>;
  emit(channel: string, data: unknown): void;
}

function fakePi(): FakePi {
  const active = new Set(["read", "web_search"]);
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const events = new Map<string, Set<(data: unknown) => void>>();
  const emit = (channel: string, data: unknown): void => {
    for (const handler of events.get(channel) ?? []) handler(data);
  };
  const api = {
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      active.clear();
      for (const name of names) active.add(name);
    },
    getAllTools: () => [
      { name: "web_search", description: "search", parameters: {}, sourceInfo: { kind: "extension" } },
      ...[...tools.values()].map((tool) => ({ ...tool, sourceInfo: { kind: "extension" } })),
    ],
    getCommands: () => [],
    events: {
      emit,
      on(channel: string, handler: (data: unknown) => void) {
        const handlers = events.get(channel) ?? new Set();
        handlers.add(handler);
        events.set(channel, handlers);
        return () => handlers.delete(handler);
      },
    },
  } as unknown as ExtensionAPI;
  return { api, active, tools, commands, events, emit };
}

function context(cwd: string): ExtensionContext {
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionId: () => "session-1" },
    ui: { notify: vi.fn(), select: vi.fn(), confirm: vi.fn(), input: vi.fn() },
    modelRegistry: { getAll: () => [{ provider: "google", id: "gemini-test", name: "Gemini Test" }] },
    isIdle: () => true,
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
}

async function configuredRuntime(pi: FakePi) {
  const adapter = new PiActiveToolAdapter(pi.api);
  const runtime = createRuntime({ toolAdapter: adapter });
  const imported = await runtime.accounts.importCredentials({
    stableId: "gemini",
    provider: "google",
    piProvider: "google",
    label: "Gemini API",
    credentials: { accessToken: "secret-not-for-output" },
  });
  if (!imported.ok) throw new Error(imported.error.message);
  runtime.config.googleSearchSubagent = {
    ...runtime.config.googleSearchSubagent,
    accountId: imported.value.id,
    model: "google/gemini-test",
  };
  return { runtime, adapter };
}

describe("GoogleSearchSubagentController", () => {
  it("registers no model-visible tool and performs no setup while Disabled", async () => {
    await withTempPicodeDir(async () => {
      const pi = fakePi();
      const { runtime, adapter } = await configuredRuntime(pi);
      const ensureDelegationAvailable = vi.fn(async () => ok(undefined));
      const backend = { ground: vi.fn() };
      const controller = new GoogleSearchSubagentController(pi.api, {
        runtime,
        toolAdapter: adapter,
        persistCapabilities: async () => ok(undefined),
        persistConfig: async () => ok(undefined),
        ensureDelegationAvailable,
        backend,
      });

      controller.register();
      await controller.syncSession(context("D:/repo"));
      await pi.commands.get("pico-webagent").handler("doctor", context("D:/repo"));

      expect(pi.active.has(GOOGLE_SEARCH_SUBAGENT_TOOL_NAME)).toBe(false);
      expect(pi.active.has("web_search")).toBe(true);
      expect(ensureDelegationAvailable).not.toHaveBeenCalled();
      expect(backend.ground).not.toHaveBeenCalled();
    });
  });

  it("runs deduplicated grounded searches through isolated structured researchers", async () => {
    await withTempPicodeDir(async (cwd) => {
      const pi = fakePi();
      const { runtime, adapter } = await configuredRuntime(pi);
      runtime.guard.catalog.userSetState("google-search-subagent", "trusted");
      const ground = vi.fn(async (request: { query: string }) => ({
        answer: `answer for ${request.query}`,
        sources: [{ title: "Official", url: "https://example.test/source", snippet: "fact" }],
        actualProvider: "google-gemini-api",
        queries: [request.query],
      }));
      const ids = ["plan", "request-a", "request-b"];
      const controller = new GoogleSearchSubagentController(pi.api, {
        runtime,
        toolAdapter: adapter,
        persistCapabilities: async () => ok(undefined),
        persistConfig: async () => ok(undefined),
        ensureDelegationAvailable: async () => ok(undefined),
        backend: { ground },
        id: () => ids.shift() ?? "extra",
        now: () => new Date("2026-08-19T00:00:00.000Z"),
      });
      controller.register();
      await controller.syncSession(context(cwd));
      pi.api.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (raw) => {
        const request = raw as { requestId: string; ownerRunId: string; nodeId: string; model: string; thinking: string; toolBudget: unknown };
        expect(request).toMatchObject({
          model: "google/gemini-test",
          thinking: "high",
          toolBudget: { hard: 0, block: "*" },
        });
        queueMicrotask(() => pi.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
          requestId: request.requestId,
          ownerRunId: request.ownerRunId,
          nodeId: request.nodeId,
          status: "completed",
          runId: `run-${request.requestId}`,
          model: request.model,
          result: {
            kind: "structured",
            value: {
              summary: "grounded summary",
              claims: [{ text: "fact", sourceUrls: ["https://example.test/source"] }],
              limitations: [],
            },
          },
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1, toolCalls: 0, durationMs: 20 },
        }));
      });

      const tool = pi.tools.get(GOOGLE_SEARCH_SUBAGENT_TOOL_NAME);
      const result = await tool.execute("tool-1", { briefs: [
        { id: "a", question: "same question" },
        { id: "b", question: " same   question " },
      ] }, undefined, undefined, context(cwd));

      expect(result.isError).not.toBe(true);
      expect(ground).toHaveBeenCalledTimes(1);
      expect(result.details.branches).toHaveLength(2);
      expect(pi.active.has("web_search")).toBe(false);
      expect(pi.active.has(GOOGLE_SEARCH_SUBAGENT_TOOL_NAME)).toBe(true);
      const artifact = join(cwd, ".pi-subagents", "artifacts", "google-search", "plan.json");
      expect(existsSync(artifact)).toBe(true);
      expect(readFileSync(artifact, "utf8")).not.toContain("secret-not-for-output");
    });
  });

  it("restores normal web search when the user disables the global capability", async () => {
    await withTempPicodeDir(async (cwd) => {
      const pi = fakePi();
      const { runtime, adapter } = await configuredRuntime(pi);
      const controller = new GoogleSearchSubagentController(pi.api, {
        runtime,
        toolAdapter: adapter,
        persistCapabilities: async () => ok(undefined),
        persistConfig: async () => ok(undefined),
        ensureDelegationAvailable: async () => ok(undefined),
        backend: { ground: vi.fn() },
      });
      controller.register();
      const command = pi.commands.get("pico-webagent");

      await command.handler("on", context(cwd));
      const enabledEpoch = runtime.cacheMeter.snapshot().cacheEpoch;
      expect(runtime.guard.catalog.get("google-search-subagent")?.setting).toBe("trusted");
      expect(pi.active.has(GOOGLE_SEARCH_SUBAGENT_TOOL_NAME)).toBe(true);
      expect(pi.active.has("web_search")).toBe(false);

      await command.handler("off", context(cwd));
      expect(runtime.guard.catalog.get("google-search-subagent")?.setting).toBe("disabled");
      expect(pi.active.has(GOOGLE_SEARCH_SUBAGENT_TOOL_NAME)).toBe(false);
      expect(pi.active.has("web_search")).toBe(true);
      expect(runtime.cacheMeter.snapshot().cacheEpoch).toBe(enabledEpoch + 1);
    });
  });

  it("cancels child work and writes no final artifact after the parent aborts", async () => {
    await withTempPicodeDir(async (cwd) => {
      const pi = fakePi();
      const { runtime, adapter } = await configuredRuntime(pi);
      runtime.guard.catalog.userSetState("google-search-subagent", "trusted");
      const abort = new AbortController();
      const cancelled: unknown[] = [];
      const controller = new GoogleSearchSubagentController(pi.api, {
        runtime,
        toolAdapter: adapter,
        persistCapabilities: async () => ok(undefined),
        persistConfig: async () => ok(undefined),
        ensureDelegationAvailable: async () => ok(undefined),
        backend: {
          ground: vi.fn(async () => ({
            answer: "answer",
            sources: [{ title: "Official", url: "https://example.test/source", snippet: "fact" }],
            actualProvider: "google-gemini-api",
            queries: ["question"],
          })),
        },
        id: (() => {
          const ids = ["cancel-plan", "cancel-request"];
          return () => ids.shift() ?? "extra";
        })(),
      });
      controller.register();
      await controller.syncSession(context(cwd));
      pi.api.events.on(SUBAGENT_DELEGATION_CANCEL_EVENT, (event) => cancelled.push(event));
      pi.api.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, () => queueMicrotask(() => abort.abort()));

      const tool = pi.tools.get(GOOGLE_SEARCH_SUBAGENT_TOOL_NAME);
      const result = await tool.execute(
        "tool-cancel",
        { briefs: [{ id: "cancel", question: "question" }] },
        abort.signal,
        undefined,
        context(cwd),
      );

      expect(result.isError).toBe(true);
      expect(cancelled).toHaveLength(1);
      expect(existsSync(join(cwd, ".pi-subagents", "artifacts", "google-search", "cancel-plan.json"))).toBe(false);
    });
  });
});
