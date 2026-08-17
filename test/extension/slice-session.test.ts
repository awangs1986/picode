import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRuntime } from "../../src/extension/index.ts";
import {
  SliceSessionCoordinator,
  TASK_CAPSULE_MESSAGE_TYPE,
  TASK_SLICE_LINEAGE_ENTRY_TYPE,
} from "../../src/extension/slice-session.ts";
import { err, ok } from "../../src/shared/types.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("automatic Slice continuation", () => {
  it("packages at a settled boundary and continues in a native parent-child Pi session", async () => {
    await withTempPicodeDir(async () => {
      const runtime = createRuntime();
      runtime.harness.switchTo("standard");
      const accepted = await runtime.taskIngress.accept({
        source: "pi-session",
        externalId: "parent-session",
        title: "Finish the migration",
        harnessTier: "standard",
        workspace: "C:/repo",
      });
      if (!accepted.ok) throw new Error(accepted.error.message);
      await runtime.taskIngress.setAutoSlice(accepted.value.taskId, true);

      const coordinator = new SliceSessionCoordinator(
        runtime,
        async () => ({ repo: "C:/repo", head: "abc123", contentDigest: "tree123" }),
        async () => ["src/migrate.ts"],
        async () => ok({
          decisions: [{ decision: "Keep the JSONL authority", rationale: "Pi owns the session" }],
          failedApproaches: ["A duplicate transcript store drifted"],
          nextSteps: ["Implement the migration adapter"],
          narrative: "Continue from the verified RED.",
        }),
      );
      const parentEntries: Array<[string, unknown]> = [];
      const childEntries: Array<[string, unknown]> = [];
      const sent: Array<{ message: unknown; options: unknown }> = [];
      const requestNewSession = vi.fn(async (options: {
        parentSession?: string;
        setup?: (manager: { appendCustomEntry(type: string, data: unknown): string }) => Promise<void>;
        withSession?: (ctx: unknown) => Promise<void>;
      }) => {
        await options.setup?.({
          appendCustomEntry(type, data) { childEntries.push([type, data]); return "child-entry"; },
        });
        await options.withSession?.({
          cwd: "C:/repo",
          sessionManager: {
            getSessionId: () => "child-session",
            persistSessionSeed: () => "C:/sessions/child.jsonl",
          },
          ui: { notify: vi.fn() },
          sendMessage: async (message: unknown, sendOptions: unknown) => {
            sent.push({ message, options: sendOptions });
          },
        });
        expect(options.parentSession).toBe("C:/sessions/parent.jsonl");
        return { cancelled: false };
      });
      const ctx = {
        cwd: "C:/repo",
        mode: "tui",
        model: { id: "gpt-5.6", provider: "openai", contextWindow: 1_000_000 },
        thinkingLevel: "high",
        sessionManager: {
          getSessionId: () => "parent-session",
          getSessionFile: () => "C:/sessions/parent.jsonl",
          getSessionName: () => "Finish the migration",
          getBranch: () => [],
          appendCustomEntry(type: string, data: unknown) { parentEntries.push([type, data]); },
        },
        ui: { notify: vi.fn(), confirm: vi.fn() },
        // Pi reports the already-compiled provider request, while the Governor
        // observed the larger append-only transcript before compilation.
        getContextUsage: () => ({ tokens: 260_000, contextWindow: 1_000_000, percent: 26 }),
        requestNewSession,
        compact: vi.fn(),
      } as unknown as ExtensionContext;

      await coordinator.onSessionStart(ctx);
      coordinator.observeContextPressure({
        tokens: 330_000,
        endpointContextWindow: 1_000_000,
        reliableContextCeiling: 400_000,
        percent: 82.5,
      });
      await coordinator.observeTurn(ctx);
      expect(requestNewSession).not.toHaveBeenCalled();
      await coordinator.onAgentEnd(ctx);

      expect(requestNewSession).toHaveBeenCalledOnce();
      expect(childEntries).toContainEqual([
        TASK_SLICE_LINEAGE_ENTRY_TYPE,
        expect.objectContaining({ rootSessionId: "parent-session", parentSessionId: "parent-session", sliceIndex: 1 }),
      ]);
      expect(childEntries).toContainEqual([
        TASK_CAPSULE_MESSAGE_TYPE,
        expect.objectContaining({ intent: "Implement the migration adapter", integrity: { workspaceIdentity: "verified", skippedChecks: [] } }),
      ]);
      expect(sent).toContainEqual(expect.objectContaining({ options: { triggerTurn: true } }));
    });
  });

  it("falls back to Pi compaction without replacing the session when current-model packing fails", async () => {
    await withTempPicodeDir(async () => {
      const runtime = createRuntime();
      runtime.harness.switchTo("standard");
      const accepted = await runtime.taskIngress.accept({
        source: "pi-session",
        externalId: "fallback-session",
        title: "Continue safely",
        harnessTier: "standard",
        workspace: "C:/repo",
      });
      if (!accepted.ok) throw new Error(accepted.error.message);
      await runtime.taskIngress.setAutoSlice(accepted.value.taskId, true);
      const coordinator = new SliceSessionCoordinator(
        runtime,
        async () => ({ repo: "C:/repo", head: "abc", contentDigest: "tree" }),
        async () => [],
        async () => err("test/packing-failed", "packing failed"),
      );
      const compact = vi.fn();
      const requestNewSession = vi.fn();
      const ctx = {
        cwd: "C:/repo",
        mode: "tui",
        model: { id: "gpt", provider: "openai", contextWindow: 1_000_000 },
        sessionManager: {
          getSessionId: () => "fallback-session",
          getSessionFile: () => "C:/sessions/fallback.jsonl",
          getSessionName: () => "Continue safely",
          getBranch: () => [],
        },
        ui: { notify: vi.fn(), confirm: vi.fn() },
        getContextUsage: () => ({ tokens: 600_000, contextWindow: 1_000_000, percent: 60 }),
        requestNewSession,
        compact,
      } as unknown as ExtensionContext;

      await coordinator.onSessionStart(ctx);
      await coordinator.observeTurn(ctx);
      await coordinator.onAgentEnd(ctx);
      expect(requestNewSession).not.toHaveBeenCalled();
      expect(compact).toHaveBeenCalledOnce();
    });
  });

  it("falls back before model packing when automatic Slice cannot verify workspace identity", async () => {
    await withTempPicodeDir(async () => {
      const runtime = createRuntime();
      runtime.harness.switchTo("standard");
      const accepted = await runtime.taskIngress.accept({
        source: "pi-session",
        externalId: "degraded-session",
        title: "Keep the handoff honest",
        harnessTier: "standard",
        workspace: "C:/not-a-git-worktree",
      });
      if (!accepted.ok) throw new Error(accepted.error.message);
      await runtime.taskIngress.setAutoSlice(accepted.value.taskId, true);
      const packSemantics = vi.fn(async () => ok({
        decisions: [],
        failedApproaches: [],
        nextSteps: ["Continue"],
        narrative: "",
      }));
      const coordinator = new SliceSessionCoordinator(
        runtime,
        async () => ({ repo: "C:/not-a-git-worktree" }),
        async () => [],
        packSemantics,
      );
      const compact = vi.fn();
      const requestNewSession = vi.fn();
      const ctx = {
        cwd: "C:/not-a-git-worktree",
        mode: "tui",
        model: { id: "gpt", provider: "openai", contextWindow: 1_000_000 },
        sessionManager: {
          getSessionId: () => "degraded-session",
          getSessionFile: () => "C:/sessions/degraded.jsonl",
          getSessionName: () => "Keep the handoff honest",
          getBranch: () => [],
        },
        ui: { notify: vi.fn(), confirm: vi.fn() },
        getContextUsage: () => ({ tokens: 600_000, contextWindow: 1_000_000, percent: 60 }),
        requestNewSession,
        compact,
      } as unknown as ExtensionContext;

      await coordinator.onSessionStart(ctx);
      await coordinator.observeTurn(ctx);
      await coordinator.onAgentEnd(ctx);

      expect(packSemantics).not.toHaveBeenCalled();
      expect(requestNewSession).not.toHaveBeenCalled();
      expect(compact).toHaveBeenCalledOnce();
    });
  });

  it("falls back when the settled child-session replacement races with a new active turn", async () => {
    await withTempPicodeDir(async () => {
      const runtime = createRuntime();
      runtime.harness.switchTo("standard");
      const accepted = await runtime.taskIngress.accept({
        source: "pi-session",
        externalId: "replacement-race",
        title: "Continue without getting stuck",
        harnessTier: "standard",
        workspace: "C:/repo",
      });
      if (!accepted.ok) throw new Error(accepted.error.message);
      await runtime.taskIngress.setAutoSlice(accepted.value.taskId, true);
      const coordinator = new SliceSessionCoordinator(
        runtime,
        async () => ({ repo: "C:/repo", head: "abc", contentDigest: "tree" }),
        async () => [],
        async () => ok({ decisions: [], failedApproaches: [], nextSteps: ["Continue"], narrative: "" }),
      );
      const compact = vi.fn();
      const ctx = {
        cwd: "C:/repo",
        mode: "tui",
        model: { id: "gpt", provider: "openai", contextWindow: 1_000_000 },
        sessionManager: {
          getSessionId: () => "replacement-race",
          getSessionFile: () => "C:/sessions/race.jsonl",
          getSessionName: () => "Continue without getting stuck",
          getBranch: () => [],
        },
        ui: { notify: vi.fn(), confirm: vi.fn() },
        getContextUsage: () => ({ tokens: 600_000, contextWindow: 1_000_000, percent: 60 }),
        requestNewSession: vi.fn(async () => { throw new Error("requestNewSession requires an idle boundary"); }),
        compact,
      } as unknown as ExtensionContext;

      await coordinator.onSessionStart(ctx);
      await coordinator.observeTurn(ctx);
      await expect(coordinator.onAgentEnd(ctx)).resolves.toBeUndefined();
      expect(compact).toHaveBeenCalledOnce();
    });
  });
});
