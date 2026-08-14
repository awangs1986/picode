import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../../src/store/index.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("Store", () => {
  it("does not expose a second account authority beside AccountsManager", () => {
    const store = new Store() as unknown as Record<string, unknown>;
    expect(store).not.toHaveProperty("listAccounts");
    expect(store).not.toHaveProperty("saveAccounts");
  });

  it("persists an immutable foreign transcript snapshot and compiled projection", async () => {
    await withTempPicodeDir(async () => {
      const store = new Store();
      const raw = JSON.stringify({ type: "message", role: "user", content: "continue" });
      const adapter = (await import("../../src/store/import-adapters.ts")).adapterFor("codex")!;
      const ir = adapter.parse(raw);
      expect(ir.ok).toBe(true);
      if (!ir.ok) return;
      const compiled = store.compileImport(ir.value);

      const saved = await store.persistImport("codex", raw, ir.value, compiled);

      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      expect(existsSync(join(saved.value.path, "source.jsonl"))).toBe(true);
      expect(readFileSync(join(saved.value.path, "source.jsonl"), "utf8")).toBe(raw);
      expect(JSON.parse(readFileSync(join(saved.value.path, "compiled.json"), "utf8"))).toEqual(compiled);
    });
  });
});
