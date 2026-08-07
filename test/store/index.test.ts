import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../../src/store/index.ts";
import type { AccountRef } from "../../src/shared/types.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

const account = (overrides: Partial<AccountRef> = {}): AccountRef => ({
  id: "acc-1",
  provider: "anthropic",
  label: "Main",
  status: "stored",
  ...overrides,
});

describe("Store", () => {
  it("round-trips saveAccounts and listAccounts", async () => {
    await withTempPicodeDir(async () => {
      const store = new Store();
      const accounts = [account({ status: "active" }), account({ id: "acc-2", provider: "openai" })];
      expect((await store.saveAccounts(accounts)).ok).toBe(true);
      const listed = await store.listAccounts();
      expect(listed.ok).toBe(true);
      if (listed.ok) expect(listed.value).toEqual(accounts);
    });
  });

  it("rejects multiple active accounts for the same provider", async () => {
    await withTempPicodeDir(async () => {
      const store = new Store();
      const accounts = [
        account({ id: "a1", status: "active" }),
        account({ id: "a2", status: "active" }),
      ];
      const r = await store.saveAccounts(accounts);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("store/multiple-active-accounts");
    });
  });

  it("returns empty list when accounts file is missing", async () => {
    await withTempPicodeDir(async () => {
      const store = new Store();
      const r = await store.listAccounts();
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual([]);
    });
  });

  it("returns accounts-unreadable for corrupted JSON", async () => {
    await withTempPicodeDir(async (dir) => {
      writeFileSync(join(dir, "accounts.json"), "{ not valid json", "utf8");
      const store = new Store();
      const r = await store.listAccounts();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("store/accounts-unreadable");
    });
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
