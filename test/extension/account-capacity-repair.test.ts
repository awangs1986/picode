import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { repairLegacyAccountCapacity } from "../../src/extension/account-capacity-repair.ts";
import { createRuntime } from "../../src/extension/index.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("legacy account capacity repair", () => {
  it("persists capacity from the live Pi model catalog without probing the provider", async () => {
    await withTempPicodeDir(async () => {
      const runtime = createRuntime();
      const imported = await runtime.accounts.importCredentials({
        stableId: "old",
        provider: "openai",
        label: "Old proxy",
        credentials: { accessToken: "secret", baseUrl: "https://proxy.example/v1" },
        defaultModel: "gpt-5.6-terra",
      });
      if (!imported.ok) throw new Error(imported.error.message);
      const probe = vi.fn();
      const known = [{
        id: "gpt-5.6-terra",
        provider: "openai",
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      }] as Model<any>[];

      const credentials = runtime.accounts.credentialsFor(imported.value.id);
      if (!credentials.ok) throw new Error(credentials.error.message);
      const result = await repairLegacyAccountCapacity(
        runtime.accounts,
        imported.value,
        credentials.value,
        known,
        probe,
      );

      expect(result.ok && result.value.repaired).toBe(true);
      expect(result.ok && result.value.account.endpoint?.contextWindow).toBe(1_000_000);
      expect(probe).not.toHaveBeenCalled();
      expect(runtime.accounts.list()).toEqual({
        ok: true,
        value: [expect.objectContaining({
          id: imported.value.id,
          endpoint: expect.objectContaining({ contextWindow: 1_000_000, maxTokens: 128_000 }),
        })],
      });
    });
  });

  it("probes a custom provider once and skips accounts that are already repaired", async () => {
    await withTempPicodeDir(async () => {
      const runtime = createRuntime();
      const imported = await runtime.accounts.importCredentials({
        stableId: "custom-old",
        provider: "deepseek-proxy",
        label: "Custom proxy",
        credentials: { accessToken: "secret", baseUrl: "https://proxy.example/v1" },
        defaultModel: "deepseek-r1",
      });
      if (!imported.ok) throw new Error(imported.error.message);
      const credentials = runtime.accounts.credentialsFor(imported.value.id);
      if (!credentials.ok) throw new Error(credentials.error.message);
      const probe = vi.fn(async () => ({
        ok: true as const,
        value: { contextWindow: 272_000, maxTokens: 64_000 },
      }));

      const first = await repairLegacyAccountCapacity(
        runtime.accounts,
        imported.value,
        credentials.value,
        [],
        probe,
      );
      if (!first.ok) throw new Error(first.error.message);
      const second = await repairLegacyAccountCapacity(
        runtime.accounts,
        first.value.account,
        credentials.value,
        [],
        probe,
      );

      expect(first.value.repaired).toBe(true);
      expect(second).toEqual({ ok: true, value: { account: first.value.account, repaired: false } });
      expect(probe).toHaveBeenCalledTimes(1);
    });
  });
});
