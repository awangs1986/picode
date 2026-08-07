import { describe, expect, it, vi } from "vitest";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { AccountsManager } from "../../src/store/accounts.ts";
import { loginProviderIntoVault } from "../../src/extension/provider-login.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

function ui(): ExtensionUIContext {
  return {
    input: vi.fn(async () => "entered-key"),
    select: vi.fn(async (_title, options: string[]) => options[0]),
    notify: vi.fn(),
  } as unknown as ExtensionUIContext;
}

describe("loginProviderIntoVault", () => {
  it("runs the pinned Pi provider OAuth flow and stores it in the single Picode vault", async () => {
    await withTempPicodeDir(async () => {
      const provider = {
        id: "openai-codex",
        name: "OpenAI Codex",
        auth: {
          oauth: {
            name: "Codex OAuth",
            login: async () => ({
              type: "oauth",
              access: "access-secret",
              refresh: "refresh-secret",
              expires: 123456,
            }),
          },
        },
      } as unknown as Provider;
      const accounts = new AccountsManager(() => {});

      const result = await loginProviderIntoVault(accounts, provider, ui());

      expect(result.ok).toBe(true);
      const credentials = accounts.activeCredentials("openai-codex");
      expect(credentials.ok).toBe(false);
      const listed = accounts.list();
      expect(listed.ok && listed.value[0]).toMatchObject({
        provider: "openai-codex",
        label: "OpenAI Codex",
        status: "stored",
      });
    });
  });

  it("supports a provider's official API-key prompt without exposing the key in output", async () => {
    await withTempPicodeDir(async () => {
      const login = vi.fn(async () => ({ type: "api_key", key: "entered-key" }) as const);
      const provider = {
        id: "anthropic",
        name: "Anthropic",
        auth: { apiKey: { name: "Anthropic key", login } },
      } as unknown as Provider;

      const result = await loginProviderIntoVault(new AccountsManager(() => {}), provider, ui());

      expect(result.ok).toBe(true);
      expect(login).toHaveBeenCalledOnce();
      if (result.ok) expect(JSON.stringify(result.value)).not.toContain("entered-key");
    });
  });
});
