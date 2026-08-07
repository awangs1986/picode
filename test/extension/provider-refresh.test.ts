import { describe, expect, it, vi } from "vitest";
import type { Provider } from "@earendil-works/pi-ai";
import { AccountsManager } from "../../src/store/accounts.ts";
import { refreshActiveProviderAccount } from "../../src/extension/provider-refresh.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("refreshActiveProviderAccount", () => {
  it("refreshes an expiring active OAuth credential through the pinned provider implementation", async () => {
    await withTempPicodeDir(async () => {
      const accounts = new AccountsManager(() => {});
      const added = await accounts.importCredentials({
        provider: "openai-codex",
        label: "Codex",
        credentials: { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 1_000 },
      });
      if (!added.ok) return;
      await accounts.setActive(added.value.id);
      const refresh = vi.fn(async () => ({
        type: "oauth" as const,
        access: "fresh-access",
        refresh: "fresh-refresh",
        expires: 100_000,
      }));
      const provider = {
        id: "openai-codex",
        auth: { oauth: { refresh } },
      } as unknown as Provider;

      const result = await refreshActiveProviderAccount(accounts, provider, {
        now: () => 900,
        refreshSkewMs: 200,
      });

      expect(result).toEqual({ ok: true, value: { refreshed: true, accessToken: "fresh-access" } });
      expect(refresh).toHaveBeenCalledWith(
        expect.objectContaining({ access: "old-access", refresh: "old-refresh", expires: 1_000 }),
        expect.any(AbortSignal),
      );
      expect(accounts.activeCredentials("openai-codex")).toMatchObject({
        ok: true,
        value: { accessToken: "fresh-access", refreshToken: "fresh-refresh", expiresAt: 100_000 },
      });
    });
  });

  it("does not refresh a credential that remains valid outside the skew window", async () => {
    await withTempPicodeDir(async () => {
      const accounts = new AccountsManager(() => {});
      const added = await accounts.importCredentials({
        provider: "openai-codex",
        label: "Codex",
        credentials: { accessToken: "valid", refreshToken: "refresh", expiresAt: 10_000 },
      });
      if (!added.ok) return;
      await accounts.setActive(added.value.id);
      const refresh = vi.fn();
      const provider = { id: "openai-codex", auth: { oauth: { refresh } } } as unknown as Provider;

      const result = await refreshActiveProviderAccount(accounts, provider, {
        now: () => 1_000,
        refreshSkewMs: 200,
      });

      expect(result).toEqual({ ok: true, value: { refreshed: false, accessToken: "valid" } });
      expect(refresh).not.toHaveBeenCalled();
    });
  });
});
