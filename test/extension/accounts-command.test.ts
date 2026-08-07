import { describe, expect, it } from "vitest";
import { handleAccountsCommand } from "../../src/extension/accounts-command.ts";
import { AccountsManager, type OAuthFlow } from "../../src/store/accounts.ts";
import { ok } from "../../src/shared/types.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

function fakeOAuth(provider: string, label: string): OAuthFlow {
  return {
    provider,
    login: async () =>
      ok({ label, credentials: { accessToken: `${provider}-token` } }),
  };
}

describe("handleAccountsCommand", () => {
  it("list prompts login when no accounts", async () => {
    await withTempPicodeDir(async () => {
      const mgr = new AccountsManager(() => {});
      const out = await handleAccountsCommand(mgr, ["list"]);
      expect(out).toContain("no accounts");
      expect(out).toContain("login");
    });
  });

  it("list marks active account with *", async () => {
    await withTempPicodeDir(async () => {
      const mgr = new AccountsManager(() => {});
      const added = await mgr.addFromOAuth(fakeOAuth("github", "Work"));
      expect(added.ok).toBe(true);
      if (!added.ok) return;
      await mgr.setActive(added.value.id);

      const out = await handleAccountsCommand(mgr, ["list"]);
      expect(out).toMatch(/^\* /m);
      expect(out).toContain(added.value.id);
      expect(out).toContain("active");
    });
  });

  it("use without id returns usage", async () => {
    await withTempPicodeDir(async () => {
      const mgr = new AccountsManager(() => {});
      const out = await handleAccountsCommand(mgr, ["use"]);
      expect(out).toBe("usage: /accounts use <account-id>");
    });
  });

  it("use success mentions new execution epoch", async () => {
    await withTempPicodeDir(async () => {
      const mgr = new AccountsManager(() => {});
      const added = await mgr.addFromOAuth(fakeOAuth("github", "Work"));
      expect(added.ok).toBe(true);
      if (!added.ok) return;

      const out = await handleAccountsCommand(mgr, ["use", added.value.id]);
      expect(out).toContain("new execution epoch");
    });
  });

  it("label without enough args returns usage", async () => {
    await withTempPicodeDir(async () => {
      const mgr = new AccountsManager(() => {});
      const out = await handleAccountsCommand(mgr, ["label"]);
      expect(out).toBe("usage: /accounts label <account-id> <label>");
    });
  });

  it("label success returns confirmation", async () => {
    await withTempPicodeDir(async () => {
      const mgr = new AccountsManager(() => {});
      const added = await mgr.addFromOAuth(fakeOAuth("github", "Old"));
      expect(added.ok).toBe(true);
      if (!added.ok) return;

      const out = await handleAccountsCommand(mgr, [
        "label",
        added.value.id,
        "New",
        "Name",
      ]);
      expect(out).toBe(`labeled ${added.value.id}: New Name`);
    });
  });

  it("unknown verb returns error listing known verbs", async () => {
    await withTempPicodeDir(async () => {
      const mgr = new AccountsManager(() => {});
      const out = await handleAccountsCommand(mgr, ["destroy"]);
      expect(out).toContain('unknown verb "destroy"');
    });
  });
});
