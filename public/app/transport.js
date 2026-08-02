/**
 * Transport layer — the single surface the frontend uses to drive process /
 * window lifecycle and native operations.
 *
 * Historically every control op went through Tauri IPC via a browser bridge.
 * That hard-wired the UI to the desktop app: a mobile / remote client could
 * not drive those commands.
 *
 * Now there is ONE transport: every op is a `broker_control` request sent over
 * the shared broker WebSocket and awaited via a correlated `control_response`.
 * Inside the desktop app the Rust broker installs a native control handler
 * (capabilities.native = true) and executes these ops; a bare broker / remote
 * client without a handler reports capabilities.native = false and native-only
 * ops reject server-side. The UI is identical across environments.
 */

import { resolveBrokerWsUrl } from "./websocket-client.js";

// Long/interactive ops must not be killed by the default 30s control timeout:
// the folder picker waits for the user, the updater download streams for a while.
const NO_TIMEOUT = 0;
const SPAWN_TIMEOUT_MS = 60000;
// Opening a large history session can take noticeably longer than starting a
// blank workspace because Pi restores and indexes the session before its HTTP
// endpoint becomes ready. Keep this above the native host's 90-second health
// deadline so the UI receives the real result instead of abandoning the
// request while the host is still working.
const SESSION_SPAWN_TIMEOUT_MS = 120000;
const PACKAGE_TIMEOUT_MS = 120000;

function currentPort(env = globalThis.window || globalThis) {
  const port = Number.parseInt(env?.location?.port, 10);
  return Number.isFinite(port) && port > 0 ? port : 47821;
}

export class WsTransport {
  constructor(wsClient, env = globalThis.window || globalThis) {
    this.wsClient = wsClient;
    this.env = env;
  }

  get available() {
    return Boolean(this.wsClient);
  }

  // Live native-capability flag from the broker handshake. Native-only UI is
  // gated on this; it flips true once the `capabilities` frame arrives.
  get capabilities() {
    return this.wsClient?.capabilities || { native: false };
  }

  get hasUpdater() {
    return this.capabilities.native;
  }

  _control(command, args = {}, options = {}) {
    if (!this.wsClient) {
      return Promise.reject(new Error("Transport is not connected"));
    }
    return this.wsClient.sendControl(command, args, options);
  }

  clientSnapshot(surface = this.wsClient?.clientSurface || "gui", clientId = null) {
    const resolvedClientId =
      clientId ||
      this.wsClient?.clientId ||
      globalThis.crypto?.randomUUID?.() ||
      `gui-${Date.now().toString(36)}`;
    return this._control("client_snapshot", {
      clientId: resolvedClientId,
      surface,
      protocolVersion: 1,
    });
  }

  observeConversation(chatId) {
    return this._control("conversation_observe", { chatId });
  }

  claimConversation(chatId) {
    return this._control("conversation_claim", { chatId });
  }

  renewConversation(chatId, generation) {
    return this._control("conversation_renew", { chatId, generation });
  }

  releaseConversation(chatId, generation) {
    return this._control("conversation_release", { chatId, generation });
  }

  reportFailedConversationProbe(chatId) {
    return this._control("conversation_probe_failed", { chatId });
  }

  authorizeConversation(chatId, generation, mutationRequestId) {
    return this._control("conversation_authorize", {
      chatId,
      generation,
      mutationRequestId,
    });
  }

  // ── Process / window lifecycle (create project, sessions, instances) ───────

  openWorkspace(cwd, options = {}) {
    return this._control(
      "open_workspace",
      {
        cwd,
        sessionPath: options.sessionPath ?? null,
        forceNewSession: options.forceNewSession ?? false,
        openWindow: options.openWindow ?? true,
        waitForHealth: options.waitForHealth ?? true,
        waitForSessions: options.waitForSessions ?? false,
      },
      { timeoutMs: SPAWN_TIMEOUT_MS },
    );
  }

  newSession(port) {
    return this._control("new_session", { port: port ?? null });
  }

  switchSession(sessionPath, port) {
    return this._control("switch_session", { sessionPath, port: port ?? null });
  }

