import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { GrantStore } from "../../src/guard/grants.ts";
import { dataPaths } from "../../src/shared/paths.ts";
import type { Grant } from "../../src/shared/types.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

const patternGrant = (scope: Grant["scope"]): Grant => ({
  kind: "pattern",
  value: "npm test",
  scope,
});

describe("GrantStore", () => {
  describe("session scope", () => {
    it("keeps grants in memory, visible via all(), cleared by clearSession", async () => {
      await withTempPicodeDir(async (dir) => {
        const store = new GrantStore();
        const grant: Grant = { kind: "fingerprint", value: "abc123", scope: "session" };
        const added = await store.add(grant);
        expect(added.ok).toBe(true);
        expect(store.all()).toHaveLength(1);
        expect(store.all()[0]).toEqual(grant);

        store.clearSession();
        expect(store.all()).toHaveLength(0);
        expect(existsSync(dataPaths.grants())).toBe(false);
        expect(existsSync(join(dir, "grants.json"))).toBe(false);
      });
    });
  });

  describe("fingerprint persistence", () => {
    it("rejects fingerprint grants for project scope", async () => {
      await withTempPicodeDir(async () => {
        const store = new GrantStore("/tmp/project-grants.json");
        const r = await store.add({
          kind: "fingerprint",
          value: "fp1",
          scope: "project",
        });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe("guard/fingerprint-grant-not-persistable");
      });
    });

    it("rejects fingerprint grants for global scope", async () => {
      await withTempPicodeDir(async () => {
        const store = new GrantStore();
        const r = await store.add({
          kind: "fingerprint",
          value: "fp1",
          scope: "global",
        });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe("guard/fingerprint-grant-not-persistable");
      });
    });
  });

  describe("pattern + global persistence", () => {
    it("persists to global grants file and reloads in new instance", async () => {
      await withTempPicodeDir(async () => {
        const grant = patternGrant("global");
        const store = new GrantStore();
        const added = await store.add(grant);
        expect(added.ok).toBe(true);

        const path = dataPaths.grants();
        expect(existsSync(path)).toBe(true);
        const onDisk = JSON.parse(readFileSync(path, "utf8")) as { grants: Grant[] };
        expect(onDisk.grants).toHaveLength(1);
        expect(onDisk.grants[0]).toEqual(grant);

        const reloaded = new GrantStore();
        const load = reloaded.load();
        expect(load.ok).toBe(true);
        expect(reloaded.all()).toEqual([grant]);
      });
    });
  });

  describe("pattern + project persistence", () => {
    it("returns guard/no-project-grants-path without injected path", async () => {
      await withTempPicodeDir(async () => {
        const store = new GrantStore();
        const r = await store.add(patternGrant("project"));
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe("guard/no-project-grants-path");
      });
    });

    it("persists to injected project path", async () => {
      await withTempPicodeDir(async (dir) => {
        const projectPath = join(dir, "project", "grants.json");
        const grant = patternGrant("project");
        const store = new GrantStore(projectPath);
        const added = await store.add(grant);
        expect(added.ok).toBe(true);
        expect(existsSync(projectPath)).toBe(true);

        const reloaded = new GrantStore(projectPath);
        reloaded.load();
        expect(reloaded.all()).toEqual([grant]);
      });
    });
  });

  describe("load", () => {
    it("returns guard/grants-unreadable for corrupt file", async () => {
      await withTempPicodeDir(async () => {
        const path = dataPaths.grants();
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "{ broken", "utf8");
        const store = new GrantStore();
        const r = store.load();
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe("guard/grants-unreadable");
      });
    });
  });
});
