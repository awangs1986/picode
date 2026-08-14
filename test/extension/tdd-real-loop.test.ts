import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ShellGateExecutor } from "../../src/extension/gate-command-executor.ts";
import { TddSessionController } from "../../src/devloop/index.ts";

describe("real TDD gate loop", () => {
  it("records a real Vitest RED before the same gate may issue completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "picode-real-tdd-"));
    try {
      const testFile = join(dir, "feature.test.ts");
      const vitest = resolve("node_modules/vitest/vitest.mjs");
      const command = `"${process.execPath}" "${vitest}" run feature.test.ts`;
      const contract = { gateId: "feature", command, timeoutMs: 30_000 };
      const controller = new TddSessionController(new ShellGateExecutor(dir));
      writeFileSync(
        testFile,
        'import { expect, it } from "vitest"; it("feature", () => expect(1).toBe(2));\n',
        "utf8",
      );

      expect(controller.begin().ok).toBe(true);
      const red = await controller.proveRed(contract);
      expect(red.ok).toBe(true);
      expect(controller.state()).toBe("green");

      writeFileSync(
        testFile,
        'import { expect, it } from "vitest"; it("feature", () => expect(2).toBe(2));\n',
        "utf8",
      );
      const snapshot = {
        repo: dir,
        dirty: true,
        contentDigest: "real-green-candidate",
      };
      const completed = await controller.runGate(contract, snapshot, {
        review: async () => ({ ok: true, value: { kind: "evidence", id: "real-review" } }),
        integrationContract: contract,
        snapshotNow: async () => snapshot,
      });

      expect(completed.ok).toBe(true);
      if (completed.ok) expect(completed.value.gatesPassed).toEqual(["feature"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