  // Fork the active session from a specific user entry. pi forks in-place (same
  // process/port) and emits `session_start { reason: "fork" }`, which flows back
  // to the UI as a mirror_sync snapshot.
  fork(entryId, port) {
    return this._control("fork", { entryId, port: port ?? null });
  }

  // Clone the complete active session at its current leaf. This is the
  // taskbar-level "Fork" action; message-level forks continue to use fork().
  cloneSession(port) {
    return this._control("clone_session", { port: port ?? null });
  }

  stopInstance(port) {
    return this._control("stop_instance", { port: port ?? null });
  }

  spawnSessionProcess(sessionFile, cwd) {
    return this._control(
      "spawn_session_process",
      { sessionFile, cwd, workspacePort: currentPort(this.env) },
      { timeoutMs: SESSION_SPAWN_TIMEOUT_MS },
    );
  }

  // ── Versions / packages ────────────────────────────────────────────────────

  getPiVersion() {
    return this._control("get_pi_version", {});
  }

  getAppVersion() {
    return this._control("get_app_version", {});
  }

  isDev() {
    return this._control("is_dev", {});
  }

  listPiPackages() {
    return this._control("list_pi_packages", {});
  }

  installPiPackage(source) {
    return this._control("install_pi_package", { source }, { timeoutMs: PACKAGE_TIMEOUT_MS });
  }

  removePiPackage(source) {
    return this._control("remove_pi_package", { source }, { timeoutMs: PACKAGE_TIMEOUT_MS });
  }

  // ── Local account vault / manual imports ──────────────────────────────────

  listAccounts() {
    return this._control("account_list", {});
  }

  previewLocalAccountImport(provider) {
    return this._control("account_preview_local", { provider });
  }

  previewJsonAccountImport(provider, content, sourceName = null) {
    return this._control("account_preview_json", { provider, content, sourceName });
  }

  applyAccountImport(previewId, candidateIds, activateCandidateId = null) {
    return this._control("account_apply_import", {
      previewId,
      candidateIds,
      activateCandidateId,
    });
  }

  // ── Native-only ops (need an OS host; reject when capabilities.native=false) ─

  activateAccount(accountId) {
    return this._control("account_activate", { accountId });
  }

  deactivateAccount(provider) {
    return this._control("account_deactivate", { provider });
  }

  discoverCustomProviderModels(baseUrl, api, apiKey) {
    return this._control(
      "custom_provider_discover",
      { baseUrl, api, apiKey },
      { timeoutMs: 30_000 },
    );
  }

  prepareChatPrompt(sessionId, piProvider, message, task = {}) {
    return this._control("chat_prepare_prompt", {
      sessionId,
      piProvider,
      message,
      ...(task.taskId ? { taskId: task.taskId } : {}),
      ...(task.model ? { model: task.model } : {}),
      ...(Number.isFinite(task.sourcePort) ? { sourcePort: task.sourcePort } : {}),
      ...(task.guidance ? { guidance: task.guidance } : {}),
    });
  }

  decideGuidance(request) {
    return this._control("guidance_decide", { request });
  }

  taskSnapshot() {
    return this._control("task_snapshot", {});
  }

  capabilitySnapshot() {
    return this._control("capability_snapshot", {});
  }

  effectiveCapabilityReport(taskId, rules = [], skills = [], overrides = []) {
    return this._control("capability_effective_report", {
      taskId,
      rules,
      skills,
      overrides,
    });
  }

