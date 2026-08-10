import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAccountImportWizard } from "../../src/extension/account-import-wizard.ts";
import { scanLocalAccountCandidates } from "../../src/extension/account-source-scanner.ts";
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
        probeCapacity: async () => ({
          ok: true,
          value: { contextWindow: 1_000_000, maxTokens: 64_000 },
        }),
      });

      const { cookie, formUrl } = await bootstrap(wizard.url);
      expect(formUrl.toString()).not.toContain(wizard.url.pathname);
      const form = await fetch(formUrl, { headers: { cookie } });
      const html = await form.text();
      expect(html).toContain("<form");
      expect(html).toContain("Base URL");
      expect(html).toContain("上下文上限");
      expect(html).toContain('data-layout="chat-browser"');
      expect(html).toContain("导入中心");
      expect(html).not.toContain(wizard.url.pathname);

      const response = await fetch(new URL("/submit", wizard.url), {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          provider: "openai",
          label: "Codex reverse proxy",
          accessToken: "cpa_secret",
          baseUrl: "https://proxy.example/v1",
          defaultModel: "gpt-5.6-terra",
        }),
      });

      expect(response.status).toBe(201);
      expect(await wizard.completion).toMatchObject({ status: "imported", provider: "openai" });
      const listed = accounts.list();
      expect(listed.ok && listed.value[0]).toMatchObject({
        provider: "openai",
        label: "Codex reverse proxy",
        endpoint: {
          baseUrl: "https://proxy.example/v1",
          model: "gpt-5.6-terra",
          contextWindow: 1_000_000,
          maxTokens: 64_000,
        },
      });
    });
  });

  it("preserves a detected Codex reverse proxy through Web import and activation", async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "picode-codex-web-import-"));
    try {
      const codexHome = join(sourceRoot, ".codex");
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "proxy-secret" }));
      writeFileSync(join(codexHome, "config.toml"), [
        'model = "gpt-5.6-terra"',
        'model_provider = "codex-proxy"',
        'openai_base_url = "https://proxy.example/v1"',
      ].join("\n"));

      await withTempPicodeDir(async () => {
        const accounts = new AccountsManager(() => {});
        const liveRefreshes: string[][] = [];
        const detected = await scanLocalAccountCandidates({
          home: sourceRoot,
          env: { CODEX_HOME: codexHome },
        });
        const codex = detected[0];
        expect(codex).toBeDefined();
        const wizard = await startAccountImportWizard({
          accounts,
          openBrowser: async () => {},
          discoverAccounts: async () => detected,
          probeCapacity: async () => ({
            ok: true,
            value: { contextWindow: 1_000_000, maxTokens: 64_000 },
          }),
          onImported: (completion) => { liveRefreshes.push(completion.importedAccountIds); },
          timeoutMs: 5_000,
        });
        const { cookie } = await bootstrap(wizard.url);
        const response = await fetch(new URL("/import-candidates", wizard.url), {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", cookie },
          body: new URLSearchParams({
            candidateId: codex?.id ?? "",
            activateCandidateId: codex?.id ?? "",
          }),
        });

        expect(response.status).toBe(201);
        const responseHtml = await response.text();
        expect(responseHtml).toContain("账号已导入");
        expect(responseHtml).toContain("Codex · codex-proxy");
        expect(responseHtml).toContain("已启用");
        const listed = accounts.list();
        expect(listed.ok && listed.value[0]).toMatchObject({
          provider: "openai",
          status: "active",
          defaultModel: "gpt-5.6-terra",
          endpoint: expect.objectContaining({
            baseUrl: "https://proxy.example/v1",
            model: "gpt-5.6-terra",
            contextWindow: 1_000_000,
            maxTokens: 64_000,
          }),
        });
        const accountId = listed.ok ? listed.value[0]?.id : undefined;
        expect(accountId).toBeDefined();
        expect(accounts.credentialsFor(accountId ?? "")).toMatchObject({
          ok: true,
          value: expect.objectContaining({ baseUrl: "https://proxy.example/v1" }),
        });
        expect(await wizard.completion).toMatchObject({
          status: "imported",
          activeAccountChanged: true,
        });
        expect(liveRefreshes).toEqual([[accountId]]);
      });
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("saves and activates a form-submitted Cursor SDK key with a clear success page", async () => {
    await withTempPicodeDir(async () => {
      const accounts = new AccountsManager(() => {});
      const wizard = await startAccountImportWizard({
        accounts,
        openBrowser: async () => {},
        discoverAccounts: async () => [],
        timeoutMs: 5_000,
      });
      const { cookie } = await bootstrap(wizard.url);
      const response = await fetch(new URL("/submit", wizard.url), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams({
          provider: "cursor",
          label: "Cursor SDK",
          accessToken: "cursor-sdk-secret",
          activateAfterImport: "yes",
        }),
      });

      expect(response.status).toBe(201);
      expect(await response.text()).toContain("Cursor SDK 已保存并启用");
      expect(await wizard.completion).toMatchObject({
        status: "imported",
        activeAccountChanged: true,
      });
      expect(accounts.list()).toMatchObject({
        ok: true,
        value: [expect.objectContaining({
          provider: "cursor",
          authKind: "api_key",
          chatCompatible: true,
          status: "active",
        })],
      });
    });
  });

  it("keeps the chat import navigation alive after saving an account", async () => {
    await withTempPicodeDir(async () => {
      const wizard = await startAccountImportWizard({
        accounts: new AccountsManager(() => {}),
        openBrowser: async () => {},
        discoverAccounts: async () => [],
        timeoutMs: 5_000,
        chatImport: {
          scan: async () => ({
            scanId: "scan-after-account",
            candidates: [],
            workspaceGroups: [],
            duplicatesSkipped: 0,
            warnings: [],
          }),
          apply: async () => [],
        },
      });
      const { cookie } = await bootstrap(wizard.url);
      const saved = await fetch(new URL("/submit", wizard.url), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams({
          provider: "cursor",
          label: "Cursor SDK",
          accessToken: "cursor-sdk-secret",
          activateAfterImport: "yes",
        }),
      });
      expect(saved.status).toBe(201);

      const chats = await fetch(new URL("/import?view=chats", wizard.url), { headers: { cookie } });
      expect(chats.status).toBe(200);
      expect(await chats.text()).toContain("选择聊天记录");
      const finished = await fetch(new URL("/finish", wizard.url), {
        method: "POST",
        headers: { cookie },
      });
      expect(finished.status).toBe(200);
      expect(await wizard.completion).toMatchObject({
        status: "imported",
        activeAccountChanged: true,
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
          piProvider: "openai-codex",
          label: "Work Codex",
          source: "C:/Users/test/.codex/auth.json",
          summary: "Codex OAuth · Work Codex",
          credentials: { accessToken: "local-secret", refreshToken: "refresh" },
          authKind: "oauth",
          chatCompatible: true,
          warnings: [],
        }, {
          id: "candidate-b",
          provider: "anthropic",
          piProvider: "anthropic",
          label: "Claude",
          source: "C:/Users/test/.claude/.credentials.json",
          summary: "Claude OAuth · Claude",
          credentials: { accessToken: "other-secret" },
          authKind: "oauth",
          chatCompatible: true,
          warnings: [],
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

  it("applies multiple selected accounts and activates only the explicit compatible choice", async () => {
    await withTempPicodeDir(async () => {
      const accounts = new AccountsManager(() => {});
      const wizard = await startAccountImportWizard({
        accounts,
        openBrowser: async () => {},
        timeoutMs: 5_000,
        discoverAccounts: async () => [{
          id: "cursor-backup",
          provider: "cursor",
          piProvider: "cursor",
          label: "Cursor Desktop",
          source: "cursor.json",
          summary: "Cursor OAuth backup",
          authKind: "oauth",
          chatCompatible: false,
          warnings: ["backup only"],
          credentials: { accessToken: "oauth", refreshToken: "refresh" },
        }, {
          id: "codex-official",
          provider: "openai-codex",
          piProvider: "openai-codex",
          label: "Codex",
          source: "auth.json",
          summary: "Codex OAuth",
          authKind: "oauth",
          chatCompatible: true,
          warnings: [],
          credentials: { accessToken: "codex", refreshToken: "refresh" },
        }],
      });
      const { cookie } = await bootstrap(wizard.url);
      const response = await fetch(new URL("/import-candidates", wizard.url), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams([
          ["candidateId", "cursor-backup"],
          ["candidateId", "codex-official"],
          ["activateCandidateId", "codex-official"],
        ]),
      });

      expect(response.status).toBe(201);
      expect(await wizard.completion).toMatchObject({
        status: "imported",
        importedAccountIds: expect.arrayContaining([expect.any(String), expect.any(String)]),
        activeAccountChanged: true,
      });
      const listed = accounts.list();
      expect(listed.ok && listed.value).toHaveLength(2);
      expect(listed.ok && listed.value.find((item) => item.provider === "cursor")).toMatchObject({
        status: "stored",
        chatCompatible: false,
      });
      expect(listed.ok && listed.value.find((item) => item.provider === "openai-codex")).toMatchObject({
        status: "active",
      });
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

  it("offers chat scan, filtering, workspace binding, and selective import in the same Web Wizard", async () => {
    await withTempPicodeDir(async () => {
      const imported: unknown[] = [];
      const wizard = await startAccountImportWizard({
        accounts: new AccountsManager(() => {}),
        openBrowser: async () => {},
        discoverAccounts: async () => [],
        discoverChatSources: async () => ({
          codex: { source: "codex", defaultPath: "C:/Users/test/.codex", candidates: ["C:/Users/test/.codex"] },
          cursor: { source: "cursor", defaultPath: "C:/Users/test/.cursor/projects", candidates: ["C:/Users/test/.cursor/projects"] },
          "claude-code": { source: "claude-code", defaultPath: "C:/Users/test/.claude/projects", candidates: ["C:/Users/test/.claude/projects"] },
        }),
        timeoutMs: 5_000,
        chatImport: {
          scan: async (input) => ({
            scanId: "scan-1",
            candidates: [{
              id: "chat-1", source: input.source, file: "C:/history/one.jsonl",
              title: "Imported title", lastMessageSnippet: "latest reply",
              originalWorkspace: "D:/old/repo", workspaceGroupId: "group-1",
              archived: false, updatedAt: "2026-08-09T00:00:00Z",
              fileSizeBytes: 42, contentDigest: "digest",
            }],
            workspaceGroups: [{ id: "group-1", source: input.source, originalWorkspace: "D:/old/repo", candidateCount: 1 }],
            duplicatesSkipped: 0,
            warnings: [],
          }),
          apply: async (request) => { imported.push(request); return [{ sessionId: "pi-1" }]; },
        },
      });
      const { cookie } = await bootstrap(wizard.url);
      const chatPage = await fetch(new URL("/import?view=chats", wizard.url), { headers: { cookie } });
      const chatPageHtml = await chatPage.text();
      expect(chatPageHtml).toContain('name="path"');
      expect(chatPageHtml).toContain('value="C:/Users/test/.codex"');
      expect(chatPageHtml).toContain("source=cursor");

      const cursorPage = await fetch(new URL("/import?view=chats&source=cursor", wizard.url), { headers: { cookie } });
      expect(await cursorPage.text()).toContain('value="C:/Users/test/.cursor/projects"');

      const scanResponse = await fetch(new URL("/chat-scan", wizard.url), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams({
          source: "codex", path: "C:/history", archiveFilter: "active", sort: "updated-desc",
        }),
      });
      const scanHtml = await scanResponse.text();
      expect(scanResponse.status).toBe(200);
      expect(scanHtml).toContain("Imported title");
      expect(scanHtml).toContain("latest reply");
      expect(scanHtml).toContain("D:/old/repo");
      expect(scanHtml).toContain('class="chat-row"');
      expect(scanHtml).toContain("工作区绑定");
      expect(scanHtml).toContain("工具日志和思考过程默认隐藏");

      const applyResponse = await fetch(new URL("/import-chats", wizard.url), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams({
          scanId: "scan-1", candidateId: "chat-1", "workspace.group-1": "D:/new/repo",
          includeReasoning: "yes",
        }),
      });
      expect(applyResponse.status).toBe(201);
      expect(imported).toEqual([{
        scanId: "scan-1",
        candidateIds: ["chat-1"],
        workspaceBindings: { "group-1": "D:/new/repo" },
        includeReasoning: true,
      }]);
      wizard.cancel();
    });
  });
});
