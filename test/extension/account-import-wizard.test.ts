import { describe, expect, it } from "vitest";
import { startAccountImportWizard } from "../../src/extension/account-import-wizard.ts";
import { AccountsManager } from "../../src/store/accounts.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

describe("account import Web Wizard", () => {
  async function bootstrap(wizardUrl: URL): Promise<{ cookie: string; formUrl: URL }> {
    const response = await fetch(wizardUrl, { redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(response.headers.get("set-cookie")).toMatch(/SameSite=Strict/i);
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (cookie === undefined) throw new Error("missing session cookie");
    return { cookie, formUrl: new URL(response.headers.get("location") ?? "/import", wizardUrl) };
  }

  it("imports submitted JSON credentials through the single Account Vault", async () => {
    await withTempPicodeDir(async () => {
      const accounts = new AccountsManager(() => {});
      const wizard = await startAccountImportWizard({
        accounts,
        openBrowser: async () => {},
        timeoutMs: 5_000,
      });

      const { cookie, formUrl } = await bootstrap(wizard.url);
      expect(formUrl.toString()).not.toContain(wizard.url.pathname);
      const form = await fetch(formUrl, { headers: { cookie } });
      const html = await form.text();
      expect(html).toContain("<form");
      expect(html).toContain("Base URL");
      expect(html).not.toContain(wizard.url.pathname);

      const response = await fetch(new URL("/submit", wizard.url), {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          provider: "openai",
          label: "Codex reverse proxy",
          accessToken: "cpa_secret",
          baseUrl: "https://proxy.example/v1",
        }),
      });

      expect(response.status).toBe(201);
      expect(await wizard.completion).toMatchObject({ status: "imported", provider: "openai" });
      const listed = accounts.list();
      expect(listed.ok && listed.value[0]).toMatchObject({
        provider: "openai",
        label: "Codex reverse proxy",
      });
    });
  });

  it("rejects submissions that did not exchange the one-time bootstrap token", async () => {
    await withTempPicodeDir(async () => {
      const wizard = await startAccountImportWizard({
        accounts: new AccountsManager(() => {}),
        openBrowser: async () => {},
        timeoutMs: 5_000,
      });

      const response = await fetch(new URL("/submit", wizard.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "openai", label: "x", accessToken: "secret" }),
      });

      expect(response.status).toBe(403);
      wizard.cancel();
      expect(await wizard.completion).toEqual({ status: "cancelled" });
    });
  });

  it("shows safe local candidates and imports only the selected account", async () => {
    await withTempPicodeDir(async () => {
      const accounts = new AccountsManager(() => {});
      const wizard = await startAccountImportWizard({
        accounts,
        openBrowser: async () => {},
        timeoutMs: 5_000,
        discoverAccounts: async () => [{
          id: "candidate-a",
          provider: "openai-codex",
          label: "Work Codex",
          source: "C:/Users/test/.codex/auth.json",
          summary: "Codex OAuth · Work Codex",
          credentials: { accessToken: "local-secret", refreshToken: "refresh" },
        }, {
          id: "candidate-b",
          provider: "anthropic",
          label: "Claude",
          source: "C:/Users/test/.claude/.credentials.json",
          summary: "Claude OAuth · Claude",
          credentials: { accessToken: "other-secret" },
        }],
      });
      const { cookie, formUrl } = await bootstrap(wizard.url);
      const html = await (await fetch(formUrl, { headers: { cookie } })).text();
      expect(html).toContain("Work Codex");
      expect(html).toContain("candidate-a");
      expect(html).not.toContain("local-secret");

      const response = await fetch(new URL("/import-candidates", wizard.url), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams({ candidateId: "candidate-a" }),
      });

      expect(response.status).toBe(201);
      expect(await wizard.completion).toMatchObject({ status: "imported", provider: "openai-codex" });
      const listed = accounts.list();
      expect(listed.ok && listed.value).toHaveLength(1);
      expect(listed.ok && listed.value[0]?.label).toBe("Work Codex");
    });
  });

  it("keeps the fallback URL when browser launch fails and times out cleanly", async () => {
    await withTempPicodeDir(async () => {
      const wizard = await startAccountImportWizard({
        accounts: new AccountsManager(() => {}),
        openBrowser: async () => { throw new Error("no desktop browser"); },
        discoverAccounts: async () => [],
        timeoutMs: 20,
      });

      expect(wizard.browserOpened).toBe(false);
      expect(wizard.url.hostname).toBe("127.0.0.1");
      expect(await wizard.completion).toEqual({ status: "timed_out" });
      await expect(fetch(wizard.url)).rejects.toThrow();
    });
  });

  it("publishes the fallback URL without waiting for a stalled desktop browser launcher", async () => {
    await withTempPicodeDir(async () => {
      const startedAt = Date.now();
      const wizard = await startAccountImportWizard({
        accounts: new AccountsManager(() => {}),
        openBrowser: async () => new Promise<void>(() => {}),
        discoverAccounts: async () => [],
        timeoutMs: 5_000,
      });

      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(wizard.url.hostname).toBe("127.0.0.1");
      wizard.cancel();
      expect(await wizard.completion).toEqual({ status: "cancelled" });
    });
  });
});
