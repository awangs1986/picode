import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiSessionLifecycle } from "../../src/engine/pi-session-lifecycle.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("PiSessionLifecycle", () => {
  it("creates a seeded Pi session that can be resolved and reopened", async () => {
    await withTempPicodeDir(async (root) => {
      const lifecycle = new PiSessionLifecycle(join(root, "agent", "sessions"));
      const created = lifecycle.createSeeded("C:/repo", (manager) => {
        manager.appendCustomEntry("picode.test", { value: 42 });
      });

      expect(created.sessionFile).toBeTypeOf("string");
      expect(existsSync(created.sessionFile as string)).toBe(true);

      const resolved = await lifecycle.resolve(created.sessionId);
      expect(resolved).toEqual(created);
      const reopened = await lifecycle.open(created.sessionId);
      expect(reopened.getEntries()).toEqual([
        expect.objectContaining({ type: "custom", customType: "picode.test", data: { value: 42 } }),
      ]);
    });
  });

  it("persists an already seeded session idempotently", async () => {
    await withTempPicodeDir(async (root) => {
      const lifecycle = new PiSessionLifecycle(join(root, "agent", "sessions"));
      const created = lifecycle.createSeeded("C:/repo");
      const manager = await lifecycle.open(created.sessionId);

      expect(lifecycle.persistSeed(manager)).toBe(created.sessionFile);
      expect(lifecycle.persistSeed(manager)).toBe(created.sessionFile);
    });
  });
});