  async listSkills() {
    const response = await fetch("/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "list_skills" }),
    });
    const payload = await response.json();
    if (!response.ok || !payload?.success) {
      throw new Error(payload?.error || `Skill list request failed (${response.status})`);
    }
    return payload.data?.skills || [];
  }

  extensionSnapshot() {
    return this._control("extension_snapshot", {});
  }

  herdrStatus() {
    return this._control("herdr_status", {});
  }

  resetHerdrDecision() {
    return this._control("herdr_reset_decision", {});
  }

  removeHerdr() {
    return this._control("herdr_remove", {}, { timeoutMs: SPAWN_TIMEOUT_MS });
  }

  syncExtensionSkills(skills) {
    return this._control("extension_sync_skills", {
      skills: (skills || []).map((skill, index) => ({
        id: String(skill.name || skill.command || `skill-${index}`)
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, "-"),
        name: skill.name || skill.command || `skill-${index}`,
        description: skill.description || "",
        source: skill.source || skill.scope || "runtime",
        version: skill.version || "runtime",
        enabled: true,
        trusted: true,
      })),
    });
  }

  setCapabilityTier(id, tier) {
    return this._control("capability_set_tier", { id, tier });
  }

  firstmateStatus() {
    return this._control("firstmate_status", {});
  }

  setFirstmateRoot(path) {
    return this._control("firstmate_set_root", { path });
  }

  setFirstmateTrusted(trusted) {
    return this._control("firstmate_set_trusted", { trusted });
  }

  openFirstmate() {
    return this._control("firstmate_open", {}, { timeoutMs: SPAWN_TIMEOUT_MS });
  }

  createSimpleTask(chatId, goal) {
    return this._control("task_create_simple", { chatId, goal });
  }

  registerWorkspace(sourcePlatform, sourcePath, localPath = null) {
    return this._control("task_register_workspace", {
      sourcePlatform,
      sourcePath,
      localPath,
    });
  }

  bindWorkspace(workspaceId, localPath) {
    return this._control("task_bind_workspace", { workspaceId, localPath });
  }

  createHarnessTask(chatId, goal, workspaceId) {
    return this._control("task_create_harness", { chatId, goal, workspaceId });
  }

  startTask(taskId, { provider, accountId, channel, model }) {
    return this._control("task_start", { taskId, provider, accountId, channel, model });
  }

  continueTask(taskId, command, { provider, accountId, channel, model }) {
    return this._control("task_continue", {
      taskId,
      command,
      provider,
      accountId,
      channel,
      model,
    });
  }

  cancelAgentRun(runId) {
    return this._control("agent_cancel", { runId });
  }

  cancelBackgroundJob(jobId) {
    return this._control("background_job_cancel", { jobId });
  }

  startBackgroundJob(taskId, agentRunId, executable, argumentsList = [], timeoutMs) {
    return this._control("background_job_start", {
      taskId,
      agentRunId,
      executable,
      arguments: argumentsList,
      timeoutMs,
    });
  }

  saveTaskGraph(graph) {
    return this._control("task_graph_save", { graph });
  }

  createTaskCheckpoint(taskId, goal, constraints = [], workspaceFacts = {}) {
    return this._control("task_checkpoint", { taskId, goal, constraints, workspaceFacts });
  }

  spawnSubagent(request, piProvider, useConfiguredPolicy = false) {
    return this._control(
      "subagent_spawn",
      { request, piProvider, useConfiguredPolicy },
      { timeoutMs: NO_TIMEOUT },
    );
  }

  getSubagentPolicy() {
    return this._control("subagent_policy_get", {});
  }

  setSubagentPolicy(policy) {
    return this._control("subagent_policy_set", { policy });
  }

  inspectTaskGit(taskId) {
    return this._control("git_snapshot", { taskId });
  }

  createSafeWorktree(taskId, baseRef, branch, targetPath, explicitlyAuthorized) {
    return this._control(
      "git_worktree_create",
      { taskId, baseRef, branch, targetPath, explicitlyAuthorized },
      { timeoutMs: NO_TIMEOUT },
    );
  }

  reviewSafeWorktree(worktreeId) {
    return this._control("git_worktree_review", { worktreeId });
  }

  installProfessionalExtension(manifest) {
    return this._control("extension_install", { manifest });
  }

  migrateProfessionalExtension(extensionId, manifest, permissionExpansionApproved = false) {
    return this._control("extension_migrate", {
      extensionId,
      manifest,
      permissionExpansionApproved,
    });
  }

  setProfessionalExtensionEnabled(extensionId, enabled) {
    return this._control("extension_set_enabled", { extensionId, enabled });
  }

  setProfessionalExtensionTrusted(extensionId, trusted) {
    return this._control("extension_set_trusted", { extensionId, trusted });
  }

  setExtensionComponentEnabled(id, enabled) {
    return this._control("extension_component_set_enabled", { id, enabled });
  }

  setExtensionComponentTrusted(id, trusted) {
    return this._control("extension_component_set_trusted", { id, trusted });
  }

  startProfessionalExtension(extensionId, taskId, agentRunId, timeoutMs) {
    return this._control(
      "extension_start",
      { extensionId, taskId, agentRunId, timeoutMs },
      { timeoutMs: NO_TIMEOUT },
    );
  }

  cancelProfessionalExtension(runId) {
    return this._control("extension_cancel", { runId });
  }

  previewExternalCapabilityImport(source, root) {
    return this._control("external_import_preview", { source, root });
  }

  applyExternalCapabilityImport(previewId, candidateIds, scope) {
    return this._control("external_import_apply", { previewId, candidateIds, scope });
  }

  activateImportedCapability(importedId, taskId, sourcePort = currentPort(this.env)) {
    return this._control("external_import_activate", { importedId, taskId, sourcePort });
  }

  previewMcpImport(content) {
    return this._control("mcp_import_preview", { content });
  }

  applyMcpImport(previewId, selected, scope) {
    return this._control("mcp_import_apply", { previewId, selected, scope });
  }

  startMcpServer(serverId, taskId, agentRunId, timeoutMs) {
    return this._control(
      "mcp_start",
      { serverId, taskId, agentRunId, timeoutMs },
      { timeoutMs: NO_TIMEOUT },
    );
  }

  activateMcpServer(serverId, taskId, sourcePort = currentPort(this.env)) {
    return this._control("mcp_activate", { serverId, taskId, sourcePort });
  }

  setMcpEnabled(serverId, enabled) {
    return this._control("mcp_set_enabled", { serverId, enabled });
  }

  setMcpTrusted(serverId, trusted) {
    return this._control("mcp_set_trusted", { serverId, trusted });
  }

  registerProjectAdapter(adapter) {
    return this._control("adapter_register", { adapter });
  }

  setProjectAdapterEnabled(adapterId, enabled) {
    return this._control("adapter_set_enabled", { adapterId, enabled });
  }

  discoverProjectAdapters(taskId) {
    return this._control("adapter_discover", { taskId });
  }

  launchDap(taskId, agentRunId, config, explicitlyAuthorized, timeoutMs) {
    return this._control(
      "dap_launch",
      { taskId, agentRunId, config, explicitlyAuthorized, timeoutMs },
      { timeoutMs: NO_TIMEOUT },
    );
  }

  cancelTaskExtensions(taskId) {
    return this._control("extension_cancel_task", { taskId });
  }

  addDiagnostic(finding) {
    return this._control("diagnostic_add", { finding });
  }

  requestAdvisory(request) {
    return this._control("advisory_request", request);
  }

  completeAdvisory(advisoryId, candidateOutput) {
    return this._control("advisory_complete", { advisoryId, candidateOutput });
  }

  recordRegression(run) {
    return this._control("regression_record", run);
  }

  compareRegressions(beforeId, afterId) {
    return this._control("regression_compare", { beforeId, afterId });
  }

  reviewHarness(taskId) {
    return this._control("harness_review", { taskId });
  }

  confirmHarness(taskId, selectedIds) {
    return this._control("harness_confirm", { taskId, selectedIds });
  }

  runHarnessAction(taskId, actionId, parameters = {}, riskApproved = false) {
    return this._control(
      "harness_run_action",
      { taskId, actionId, parameters, riskApproved },
      { timeoutMs: NO_TIMEOUT },
    );
  }

  scanLocalChats(sources) {
    return this._control("chat_migration_scan", { sources }, { timeoutMs: PACKAGE_TIMEOUT_MS });
  }

  openChatMigrationContext(scanId, candidateId) {
    return this._control("chat_migration_context_open", {
      scanId,
      candidateId,
      port: currentPort(this.env),
    });
  }

  readChatMigrationContext(scanId, candidateId, cursor = null) {
    return this._control(
      "chat_migration_context_page",
      { scanId, candidateId, cursor },
      { timeoutMs: PACKAGE_TIMEOUT_MS },
    );
  }

  importLocalChats(scanId, candidateIds, workspaceBindings, { includeReasoning = false } = {}) {
    return this._control(
      "chat_migration_import",
      { scanId, candidateIds, workspaceBindings, includeReasoning },
      { timeoutMs: NO_TIMEOUT },
    );
  }

  deleteChats(filePaths, control = null) {
    return this._control(
      "chat_delete",
      {
        filePaths,
        ...(control?.generation
          ? {
              conversationGeneration: control.generation,
              mutationRequestId: control.mutationRequestId,
            }
          : {}),
      },
      { timeoutMs: NO_TIMEOUT },
    );
  }

  scanBackupSessions() {
    return this._control("chat_backup_scan", {}, { timeoutMs: PACKAGE_TIMEOUT_MS });
  }

  pickBackupSavePath() {
    return this._control("chat_backup_pick_save", {}, { timeoutMs: NO_TIMEOUT });
  }

  pickBackupOpenPath() {
    return this._control("chat_backup_pick_open", {}, { timeoutMs: NO_TIMEOUT });
  }

  createChatBackup({ scanId, candidateIds, flags, encrypted, password, destination }) {
    return this._control(
      "chat_backup_create",
      { scanId, candidateIds, flags, encrypted, password, destination },
      { timeoutMs: NO_TIMEOUT },
    );
  }

  probeChatBackup(path) {
    return this._control("chat_backup_probe", { path }, { timeoutMs: PACKAGE_TIMEOUT_MS });
  }

  inspectChatBackup(path, password = "") {
    return this._control("chat_backup_inspect", { path, password }, { timeoutMs: NO_TIMEOUT });
  }

  restoreChatBackup(restoreId, candidateIds, workspaceBindings) {
    return this._control(
      "chat_backup_restore",
      { restoreId, candidateIds, workspaceBindings },
      { timeoutMs: NO_TIMEOUT },
    );
  }

  reviewContextCompression(scanId, candidateIds, provider, modelId) {
    return this._control(
      "context_compression_review",
      { scanId, candidateIds, provider, modelId },
      { timeoutMs: PACKAGE_TIMEOUT_MS },
    );
  }

  pickContextPackageSavePath() {
    return this._control("context_compression_pick_save", {}, { timeoutMs: NO_TIMEOUT });
  }

  createContextPackage({ reviewId, encrypted, password, destination }) {
    return this._control(
      "context_compression_create",
      { reviewId, encrypted, password, destination },
      { timeoutMs: NO_TIMEOUT },
    );
  }

  saveCustomProvider({ providerId, displayName, baseUrl, api, apiKey, modelIds }) {
    return this._control("custom_provider_save", {
      providerId,
      displayName,
      baseUrl,
      api,
      apiKey,
      modelIds,
    });
  }

  pickFolder() {
    return this._control("pick_folder", {}, { timeoutMs: NO_TIMEOUT });
  }

  listInstalledApps() {
    return this._control("list_installed_apps", {});
  }

  openInApp(path, { appName = null, command = null } = {}) {
    return this._control("open_in_app", { path, appName, command });
  }

  openExternal(url) {
    return this._control("open_external", { url });
  }

  openDevtools(port) {
    return this._control("open_devtools", { port: port ?? currentPort(this.env) });
  }

  // ── Auto-updater ────────────────────────────────────────────────────────────

  checkForUpdate() {
    return this._control("check_for_update", {}, { timeoutMs: SPAWN_TIMEOUT_MS });
  }

  downloadAndInstallUpdate(onProgress) {
    return this._control("download_and_install_update", {}, { onProgress, timeoutMs: NO_TIMEOUT });
  }

  relaunchApp() {
    // The host restarts the process, so the control_response typically never
    // arrives (the socket drops first). Swallow only the expected disconnect;
    // surface all other errors to avoid hiding real restart failures.
    return this._control("relaunch_app", {}).catch((err) => {
      const message = String(err?.message || err || "");
      if (/websocket disconnected/i.test(message)) {
        console.warn("[transport] relaunch response not received (app restarting):", err);
        return;
      }
      throw err;
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  currentPort() {
    return currentPort(this.env);
  }

  brokerWsUrl() {
    return resolveBrokerWsUrl(this.env);
  }
}

let singleton = null;

export function createTransport({ wsClient, env = globalThis.window || globalThis } = {}) {
  return new WsTransport(wsClient, env);
}

export function initTransport(opts) {
  singleton = createTransport(opts);
  return singleton;
}

export function getTransport() {
  return singleton;
}
