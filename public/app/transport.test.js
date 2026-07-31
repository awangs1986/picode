import { describe, expect, test, vi } from "vitest";
import { createTransport, WsTransport } from "./transport.js";

function fakeWsClient(capabilities = { native: true }) {
  return {
    capabilities,
    sendControl: vi.fn((command) => Promise.resolve(`ok:${command}`)),
  };
}

describe("WsTransport", () => {
  test("create project (openWorkspace) sends an open_workspace control command", async () => {
    const ws = fakeWsClient();
    const transport = createTransport({ wsClient: ws, env: { location: { port: "47821" } } });

    await transport.openWorkspace("/tmp/proj", { forceNewSession: true, openWindow: false });

    expect(ws.sendControl).toHaveBeenCalledWith(
      "open_workspace",
      expect.objectContaining({ cwd: "/tmp/proj", forceNewSession: true, openWindow: false }),
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  test("create new session sends a new_session control command", async () => {
    const ws = fakeWsClient();
    const transport = createTransport({ wsClient: ws, env: {} });

    await transport.newSession(47999);

    expect(ws.sendControl).toHaveBeenCalledWith("new_session", { port: 47999 }, {});
  });

  test("switchSession sends a switch_session control command", async () => {
    const ws = fakeWsClient();
    const transport = new WsTransport(ws, {});

    await transport.switchSession("/tmp/session.jsonl", 47822);

    expect(ws.sendControl).toHaveBeenCalledWith(
      "switch_session",
      { sessionPath: "/tmp/session.jsonl", port: 47822 },
      {},
    );
  });

  test("fork sends a fork control command with the entry id", async () => {
    const ws = fakeWsClient();
    const transport = new WsTransport(ws, {});

    await transport.fork("entry-123", 47822);

    expect(ws.sendControl).toHaveBeenCalledWith("fork", { entryId: "entry-123", port: 47822 }, {});
  });

  test("native ops map to their control commands", async () => {
    const ws = fakeWsClient();
    const transport = createTransport({ wsClient: ws, env: { location: { port: "47821" } } });

    await transport.pickFolder();
    await transport.openExternal("https://example.com");

    expect(ws.sendControl).toHaveBeenCalledWith("pick_folder", {}, { timeoutMs: 0 });
    expect(ws.sendControl).toHaveBeenCalledWith(
      "open_external",
      { url: "https://example.com" },
      {},
    );
  });

  test("account imports use an explicit preview then apply flow", async () => {
    const ws = fakeWsClient();
    const transport = new WsTransport(ws, {});

    await transport.previewLocalAccountImport("codex");
    await transport.previewJsonAccountImport("claude", "{}", "claude.json");
    await transport.applyAccountImport("preview-1", ["candidate-1"], "candidate-1");
    await transport.activateAccount("account-2");
    await transport.deactivateAccount("codex");

    expect(ws.sendControl).toHaveBeenCalledWith("account_preview_local", { provider: "codex" }, {});
    expect(ws.sendControl).toHaveBeenCalledWith(
      "account_preview_json",
      { provider: "claude", content: "{}", sourceName: "claude.json" },
      {},
    );
    expect(ws.sendControl).toHaveBeenCalledWith(
      "account_apply_import",
      {
        previewId: "preview-1",
        candidateIds: ["candidate-1"],
        activateCandidateId: "candidate-1",
      },
      {},
    );
    expect(ws.sendControl).toHaveBeenCalledWith("account_activate", { accountId: "account-2" }, {});
    expect(ws.sendControl).toHaveBeenCalledWith("account_deactivate", { provider: "codex" }, {});
  });

  test("custom API discovery and saving use local broker controls", async () => {
    const ws = fakeWsClient();
    const transport = new WsTransport(ws, {});

    await transport.discoverCustomProviderModels(
      "https://api.example/v1",
      "openai-completions",
      "secret",
    );
    await transport.saveCustomProvider({
      providerId: "deepseek",
      displayName: "DeepSeek",
      baseUrl: "https://api.example/v1",
      api: "openai-completions",
      apiKey: "secret",
      modelIds: ["deepseek-chat"],
    });

    expect(ws.sendControl).toHaveBeenCalledWith(
      "custom_provider_discover",
      {
        baseUrl: "https://api.example/v1",
        api: "openai-completions",
        apiKey: "secret",
      },
      { timeoutMs: 30_000 },
    );
    expect(ws.sendControl).toHaveBeenCalledWith(
      "custom_provider_save",
      {
        providerId: "deepseek",
        displayName: "DeepSeek",
        baseUrl: "https://api.example/v1",
        api: "openai-completions",
        apiKey: "secret",
        modelIds: ["deepseek-chat"],
      },
      {},
    );
  });

  test("checks persistent account binding before a chat prompt", async () => {
    const ws = fakeWsClient();
    const transport = new WsTransport(ws, {});

    await transport.prepareChatPrompt("session-a", "openai-codex", "继续", {
      taskId: "task-a",
      model: "gpt-5",
      sourcePort: 47821,
    });

    expect(ws.sendControl).toHaveBeenCalledWith(
      "chat_prepare_prompt",
      {
        sessionId: "session-a",
        piProvider: "openai-codex",
        message: "继续",
        taskId: "task-a",
        model: "gpt-5",
        sourcePort: 47821,
      },
      {},
    );
  });

  test("local chat migration scans first and imports only explicit selections", async () => {
    const ws = fakeWsClient();
    const transport = new WsTransport(ws, {});

    await transport.scanLocalChats(["codex", "cursor"]);
    await transport.openChatMigrationContext("scan-1", "chat-2");
    await transport.readChatMigrationContext("scan-1", "chat-2", "cursor-2");
    await transport.importLocalChats(
      "scan-1",
      ["chat-2"],
      { "workspace-1": "C:\\work" },
      { includeReasoning: true },
    );
    await transport.deleteChats(["C:\\sessions\\chat.jsonl"]);

    expect(ws.sendControl).toHaveBeenCalledWith(
      "chat_migration_scan",
      { sources: ["codex", "cursor"] },
      { timeoutMs: 120_000 },
    );
    expect(ws.sendControl).toHaveBeenCalledWith(
      "chat_migration_context_open",
      { scanId: "scan-1", candidateId: "chat-2", port: 47821 },
      {},
    );
    expect(ws.sendControl).toHaveBeenCalledWith(
      "chat_migration_context_page",
      { scanId: "scan-1", candidateId: "chat-2", cursor: "cursor-2" },
      { timeoutMs: 120_000 },
    );
    expect(ws.sendControl).toHaveBeenCalledWith(
      "chat_migration_import",
      {
        scanId: "scan-1",
        candidateIds: ["chat-2"],
        workspaceBindings: { "workspace-1": "C:\\work" },
        includeReasoning: true,
      },
      { timeoutMs: 0 },
    );
    expect(ws.sendControl).toHaveBeenCalledWith(
      "chat_delete",
      { filePaths: ["C:\\sessions\\chat.jsonl"] },
      { timeoutMs: 0 },
    );
  });

  test("chat backups use native dialogs and explicit verified restore controls", async () => {
    const ws = fakeWsClient();
    const transport = new WsTransport(ws, {});
    const create = {
      scanId: "backup-scan",
      candidateIds: ["chat-1"],
      flags: { "chat-1": { archived: true, favourite: false } },
      encrypted: true,
      password: "password",
      destination: "C:\\backup.picot-backup",
    };

    await transport.scanBackupSessions();
    await transport.pickBackupSavePath();
    await transport.pickBackupOpenPath();
    await transport.createChatBackup(create);
    await transport.probeChatBackup("C:\\backup.picot-backup");
    await transport.inspectChatBackup("C:\\backup.picot-backup", "password");
    await transport.restoreChatBackup("restore-1", ["chat-1"], { group: "C:\\work" });
    await transport.reviewContextCompression(
      "backup-scan",
      ["chat-1"],
      "openai-codex",
      "gpt-5.2-codex",
    );
    await transport.pickContextPackageSavePath();
    await transport.createContextPackage({
      reviewId: "review-1",
      encrypted: true,
      password: "password",
      destination: "C:\\context.picot-context",
    });

    expect(ws.sendControl).toHaveBeenCalledWith("chat_backup_create", create, { timeoutMs: 0 });
    expect(ws.sendControl).toHaveBeenCalledWith(
      "chat_backup_restore",
      {
        restoreId: "restore-1",
        candidateIds: ["chat-1"],
        workspaceBindings: { group: "C:\\work" },
      },
      { timeoutMs: 0 },
    );
    expect(ws.sendControl).toHaveBeenCalledWith(
      "context_compression_review",
      {
        scanId: "backup-scan",
        candidateIds: ["chat-1"],
        provider: "openai-codex",
        modelId: "gpt-5.2-codex",
      },
      { timeoutMs: 120_000 },
    );
    expect(ws.sendControl).toHaveBeenCalledWith(
      "context_compression_create",
      {
        reviewId: "review-1",
        encrypted: true,
        password: "password",
        destination: "C:\\context.picot-context",
      },
      { timeoutMs: 0 },
    );
  });

  test("capabilities reflect the underlying ws client", () => {
    const transport = new WsTransport(fakeWsClient({ native: false }), {});
    expect(transport.capabilities.native).toBe(false);
    expect(transport.hasUpdater).toBe(false);
  });

  test("task control uses the broker for durable task and exact-run operations", async () => {
    const ws = fakeWsClient();
    const transport = new WsTransport(ws, {});

    await transport.taskSnapshot();
    await transport.createSimpleTask("chat-a", "Discuss design");
    await transport.registerWorkspace("windows", "D:\\old", "D:\\game");
    await transport.createHarnessTask("chat-b", "Build game", "workspace-a");
    await transport.continueTask("task-a", "继续", {
      provider: "codex",
      accountId: "account-b",
      channel: "openai",
      model: "gpt-5",
    });
    await transport.cancelAgentRun("run-a");
    await transport.reviewHarness("task-a");
    await transport.confirmHarness("task-a", ["package.test"]);
    await transport.runHarnessAction("task-a", "package.test", {}, true);

    expect(ws.sendControl).toHaveBeenCalledWith("task_snapshot", {}, {});
    expect(ws.sendControl).toHaveBeenCalledWith(
      "task_create_simple",
      { chatId: "chat-a", goal: "Discuss design" },
      {},
    );
    expect(ws.sendControl).toHaveBeenCalledWith(
      "task_register_workspace",
      { sourcePlatform: "windows", sourcePath: "D:\\old", localPath: "D:\\game" },
      {},
    );
    expect(ws.sendControl).toHaveBeenCalledWith(
      "task_create_harness",
      { chatId: "chat-b", goal: "Build game", workspaceId: "workspace-a" },
      {},
    );
    expect(ws.sendControl).toHaveBeenCalledWith(
      "task_continue",
      {
        taskId: "task-a",
        command: "继续",
        provider: "codex",
        accountId: "account-b",
        channel: "openai",
        model: "gpt-5",
      },
      {},
    );
    expect(ws.sendControl).toHaveBeenCalledWith("agent_cancel", { runId: "run-a" }, {});
    expect(ws.sendControl).toHaveBeenCalledWith("harness_review", { taskId: "task-a" }, {});
    expect(ws.sendControl).toHaveBeenCalledWith(
      "harness_confirm",
      { taskId: "task-a", selectedIds: ["package.test"] },
      {},
    );
    expect(ws.sendControl).toHaveBeenCalledWith(
      "harness_run_action",
      { taskId: "task-a", actionId: "package.test", parameters: {}, riskApproved: true },
      { timeoutMs: 0 },
    );
  });

  test("downloadAndInstallUpdate forwards the progress callback with no timeout", async () => {
    const ws = fakeWsClient();
    const transport = new WsTransport(ws, {});
    const onProgress = () => {};

    await transport.downloadAndInstallUpdate(onProgress);

    expect(ws.sendControl).toHaveBeenCalledWith(
      "download_and_install_update",
      {},
      { onProgress, timeoutMs: 0 },
    );
  });

  test("professional extensions remain manual, scoped, and broker-controlled", async () => {
    const ws = fakeWsClient();
    const transport = new WsTransport(ws, {});

    await transport.previewExternalCapabilityImport("cursor", "D:\\project");
    await transport.applyExternalCapabilityImport("preview-a", ["rule-a"], { task: "task-a" });
    await transport.previewMcpImport('{"mcpServers":{}}');
    await transport.applyMcpImport("preview-m", { memory: {} }, { task: "task-a" });
    await transport.startProfessionalExtension("review", "task-a", "run-a", 5000);
    await transport.setProfessionalExtensionTrusted("review", true);
    await transport.launchDap(
      "task-a",
      "run-a",
      { adapter: "csharp-ls", arguments: [], request: "launch", target: "game.exe" },
      true,
      5000,
    );
    await transport.firstmateStatus();
    await transport.setFirstmateRoot("D:\\firstmate");
    await transport.openFirstmate();

    expect(ws.sendControl).toHaveBeenCalledWith(
      "external_import_preview",
      { source: "cursor", root: "D:\\project" },
      {},
    );
    expect(ws.sendControl).toHaveBeenCalledWith(
      "external_import_apply",
      { previewId: "preview-a", candidateIds: ["rule-a"], scope: { task: "task-a" } },
      {},
    );
    expect(ws.sendControl).toHaveBeenCalledWith(
      "extension_start",
      { extensionId: "review", taskId: "task-a", agentRunId: "run-a", timeoutMs: 5000 },
      { timeoutMs: 0 },
    );
    expect(ws.sendControl).toHaveBeenCalledWith(
      "extension_set_trusted",
      { extensionId: "review", trusted: true },
      {},
    );
    expect(ws.sendControl).toHaveBeenCalledWith(
      "dap_launch",
      expect.objectContaining({ taskId: "task-a", explicitlyAuthorized: true }),
      { timeoutMs: 0 },
    );
    expect(ws.sendControl).toHaveBeenCalledWith("firstmate_status", {}, {});
    expect(ws.sendControl).toHaveBeenCalledWith(
      "firstmate_set_root",
      { path: "D:\\firstmate" },
      {},
    );
    expect(ws.sendControl).toHaveBeenCalledWith("firstmate_open", {}, { timeoutMs: 60000 });
  });

  test("currentPort + brokerWsUrl derive from the environment", () => {
    const env = {
      location: { port: "48010", search: "?brokerWs=ws://x/ui-ws" },
      sessionStorage: { getItem: () => null, setItem: () => {} },
    };
    const transport = new WsTransport(fakeWsClient(), env);

    expect(transport.currentPort()).toBe(48010);
    expect(transport.brokerWsUrl()).toBe("ws://x/ui-ws");
  });

  test("relaunchApp swallows the disconnect that follows a host restart", async () => {
    const ws = {
      capabilities: { native: true },
      sendControl: vi.fn(() => Promise.reject(new Error("WebSocket disconnected"))),
    };
    const transport = new WsTransport(ws, {});

    await expect(transport.relaunchApp()).resolves.toBeUndefined();
  });
});
