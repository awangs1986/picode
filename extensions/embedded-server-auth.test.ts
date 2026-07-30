import { describe, expect, test, vi } from "vitest";
import { removeRegistryApiKey, setRegistryApiKey } from "./embedded-server.ts";

describe("embedded server credential compatibility", () => {
  test("uses the current Pi credential-store interface", async () => {
    const modify = vi.fn(async (_provider, update) => update(undefined));
    const remove = vi.fn(async () => {});
    const registry = {
      runtime: { credentials: { store: { modify, delete: remove } } },
    };

    await setRegistryApiKey(registry, "deepseek", "secret");
    expect(modify).toHaveBeenCalledTimes(1);
    expect(modify.mock.calls[0][0]).toBe("deepseek");
    await expect(modify.mock.calls[0][1](undefined)).resolves.toEqual({
      type: "api_key",
      key: "secret",
    });

    await removeRegistryApiKey(registry, "deepseek");
    expect(remove).toHaveBeenCalledWith("deepseek");
  });

  test("keeps compatibility with older Picot Pi runtimes", async () => {
    const set = vi.fn();
    const remove = vi.fn();
    const registry = { authStorage: { set, remove } };

    await setRegistryApiKey(registry, "anthropic", "legacy-secret");
    expect(set).toHaveBeenCalledWith("anthropic", {
      type: "api_key",
      key: "legacy-secret",
    });
    await removeRegistryApiKey(registry, "anthropic");
    expect(remove).toHaveBeenCalledWith("anthropic");
  });
});
