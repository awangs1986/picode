import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AccountsManager, type OAuthFlow } from "../../src/store/accounts.ts";
import { dataPaths } from "../../src/shared/paths.ts";
import { err, ok } from "../../src/shared/types.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

function fakeOAuth(
  provider: string,
  result: Awaited<ReturnType<OAuthFlow["login"]>> | (() => Awaited<ReturnType<OAuthFlow["login"]>>),
): OAuthFlow {
  return {
    provider,
    login:
      typeof result === "function"
        ? async () => result()
        : async () => result,
  };
}

describe("AccountsManager", () => {
  it("addFromOAuth stores account as stored and returns ref without credentials", async () => {
    await withTempPicodeDir(async () => {
      const onActiveChanged = vi.fn();
      const mgr = new AccountsManager(onActiveChanged);
      const flow = fakeOAuth("github", ok({
        label: "Work",
        credentials: { accessToken: "secret-token" },
      }));
      const r = await mgr.addFromOAuth(flow);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toMatchObject({
        provider: "github",
        label: "Work",
        status: "stored",
      });
      expect(r.value).not.toHaveProperty("credentials");
      expect(onActiveChanged).not.toHaveBeenCalled();
    });
  });

  it("addFromOAuth passthrough login failure", async () => {
    await withTempPicodeDir(async () => {
      const mgr = new AccountsManager(() => {});
      const flow = fakeOAuth(
        "github",
        err("oauth/denied", "user cancelled"),
      );
      const r = await mgr.addFromOAuth(flow);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("oauth/denied");
    });
  });

  it("list excludes credentials from projection", async () => {
    await withTempPicodeDir(async () => {
      const mgr = new AccountsManager(() => {});
      await mgr.addFromOAuth(
        fakeOAuth("github", ok({ label: "A", credentials: { accessToken: "t1" } })),
      );
      const list = mgr.list();
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect(list.value).toHaveLength(1);
      expect(list.value[0]).not.toHaveProperty("credentials");
    });
  });

  describe("setActive", () => {
    it("returns store/account-unknown for missing id", async () => {
      await withTempPicodeDir(async () => {
        const mgr = new AccountsManager(() => {});
        const r = await mgr.setActive("missing:id");
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe("store/account-unknown");
      });
    });

    it("returns store/account-retired for retired account", async () => {
      await withTempPicodeDir(async () => {
        const path = dataPaths.accounts();
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
          path,
          JSON.stringify({
            version: 1,
            accounts: [
              {
                id: "github:retired1",
                provider: "github",
                label: "Old",
                status: "retired",
              },
            ],
          }),
          "utf8",
        );
        const mgr = new AccountsManager(() => {});
        const r = await mgr.setActive("github:retired1");
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe("store/account-retired");
      });
    });

    it("demotes prior active on same provider and keeps single-active invariant", async () => {
      await withTempPicodeDir(async () => {
        const now = vi.spyOn(Date, "now").mockReturnValue(1_786_000_000_000);
        const mgr = new AccountsManager(() => {});
        const a = await mgr.addFromOAuth(
          fakeOAuth("github", ok({ label: "A", credentials: { accessToken: "a" } })),
        );
        const b = await mgr.addFromOAuth(
          fakeOAuth("github", ok({ label: "B", credentials: { accessToken: "b" } })),
        );
        expect(a.ok && b.ok).toBe(true);
        if (!a.ok || !b.ok) return;

        await mgr.setActive(a.value.id);
        await mgr.setActive(b.value.id);

        const list = mgr.list();
        expect(list.ok).toBe(true);
        if (!list.ok) return;
        const byId = Object.fromEntries(list.value.map((x) => [x.id, x.status]));
        expect(byId[a.value.id]).toBe("stored");
        expect(byId[b.value.id]).toBe("active");
        now.mockRestore();
      });
    });

    it("does not demote active accounts on other providers", async () => {
      await withTempPicodeDir(async () => {
        const mgr = new AccountsManager(() => {});
        const gh = await mgr.addFromOAuth(
          fakeOAuth("github", ok({ label: "GH", credentials: { accessToken: "g" } })),
        );
        const gl = await mgr.addFromOAuth(
          fakeOAuth("gitlab", ok({ label: "GL", credentials: { accessToken: "l" } })),
        );
        expect(gh.ok && gl.ok).toBe(true);
        if (!gh.ok || !gl.ok) return;

        await mgr.setActive(gh.value.id);
        await mgr.setActive(gl.value.id);

        const list = mgr.list();
        expect(list.ok).toBe(true);
        if (!list.ok) return;
        const ghRow = list.value.find((x) => x.id === gh.value.id);
        const glRow = list.value.find((x) => x.id === gl.value.id);
        expect(ghRow?.status).toBe("active");
        expect(glRow?.status).toBe("active");
      });
    });

    it("fires onActiveChanged once with provider and id on success", async () => {
      await withTempPicodeDir(async () => {
        const onActiveChanged = vi.fn();
        const mgr = new AccountsManager(onActiveChanged);
        const added = await mgr.addFromOAuth(
          fakeOAuth("github", ok({ label: "X", credentials: { accessToken: "x" } })),
        );
        expect(added.ok).toBe(true);
        if (!added.ok) return;

        onActiveChanged.mockClear();
        const r = await mgr.setActive(added.value.id);
        expect(r.ok).toBe(true);
        expect(onActiveChanged).toHaveBeenCalledTimes(1);
        expect(onActiveChanged).toHaveBeenCalledWith("github", added.value.id);
      });
    });
  });

  describe("relabel", () => {
    it("returns error for unknown id", async () => {
      await withTempPicodeDir(async () => {
        const mgr = new AccountsManager(() => {});
        const r = await mgr.relabel("nope", "label");
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe("store/account-unknown");
      });
    });

    it("updates label visible in list", async () => {
      await withTempPicodeDir(async () => {
        const mgr = new AccountsManager(() => {});
        const added = await mgr.addFromOAuth(
          fakeOAuth("github", ok({ label: "Old", credentials: { accessToken: "t" } })),
        );
        expect(added.ok).toBe(true);
        if (!added.ok) return;

        const relabeled = await mgr.relabel(added.value.id, "New Label");
        expect(relabeled.ok).toBe(true);
        const list = mgr.list();
        expect(list.ok).toBe(true);
        if (!list.ok) return;
        expect(list.value[0]?.label).toBe("New Label");
      });
    });
  });

  describe("activeCredentials", () => {
    it("returns store/no-active-account when none active", async () => {
      await withTempPicodeDir(async () => {
        const mgr = new AccountsManager(() => {});
        await mgr.addFromOAuth(
          fakeOAuth("github", ok({ label: "A", credentials: { accessToken: "t" } })),
        );
        const r = mgr.activeCredentials("github");
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe("store/no-active-account");
      });
    });

    it("returns credentials for active account", async () => {
      await withTempPicodeDir(async () => {
        const mgr = new AccountsManager(() => {});
        const added = await mgr.addFromOAuth(
          fakeOAuth("github", ok({
            label: "A",
            credentials: { accessToken: "tok-123", refreshToken: "ref" },
          })),
        );
        expect(added.ok).toBe(true);
        if (!added.ok) return;
        await mgr.setActive(added.value.id);

        const r = mgr.activeCredentials("github");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.accessToken).toBe("tok-123");
        expect(r.value.refreshToken).toBe("ref");
      });
    });
  });

  describe("modifyActiveCredentials", () => {
    it("atomically replaces the active credential without exposing it in account projections", async () => {
      await withTempPicodeDir(async () => {
        const mgr = new AccountsManager(() => {});
        const added = await mgr.importCredentials({
          provider: "openai-codex",
          label: "Codex",
          credentials: {
            accessToken: "expired-access",
            refreshToken: "old-refresh",
            expiresAt: 10,
          },
        });
        expect(added.ok).toBe(true);
        if (!added.ok) return;
        await mgr.setActive(added.value.id);

        const modified = await mgr.modifyActiveCredentials("openai-codex", async (current) => ({
          ...current,
          accessToken: "fresh-access",
          refreshToken: "new-refresh",
          expiresAt: 20,
        }));

        expect(modified.ok && modified.value.accessToken).toBe("fresh-access");
        expect(mgr.activeCredentials("openai-codex")).toEqual({
          ok: true,
          value: {
            accessToken: "fresh-access",
            refreshToken: "new-refresh",
            expiresAt: 20,
          },
        });
        expect(JSON.stringify(mgr.list())).not.toContain("fresh-access");
      });
    });

    it("leaves the stored credential unchanged when refresh fails", async () => {
      await withTempPicodeDir(async () => {
        const mgr = new AccountsManager(() => {});
        const added = await mgr.importCredentials({
          provider: "openai-codex",
          label: "Codex",
          credentials: { accessToken: "old", refreshToken: "refresh", expiresAt: 10 },
        });
        if (!added.ok) return;
        await mgr.setActive(added.value.id);

        const modified = await mgr.modifyActiveCredentials("openai-codex", async () => {
          throw new Error("network down");
        });

        expect(modified.ok).toBe(false);
        expect(mgr.activeCredentials("openai-codex")).toMatchObject({
          ok: true,
          value: { accessToken: "old" },
        });
      });
    });
  });
});
