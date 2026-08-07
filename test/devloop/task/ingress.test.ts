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
    });
  });
});
