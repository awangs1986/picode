import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskIngress } from "../../../src/devloop/task/ingress.ts";
import { StateFile } from "../../../src/store/state-file.ts";
import { withTempPicodeDir } from "../../helpers/temp-dir.ts";

describe("TaskIngress.accept", () => {
  it("deduplicates a retried external input into one Devloop Task authority", async () => {
    await withTempPicodeDir(async (dir) => {
      const ingress = new TaskIngress({
        tasksRoot: join(dir, "tasks"),
        stateFile: (path, validate) => new StateFile(path, validate),
      });
      const input = {
        source: "telegram",
        externalId: "update-42",
        title: "Fix inventory sync",
        harnessTier: "standard" as const,
      };
      const first = await ingress.accept(input);
      const retry = await ingress.accept(input);
      expect(first.ok && retry.ok).toBe(true);
      if (!first.ok || !retry.ok) return;
      expect(retry.value.taskId).toBe(first.value.taskId);
      expect(retry.value.created).toBe(false);
      const restored = await ingress.read(first.value.taskId);
      expect(restored.ok && restored.value.title).toBe("Fix inventory sync");
      expect(restored.ok && restored.value.revision).toBe(1);
      expect(restored.ok && restored.value.autoSlice).toBe("unset");
    });
  });

  it("records a structured failure outcome and resets it for the next run", async () => {
    await withTempPicodeDir(async (dir) => {
      const ingress = new TaskIngress({
        tasksRoot: join(dir, "tasks"),
        stateFile: (path, validate) => new StateFile(path, validate),
      });
      const accepted = await ingress.accept({
        source: "pi-session",
        externalId: "failed-preflight-session",
        title: "Research with configured subagents",
        harnessTier: "standard",
      });
      expect(accepted.ok).toBe(true);
      if (!accepted.ok) return;

      const failed = await ingress.reportFailure(accepted.value.taskId, {
        outcome: "failed_preflight",
        summary: "Researcher thinking did not match the requested policy",
        evidenceRefs: ["config:subagents"],
      });
      expect(failed.ok).toBe(true);
      expect((await ingress.readControl(accepted.value.taskId))).toMatchObject({
        ok: true,
        value: {
          state: "failed",
          outcome: "failed_preflight",
          summary: "Researcher thinking did not match the requested policy",
          evidenceRefs: ["config:subagents"],
        },
      });

      await ingress.beginRun(accepted.value.taskId);
      expect((await ingress.readControl(accepted.value.taskId))).toMatchObject({
        ok: true,
        value: { state: "running" },
      });
      const running = await ingress.readControl(accepted.value.taskId);
      if (running.ok) {
        expect(running.value.outcome).toBeUndefined();
        expect(running.value.summary).toBeUndefined();
      }
    });
  });

  it("increments revision only for deterministic narrative changes and stores auto-Slice opt-in", async () => {
    await withTempPicodeDir(async (dir) => {
      const ingress = new TaskIngress({
        tasksRoot: join(dir, "tasks"),
        stateFile: (path, validate) => new StateFile(path, validate),
      });
      const accepted = await ingress.accept({
        source: "pi-session",
        externalId: "revision-session",
        title: "Old goal",
        harnessTier: "standard",
        workspace: "C:/repo",
      });
      if (!accepted.ok) throw new Error(accepted.error.message);
      const unchangedTier = await ingress.updateHarnessTier(accepted.value.taskId, "tdd");
      expect(unchangedTier.ok && unchangedTier.value.revision).toBe(1);
      const titled = await ingress.updateTitle(accepted.value.taskId, "New goal");
      expect(titled.ok && titled.value.revision).toBe(2);
      const acceptedCriteria = await ingress.updateAcceptance(accepted.value.taskId, ["gate A is green"]);
      expect(acceptedCriteria.ok && acceptedCriteria.value.revision).toBe(3);
      const rebound = await ingress.rebindWorkspace(accepted.value.taskId, "D:/repo");
      expect(rebound.ok && rebound.value.revision).toBe(4);
      const enabled = await ingress.setAutoSlice(accepted.value.taskId, true);
      expect(enabled.ok && enabled.value.autoSlice).toBe("enabled");
      expect(enabled.ok && enabled.value.revision).toBe(4);
    });
  });
});
