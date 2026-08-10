import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { OperationIntent, ReadinessReport, Result, SourceRef } from "../shared/types.ts";
import { err, ok } from "../shared/types.ts";
import {
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  type SubagentDelegationResponse,
} from "pi-subagents/delegation";
import type { HarnessTier } from "../shared/types.ts";
import type { PicodeRuntime } from "./index.ts";
import { HARNESS_ENTRY_TYPE, handleHarnessCommand, restoreHarnessTier } from "./harness.ts";
import { handleAccountsCommand } from "./accounts-command.ts";
import { handleSearchTools } from "./search-tools.ts";
import { loginProviderIntoVault } from "./provider-login.ts";
import { PiAccountAdapter } from "./pi-account-adapter.ts";
import { repairLegacyAccountCapacity } from "./account-capacity-repair.ts";
import { refreshActiveProviderAccount } from "./provider-refresh.ts";
import { resolveIntentApproval } from "./approval-ui.ts";
import { saveConfig } from "../store/config.ts";
import { configureSubagentsForSession } from "./subagent-config.ts";
import { piAgentDir } from "../shared/paths.ts";
import { SliceSessionCoordinator } from "./slice-session.ts";
import { CapabilityReadinessRegistry, StructuredGit, WorktreeRegistry } from "../engine/index.ts";
import type { GitAction, GitRequest } from "../engine/index.ts";
import type { CandidateSnapshot } from "../devloop/verify/gate.ts";
import type { GateContract, GateExecutor } from "../devloop/verify/gate-runner.ts";
import { ShellGateExecutor } from "./gate-command-executor.ts";
import { TddSessionController, type TddSessionCheckpoint } from "./tdd-session.ts";
import {
  effectivePromptLevel,
  PROMPT_LEVEL_ENTRY_TYPE,
  restorePromptOverride,
  sessionPromptInjection,
  type PromptLevel,
} from "./prompts.ts";
import { ForeignChatImportService } from "./foreign-chat-import.ts";
import { parseToolsMd, registerTaskExtensions, renderTaskExtensionSummary } from "./tools-md.ts";
import { appendCacheMetric, computePrefixSignals } from "./cache-signals.ts";
import type { PrefixSignals } from "../shared/types.ts";
import { TodoSessionController } from "./todo-session.ts";
import { ensurePlanSkills, findMattPocockSkills, planCommandResult } from "./plan-command.ts";
import {
  discoverProjectContext,
  renderProjectContext,
  renderTaskStateHeader,
  shouldRestateTaskState,
  taskStateDigest,
} from "../devloop/index.ts";
import type { ProjectContextEntry } from "../devloop/index.ts";
import {
  handlePermissionsCommand,
  PERMISSION_ENTRY_TYPE,
  restorePermissionTier,
} from "./permissions.ts";
import { registerCompactionCompatibility } from "./compaction-compat.ts";
import type { AccountImportCompleteHandler } from "./account-import-wizard.ts";
import { prepareWorkspaceSwitch } from "./workspace-switch.ts";

export interface BridgeProbeSnapshot {
  compactionsObserved: number;
  historyTransitionsObserved: number;
  toolIntentLatencyMs: number[];
}

export interface BridgeOptions {
  now?: () => number;
  onTierReady?: (tier: HarnessTier, ctx: ExtensionContext) => Promise<void> | void;
  onPermissionTierReady?: (
    tier: import("../shared/types.ts").PermissionTier,
    ctx: ExtensionContext,
  ) => Promise<void> | void;
  onSessionReady?: (ctx: ExtensionContext) => Promise<void> | void;
  onReinstall?: (ctx: ExtensionCommandContext) => Promise<void> | void;
  startAccountImport?: (
    onImported: AccountImportCompleteHandler,
  ) => Promise<{ url: URL; browserOpened: boolean }>;
  gateExecutorFor?: (cwd: string) => GateExecutor;
}

const READ_ONLY_SHELL_HEAD = /^(?:pwd|Get-Location|Get-ChildItem|Get-Content|Get-Item|Test-Path|Resolve-Path|Select-String|ls|dir|rg|grep|find)(?:\s|$)/i;
const READ_ONLY_SHELL_PIPE = /^(?:Select-Object|Sort-Object|Format-Table|Format-List|Measure-Object|Group-Object|Out-String|head|tail)(?:\s|$)/i;
const READ_ONLY_GIT = /^git\s+(?:status|diff|show|log|rev-parse|ls-files|blame|shortlog)(?:\s|$)/i;

/** Prove a narrow shell subset read-only; anything ambiguous remains exec/ask. */
function readOnlyShellCategory(command: string): "fs-read" | "git-read" | undefined {
  const trimmed = command.trim();
  if (trimmed === "" || /[;&>{}\n\r]|\b(?:Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item|Invoke-WebRequest|curl|wget)\b/i.test(trimmed)) {
    return undefined;
  }
  if (/\bEnv:/i.test(trimmed)) return undefined;
  if (READ_ONLY_GIT.test(trimmed) && !trimmed.includes("|")) return "git-read";
  const stages = trimmed.split("|").map((stage) => stage.trim());
  if (!READ_ONLY_SHELL_HEAD.test(stages[0] ?? "")) return undefined;
  if (stages.slice(1).some((stage) => !READ_ONLY_SHELL_PIPE.test(stage))) return undefined;
  return "fs-read";
}

async function requestFreshReview(input: {
  pi: ExtensionAPI;
  ownerRunId: string;
  cwd: string;
  task: string;
  model?: string;
  timeoutMs: number;
}): Promise<Result<SourceRef>> {
  const requestId = randomUUID();
  const nodeId = `picode-review-${requestId.slice(0, 8)}`;
  return new Promise((resolveReview) => {
    let settled = false;
    const finish = (result: Result<SourceRef>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolveReview(result);
    };
    const unsubscribe = input.pi.events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (raw) => {
      const response = raw as SubagentDelegationResponse;
      if (response.requestId !== requestId) return;
      if (response.status !== "completed" || response.result?.kind !== "structured") {
        finish(err("devloop/tdd-review-failed", response.error ?? `review ended as ${response.status}`));
        return;
      }
      const value = response.result.value as { passed?: unknown; blockers?: unknown };
      if (value.passed !== true) {
        const blockers = Array.isArray(value.blockers) ? value.blockers.map(String).join("; ") : "reviewer found blockers";
        finish(err("devloop/tdd-review-blockers", blockers));
        return;
      }
      finish(ok({ kind: "evidence", id: response.runId ?? requestId }));
    });
    const timer = setTimeout(() => finish(err("devloop/tdd-review-timeout", "independent review timed out")), input.timeoutMs);
    input.pi.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, {
      requestId,
      ownerRunId: input.ownerRunId,
      nodeId,
      agent: "reviewer",
      task: input.task,
      context: "fresh",
      cwd: input.cwd,
      ...(input.model === undefined ? {} : { model: input.model }),
      timeoutMs: input.timeoutMs,
      // One reviewer round remains the product budget. Twelve internal turns
      // merely let a fresh reviewer inspect, validate, and return its schema
      // without turning a tooling timeout into a false product decision.
      turnBudget: { maxTurns: 12, graceTurns: 1 },
      toolBudget: { hard: 24, block: ["write", "edit"] },
      artifacts: true,
      result: {
        kind: "structured",
        schema: {
          type: "object",
          required: ["passed", "blockers"],
          properties: {
            passed: { type: "boolean" },
            blockers: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
      },
    });
  });
}

export function buildFreshReviewTask(gateId: string): string {
  return `Review only the current candidate for gate ${gateId}. ` +
    "Start with git diff --stat and git diff. Inspect only files in that candidate plus directly imported code when necessary. " +
    "Do not inspect .picode-state, .pi-subagents, prior sessions, task history, or harness internals. " +
    "The target gate already passed in the host. Do not broaden scope or modify files. " +
    "Return the required structured {passed, blockers} result as soon as correctness, regression, scope, and test quality are decided.";
}

const TDD_STATE_ENTRY_TYPE = "picode.tdd-state";
const PLAN_PENDING_ENTRY_TYPE = "picode.plan-pending";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function retainedHistoryHead(entries: readonly unknown[]): string {
  const firstContextEntry = entries.find((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const type = (entry as { type?: unknown }).type;
    return type === "message" || type === "compaction" || type === "branch_summary";
  });
  return canonicalJson(firstContextEntry ?? null);
}

function latestTddCheckpoint(entries: readonly unknown[]): TddSessionCheckpoint | undefined {
  let checkpoint: TddSessionCheckpoint | undefined;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (row.type !== "custom" || row.customType !== TDD_STATE_ENTRY_TYPE) continue;
    const restored = TddSessionController.restore({ execute: async () => {
      throw new Error("checkpoint validation executor must not run");
    } }, row.data);
    if (restored !== undefined) checkpoint = restored.checkpoint();
  }
  return checkpoint;
}

function latestPendingPlan(entries: readonly unknown[]): string | undefined {
  let pending: string | undefined;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (row.type !== "custom" || row.customType !== PLAN_PENDING_ENTRY_TYPE) continue;
    const data = row.data as { state?: unknown; args?: unknown } | undefined;
    if (data?.state === "consumed") pending = undefined;
    else if (data?.state === "pending" && typeof data.args === "string") pending = data.args;
  }
  return pending;
}

export async function candidateSnapshot(pi: ExtensionAPI, cwd: string): Promise<CandidateSnapshot> {
  if (typeof pi.exec !== "function") return { repo: cwd };
  const head = await pi.exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 5_000 });
  const status = await pi.exec("git", ["status", "--porcelain=v1"], { cwd, timeout: 5_000 });
  const dirtyText = status.stdout.trim();
  const dirty = status.code !== 0 || dirtyText !== "";
  let contentDigest: string | undefined;
  if (dirty) {
    const tracked = await pi.exec(
      "git",
      ["diff", "--binary", "--no-ext-diff", "HEAD", "--"],
      { cwd, timeout: 15_000 },
    );
    const untracked = await pi.exec(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd, timeout: 5_000 },
    );
    const untrackedRows: string[] = [];
    if (untracked.code === 0) {
      for (const path of untracked.stdout.split("\0").filter((value) => value !== "").sort()) {
        const blob = await pi.exec("git", ["hash-object", "--", path], { cwd, timeout: 5_000 });
        untrackedRows.push(`${path}\0${blob.code === 0 ? blob.stdout.trim() : "unreadable"}`);
      }
    }
    contentDigest = createHash("sha256")
      .update(`status\0${status.code}\0${status.stdout}\0`)
      .update(`tracked\0${tracked.code}\0${tracked.stdout}\0${tracked.stderr}\0`)
      .update(`untracked\0${untrackedRows.join("\0")}`)
      .digest("hex");
  }
  return {
    repo: cwd,
    ...(head.code === 0 ? { head: head.stdout.trim() } : {}),
    dirty,
    ...(contentDigest === undefined ? {} : { contentDigest }),
  };
}

export async function workspaceChangedFiles(pi: ExtensionAPI, cwd: string): Promise<string[]> {
  if (typeof pi.exec !== "function") return [];
  const [tracked, untracked] = await Promise.all([
    pi.exec("git", ["diff", "--name-only", "-z", "HEAD", "--"], { cwd, timeout: 5_000 }),
    pi.exec("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd, timeout: 5_000 }),
  ]);
  const files = new Set<string>();
  if (tracked.code === 0) {
    for (const path of tracked.stdout.split("\0")) if (path !== "") files.add(path.replaceAll("\\", "/"));
  }
  if (untracked.code === 0) {
    for (const path of untracked.stdout.split("\0")) if (path !== "") files.add(path.replaceAll("\\", "/"));
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

function intentFor(event: ToolCallEvent, cwd: string): OperationIntent {
  const input = event.input as Record<string, unknown>;
  const path = typeof input.path === "string" ? input.path : undefined;
  switch (event.toolName) {
    case "bash": {
      const command = typeof input.command === "string" ? input.command : "";
      const readOnlyCategory = readOnlyShellCategory(command);
      return {
        category: readOnlyCategory ?? (/^\s*git\s+(commit|merge|push|rebase|reset|clean|branch\s+-D)(\s|$)/i.test(command)
          ? "git-mutate"
          : "exec"),
        targets: [command],
        command,
        cwd,
        destructive: /(^|\s)(rm\s+-rf|del\s+\/s|Remove-Item\s+.*-Recurse)(\s|$)/i.test(command),
      };
    }
    case "write":
    case "edit":
      return { category: "fs-write", targets: path === undefined ? [] : [path], cwd };
    case "read":
    case "grep":
    case "find":
    case "ls":
      return { category: "fs-read", targets: path === undefined ? [] : [path], cwd };
    case "git":
      return StructuredGit.intent({ ...(input as GitRequest), cwd, action: String(input.action) as GitAction });
    case "search_tools":
      return input.action === "search"
        ? { category: "capability-read", targets: [String(input.query ?? "")], cwd }
        : { category: "mcp-tool", targets: [`search_tools:${String(input.action ?? "unknown")}`], cwd };
    default:
      return { category: "mcp-tool", targets: [event.toolName], cwd };
  }
}

async function suiteReadiness(id: string, cwd: string, tier: HarnessTier): Promise<ReadinessReport> {
  const registry = CapabilityReadinessRegistry.defaults();
  if (id === "pi-mcp-adapter") return registry.inspect("mcp", { cwd, harnessTier: tier });
  if (id === "pi-lens") return registry.inspect("pi-lens", { cwd, harnessTier: tier });
  if (id === "pi-web-access") {
    const [fetch, search] = await Promise.all([
      registry.inspect("web.fetch", { cwd, harnessTier: tier }),
      registry.inspect("web.search", { cwd, harnessTier: tier }),
    ]);
    return { capabilityId: id, status: search.status === "Ready" ? "Ready" : "Degraded", summary: `fetch ${fetch.status}; search ${search.status}`, missing: search.missing, nextSteps: search.nextSteps, inspectedAt: search.inspectedAt };
  }
  return { capabilityId: id, status: "Ready", summary: "Bundled capability is available", missing: [], nextSteps: [], inspectedAt: new Date().toISOString() };
}

function knownModels(ctx: ExtensionContext): readonly Model<any>[] {
  const registry = ctx.modelRegistry as Partial<{ getAll(): Model<any>[] }> | undefined;
  const catalog = registry?.getAll?.();
  if (catalog !== undefined) return catalog;
  if (ctx.scopedModels !== undefined && ctx.scopedModels.length > 0) {
    return ctx.scopedModels.map((entry) => entry.model);
  }
  return ctx.model === undefined ? [] : [ctx.model];
}

export function registerPicodeBridge(
  pi: ExtensionAPI,
  runtime: PicodeRuntime,
  options: BridgeOptions = {},
): { snapshot(): BridgeProbeSnapshot } {
  registerCompactionCompatibility(pi);
  const now = options.now ?? (() => performance.now());
  const accountAdapter = new PiAccountAdapter(pi);
  const slices = new SliceSessionCoordinator(
    runtime,
    (cwd) => candidateSnapshot(pi, cwd),
    (cwd) => workspaceChangedFiles(pi, cwd),
  );
  const foreignChats = new ForeignChatImportService(runtime);
  const worktrees = new WorktreeRegistry();
  const structuredGit = new StructuredGit();
  const todos = new TodoSessionController(runtime.store);
  let tdd = new TddSessionController(
    options.gateExecutorFor?.(process.cwd()) ?? new ShellGateExecutor(process.cwd()),
  );
  let lastTddHeader: string | undefined;
  let taskToolsSummary: string | undefined;
  let taskToolsSummaryPending = false;
  let projectContext: ProjectContextEntry[] = [];
  let projectContextPending = false;
  let lastTaskStateDigest: string | undefined;
  let tokensSinceTaskState = 0;
  let currentPrefixSignals: PrefixSignals | undefined;
  let claimedWriter: { workspace: string; taskId: string } | undefined;
  let promptOverride: PromptLevel | undefined;
  let compactionsObserved = 0;
  let historyTransitionsObserved = 0;
  const toolIntentLatencyMs: number[] = [];

  const openAccountImport = async (ctx: ExtensionContext): Promise<void> => {
    if (options.startAccountImport === undefined) {
      ctx.ui.notify("Picode account import service is unavailable in this host.", "error");
      return;
    }
    const wizard = await options.startAccountImport(async (completion) => {
      const listed = runtime.accounts.list();
      if (!listed.ok) throw new Error(listed.error.message);
      const active = listed.value.find(
        (account) => completion.importedAccountIds.includes(account.id) && account.status === "active",
      );
      if (active === undefined || completion.activeAccountChanged === false) return;
      const credentials = runtime.accounts.credentialsFor(active.id);
      if (!credentials.ok) throw new Error(credentials.error.message);
      const applied = accountAdapter.apply(
        active,
        credentials.value,
        ctx.modelRegistry.getProvider(active.provider) !== undefined,
        knownModels(ctx),
      );
      if (!applied.ok) throw new Error(applied.error.message);
      ctx.ui.notify(`已将 ${active.label} 加载到当前 Pi 会话。`, "info");
    });
    ctx.ui.notify(
      `${wizard.browserOpened ? "Account import opened" : "Browser did not open; use this link"}: ${wizard.url}`,
      wizard.browserOpened ? "info" : "warning",
    );
  };

  pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
    const started = now();
    const intent = intentFor(event, ctx.cwd);
    if (
      runtime.harness.current() !== "simple" && slices.mutationBlocked() &&
      intent.category !== "fs-read" && intent.category !== "git-read" && intent.category !== "network"
    ) {
      return {
        block: true,
        reason: "hard Slice boundary reached; use /slice <next intent> or /slice-defer once before more mutations",
      };
    }
    if (runtime.harness.current() === "tdd" && (event.toolName === "write" || event.toolName === "edit")) {
      const target = typeof (event.input as Record<string, unknown>).path === "string"
        ? String((event.input as Record<string, unknown>).path)
        : "";
      if (!tdd.mayWrite(target)) {
        return { block: true, reason: "TDD requires a recorded RED before production implementation writes" };
      }
    }
    if (runtime.harness.current() === "tdd" && event.toolName === "bash") {
      const command = typeof (event.input as Record<string, unknown>).command === "string"
        ? String((event.input as Record<string, unknown>).command)
        : "";
      if (!tdd.mayRunShell(command)) {
        return { block: true, reason: "TDD requires a recorded RED before shell commands may mutate files" };
      }
    }
    const needsWriter = runtime.harness.current() !== "simple" &&
      intent.category !== "fs-read" && intent.category !== "git-read" && intent.category !== "network";
    const claimWriterAfterApproval = async (): Promise<ToolCallEventResult | undefined> => {
      if (!needsWriter) return undefined;
      const taskId = slices.currentTaskId();
      if (taskId === undefined) {
        return { block: true, reason: "task binding unavailable; reload the session before writing" };
      }
      const claimed = await worktrees.claimWriter(ctx.cwd, taskId);
      if (!claimed.ok) return { block: true, reason: claimed.error.message };
      claimedWriter = { workspace: ctx.cwd, taskId };
      return undefined;
    };
    const decision = runtime.guard.decide(intent);
    toolIntentLatencyMs.push(Math.max(0, now() - started));
    if (decision.verdict === "allow") return claimWriterAfterApproval();
    if (decision.verdict === "deny") return { block: true, reason: decision.reason };
    let allowed: boolean;
    if (typeof ctx.ui.select === "function") {
      const approval = await resolveIntentApproval(ctx.ui, runtime.guard, intent, decision.reason);
      allowed = approval !== "denied";
      if (approval === "session-full") {
        pi.appendEntry(PERMISSION_ENTRY_TYPE, { tier: "full" });
        await options.onPermissionTierReady?.("full", ctx);
      }
    } else {
      allowed = await ctx.ui.confirm("Picode permission", decision.reason);
    }
    if (!allowed) return { block: true, reason: "user declined" };
    return claimWriterAfterApproval();
  });

  pi.on("session_compact", () => {
    compactionsObserved += 1;
    runtime.cacheMeter.beginNewEpoch();
  });
  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "resume" || event.reason === "fork") historyTransitionsObserved += 1;
    const listedAccounts = runtime.accounts.list();
    if (listedAccounts.ok) {
      for (const account of listedAccounts.value) {
        if (account.status !== "active" || account.chatCompatible === false) continue;
        const credentials = runtime.accounts.credentialsFor(account.id);
        if (!credentials.ok) {
          ctx.ui.notify?.(`Active account ${account.label} could not be restored: ${credentials.error.message}`, "warning");
          continue;
        }
        const catalog = knownModels(ctx);
        const repaired = await repairLegacyAccountCapacity(
          runtime.accounts,
          account,
          credentials.value,
          catalog,
        );
        if (!repaired.ok) {
          ctx.ui.notify?.(`Account ${account.label} capacity could not be refreshed: ${repaired.error.message}`, "warning");
        }
        const accountToRestore = repaired.ok ? repaired.value.account : account;
        const knownProvider = ["anthropic", "openai", "openai-codex", "cursor"].includes(accountToRestore.provider) ||
          ctx.modelRegistry?.getProvider(account.provider) !== undefined;
        const restored = accountAdapter.apply(accountToRestore, credentials.value, knownProvider, catalog);
        if (!restored.ok) {
          ctx.ui.notify?.(`Active account ${accountToRestore.label} could not be restored: ${restored.error.message}`, "warning");
        }
      }
    }
    const branch = ctx.sessionManager.getBranch();
    runtime.harness.switchTo(restoreHarnessTier(branch));
    promptOverride = restorePromptOverride(branch);
    runtime.guard.setTier(restorePermissionTier(branch));
    runtime.guard.catalog.removeByOrigin("task");
    taskToolsSummary = undefined;
    taskToolsSummaryPending = false;
    projectContext = [];
    projectContextPending = false;
    lastTaskStateDigest = undefined;
    tokensSinceTaskState = 0;
    if (runtime.harness.current() !== "simple" && typeof ctx.cwd === "string") {
      const toolsPath = join(ctx.cwd, "TOOLS.md");
      try {
        if (existsSync(toolsPath) && statSync(toolsPath).size <= 256 * 1024) {
          const entries = parseToolsMd(readFileSync(toolsPath, "utf8"));
          registerTaskExtensions(
            runtime.guard.catalog,
            entries,
            typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted(),
          );
          taskToolsSummary = renderTaskExtensionSummary(entries);
          taskToolsSummaryPending = taskToolsSummary !== undefined;
        }
      } catch (cause) {
        ctx.ui.notify?.(`TOOLS.md was not loaded: ${cause instanceof Error ? cause.message : String(cause)}`, "warning");
      }
    }
    const gateExecutor = options.gateExecutorFor?.(ctx.cwd) ?? new ShellGateExecutor(ctx.cwd);
    const savedTdd = latestTddCheckpoint(ctx.sessionManager.getBranch());
    tdd = TddSessionController.restore(gateExecutor, savedTdd) ?? new TddSessionController(gateExecutor);
    lastTddHeader = undefined;
    await slices.onSessionStart(ctx);
    try {
      await slices.syncHarnessTier(runtime.harness.current());
    } catch (cause) {
      ctx.ui.notify?.(
        `Task Harness state was not synchronized: ${cause instanceof Error ? cause.message : String(cause)}`,
        "error",
      );
    }
    const taskId = slices.currentTaskId();
    if (taskId !== undefined) await todos.bind(taskId);
    if (
      runtime.harness.current() !== "simple" &&
      typeof ctx.cwd === "string" &&
      (typeof ctx.isProjectTrusted !== "function" || ctx.isProjectTrusted())
    ) {
      let repoRoot = ctx.cwd;
      try {
        const root = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
          cwd: ctx.cwd,
          timeout: 5_000,
        });
        if (root.code === 0 && root.stdout.trim() !== "") repoRoot = root.stdout.trim();
      } catch {
        // Non-git workspaces still load cwd-local rules.
      }
      projectContext = discoverProjectContext({ repoRoot, cwd: ctx.cwd });
      projectContextPending = projectContext.length > 0;
    }
    if (claimedWriter !== undefined && claimedWriter.taskId !== slices.currentTaskId()) {
      await worktrees.releaseWriter(claimedWriter.workspace, claimedWriter.taskId);
      claimedWriter = undefined;
    }
    await options.onTierReady?.(runtime.harness.current(), ctx);
    if (typeof pi.getActiveTools === "function" && typeof pi.setActiveTools === "function") {
      const active = new Set(pi.getActiveTools());
      if (runtime.harness.current() === "simple") {
        active.delete("todo_write");
        active.delete("harness_result");
        active.delete("git");
      } else {
        active.add("todo_write");
        active.add("git");
        for (const nativeTool of ["grep", "find", "ls"]) active.add(nativeTool);
        if (runtime.harness.current() === "tdd") active.add("harness_result");
        else active.delete("harness_result");
      }
      pi.setActiveTools([...active]);
    }
    await options.onSessionReady?.(ctx);
    const pendingPlan = latestPendingPlan(ctx.sessionManager.getBranch());
    if (pendingPlan !== undefined) {
      // The pending marker is consumed before the turn starts. If a reload
      // occurs while the session is idle, this prevents duplicate /plan runs.
      pi.appendEntry(PLAN_PENDING_ENTRY_TYPE, { state: "consumed" });
      const prompt = planCommandResult(pendingPlan, findMattPocockSkills(ctx.cwd));
      const delivery = typeof ctx.isIdle === "function" && !ctx.isIdle()
        ? { deliverAs: "followUp" as const }
        : undefined;
      if (delivery === undefined) pi.sendUserMessage(prompt.message);
      else pi.sendUserMessage(prompt.message, delivery);
    }
  });
  pi.on("before_agent_start", (event, ctx) => {
    const injection = sessionPromptInjection(runtime.harness.current(), promptOverride);
    const contextEvents: string[] = [];
    const taskToolsIncluded = taskToolsSummaryPending && taskToolsSummary !== undefined;
    if (taskToolsSummaryPending && taskToolsSummary !== undefined) {
      contextEvents.push(taskToolsSummary);
      taskToolsSummaryPending = false;
    }
    if (projectContextPending) {
      const rendered = renderProjectContext(projectContext);
      if (rendered !== "") contextEvents.push(rendered);
      projectContextPending = false;
    }
    if (runtime.harness.current() !== "simple") {
      const state = slices.taskState(
        runtime.harness.current(),
        runtime.harness.current() === "tdd" ? tdd.state() : "working",
        [
          ...projectContext.map((entry) => entry.path),
          ...(taskToolsSummary === undefined ? [] : [join(ctx.cwd, "TOOLS.md")]),
        ],
      );
      if (state !== undefined && shouldRestateTaskState({
        current: state,
        ...(lastTaskStateDigest === undefined ? {} : { previousDigest: lastTaskStateDigest }),
        tokensSinceLast: tokensSinceTaskState,
      })) {
        contextEvents.push(renderTaskStateHeader(state));
        lastTaskStateDigest = taskStateDigest(state);
        tokensSinceTaskState = 0;
      }
    }
    if (runtime.harness.current() === "tdd") {
      const state = tdd.state();
      if (lastTddHeader !== state) contextEvents.push(`<picode_tdd_state>${state}</picode_tdd_state>`);
      lastTddHeader = state;
    }
    const effectiveSystemPrompt = injection === undefined
      ? event.systemPrompt
      : `${event.systemPrompt}\n\n${injection}`;
    const activeToolNames = new Set(typeof pi.getActiveTools === "function" ? pi.getActiveTools() : []);
    const toolSchemas = typeof pi.getAllTools === "function"
      ? pi.getAllTools()
        .filter((tool) => activeToolNames.has(tool.name))
        .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
        .sort((left, right) => left.name.localeCompare(right.name))
      : [];
    currentPrefixSignals = computePrefixSignals({
      systemPrompt: effectiveSystemPrompt,
      toolSchemaJson: canonicalJson(toolSchemas),
      retainedHistoryHead: retainedHistoryHead(ctx.sessionManager.getBranch()),
      provider: ctx.model?.provider ?? "unselected",
      model: ctx.model?.id ?? "unselected",
      ...(ctx.model?.baseUrl === undefined ? {} : { baseUrl: ctx.model.baseUrl }),
    });
    if (injection === undefined && contextEvents.length === 0) return undefined;
    return {
      ...(injection === undefined ? {} : { systemPrompt: effectiveSystemPrompt }),
      ...(contextEvents.length > 0 ? {
        message: {
          customType: "picode.context-event",
          content: contextEvents.join("\n\n"),
          display: false,
          details: { taskTools: taskToolsIncluded, tddState: tdd.state() },
        },
      } : {}),
    };
  });
  pi.on("session_shutdown", async () => {
    if (claimedWriter === undefined) return;
    await worktrees.releaseWriter(claimedWriter.workspace, claimedWriter.taskId);
    claimedWriter = undefined;
  });
  pi.on("session_tree", () => {
    historyTransitionsObserved += 1;
  });
  pi.on("turn_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const usage = event.message.usage;
    runtime.cacheMeter.recordTurn({
      inputTokens: usage.input,
      outputTokens: usage.output ?? 0,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
    }, currentPrefixSignals);
    tokensSinceTaskState += usage.input + (usage.output ?? 0);
    ctx.ui.setStatus("picode-cache", runtime.cacheMeter.format());
    const ts = new Date().toISOString();
    try {
      await appendCacheMetric({
        ts,
        sessionId: ctx.sessionManager?.getSessionId?.() ?? "unknown-session",
        snapshot: runtime.cacheMeter.snapshot(),
        ...(currentPrefixSignals === undefined ? {} : { signals: currentPrefixSignals }),
      });
    } catch (cause) {
      // Metrics are explicitly non-authoritative. A diagnostic write failure must
      // never interrupt or clutter the user's agent loop.
      console.warn("[picode] cache metric was not saved", cause);
    }
    slices.observeTurn(ctx);
  });
  pi.on("turn_start", async (_event, ctx) => {
    const taskId = slices.currentTaskId();
    if (taskId !== undefined && await runtime.taskIngress.cancellationRequested(taskId)) {
      await runtime.taskIngress.writeControl(taskId, "cancelled");
      ctx.ui.notify(`Task ${taskId} was cancelled by the Picode CLI.`, "warning");
      ctx.abort();
      return;
    }
    const providerId = ctx.model?.provider;
    if (providerId === undefined) return;
    const provider = ctx.modelRegistry.getProvider(providerId);
    if (provider === undefined) return;
    const refreshed = await refreshActiveProviderAccount(runtime.accounts, provider, {
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    if (!refreshed.ok) {
      ctx.ui.notify(`OAuth refresh failed: ${refreshed.error.message}`, "error");
      ctx.abort();
      return;
    }
    if (!refreshed.value.refreshed) return;
    const listed = runtime.accounts.list();
    const active = listed.ok
      ? listed.value.find(
        (account) => account.provider === providerId && account.status === "active",
      )
      : undefined;
    const credentials = runtime.accounts.activeCredentials(providerId);
    if (active === undefined || !credentials.ok) {
      ctx.ui.notify(`OAuth refresh failed: active account disappeared for ${providerId}`, "error");
      ctx.abort();
      return;
    }
    const applied = accountAdapter.apply(active, credentials.value, true, knownModels(ctx));
    if (!applied.ok) {
      ctx.ui.notify(`OAuth refresh failed: ${applied.error.message}`, "error");
      ctx.abort();
    }
  });
  pi.on("tool_result", (event, ctx) => {
    runtime.admitRuntime(JSON.stringify({
      version: 1,
      eventId: `tool-result:${event.toolCallId}`,
      kind: "tool.result",
      payload: {
        toolName: event.toolName,
        isError: event.isError,
        usage: event.usage,
        contentBlocks: event.content.length,
      },
    }), {
      executionEpoch: runtime.engine.currentEpoch(),
      runId: ctx.sessionManager.getSessionId(),
      requestId: event.toolCallId,
    });
    if (
      event.toolName === "read" &&
      event.isError &&
      event.content.some((block) => block.type === "text" && /\bEISDIR\b/i.test(block.text))
    ) {
      const guidance = "Picode guidance: Use the Pi-native ls tool for directories; read accepts files only.";
      return {
        isError: true,
        content: event.content.map((block) => block.type === "text"
          ? { ...block, text: `${block.text}\n\n${guidance}` }
          : block),
      };
    }
  });

  pi.registerCommand("picode-compact", {
    description: "Compact the current Pi session through the public extension API",
    handler: async (_args, ctx) => {
      ctx.compact();
    },
  });
  pi.registerCommand("workspace", {
    description: "Force Picode into another absolute workspace and start a fresh Pi session",
    handler: async (args, ctx) => {
      const target = args.trim().replace(/^(["'])(.*)\1$/u, "$2");
      if (target === "") {
        ctx.ui.notify("usage: /workspace <absolute-directory>", "error");
        return;
      }
      const launchId = process.env.PICODE_LAUNCH_ID;
      if (launchId === undefined) {
        ctx.ui.notify("Forced workspace switching requires starting Pi through the `picode` launcher.", "error");
        return;
      }
      const confirmed = await ctx.ui.confirm(
        "Force workspace switch",
        `Current: ${ctx.cwd}\nTarget: ${target}\n\nThis changes project context and starts a fresh Pi session. The current conversation context will not carry over. Picode will write a managed boundary into the target AGENTS.md and permanently deny writes to the previous workspace for this workspace lineage. Continue?`,
      );
      if (!confirmed) {
        ctx.ui.notify("Workspace switch cancelled.", "info");
        return;
      }
      await ctx.waitForIdle();
      const prepared = await prepareWorkspaceSwitch({
        launchId,
        fromWorkspace: ctx.cwd,
        toWorkspace: target,
      });
      if (!prepared.ok) {
        ctx.ui.notify(prepared.error.message, "error");
        return;
      }
      ctx.ui.notify(
        `Workspace boundary saved. Restarting Picode in ${prepared.value.targetWorkspace}`,
        "info",
      );
      ctx.shutdown();
    },
  });
  pi.registerCommand("slice", {
    description: "Seal a Task Capsule and continue in a fresh Pi session",
    handler: async (args, ctx) => {
      await slices.slice(args, ctx);
    },
  });
  pi.registerCommand("slice-defer", {
    description: "Defer the current hard Slice boundary once",
    handler: async (_args, ctx) => {
      const deferred = slices.deferHardBoundary();
      if (!deferred) {
        ctx.ui.notify("No deferrable hard Slice boundary is active.", "info");
        return;
      }
      runtime.admitRuntime(JSON.stringify({
        version: 1,
        eventId: `slice-defer:${ctx.sessionManager.getSessionId()}:${Date.now()}`,
        kind: "slice.deferred",
        payload: { taskId: slices.currentTaskId(), once: true },
      }), {
        executionEpoch: runtime.engine.currentEpoch(),
        runId: ctx.sessionManager.getSessionId(),
        requestId: `slice-defer:${Date.now()}`,
      });
      ctx.ui.notify("Hard Slice boundary deferred once for this session.", "warning");
    },
  });
  pi.registerCommand("chat-import", {
    description: "Preview or continue a Claude Code, Codex, or Cursor JSONL transcript",
    handler: async (args, ctx) => {
      const match = args.trim().match(/^(preview|continue)\s+(claude-code|codex|cursor)\s+(.+)$/i);
      if (match === null) {
        ctx.ui.notify("usage: /chat-import <preview|continue> <claude-code|codex|cursor> <jsonl-path>", "error");
        return;
      }
      const action = match[1]?.toLowerCase();
      const source = match[2]?.toLowerCase();
      const rawPath = match[3]?.trim();
      if (action === undefined || source === undefined || rawPath === undefined) return;
      const file = rawPath.replace(/^(["'])(.*)\1$/, "$2");
      if (action === "preview") {
        const preview = await foreignChats.preview(source, file);
        ctx.ui.notify(preview.ok ? preview.value.reportText : preview.error.message, preview.ok ? "info" : "error");
        return;
      }
      const continued = await foreignChats.continue(source, file, ctx);
      if (!continued.ok && continued.error.code !== "import/cancelled") {
        ctx.ui.notify(continued.error.message, "error");
      }
    },
  });
  pi.registerCommand("harness", {
    description: "Show or switch Picode session mode: simple, standard, or tdd",
    handler: async (args, ctx) => {
      const before = runtime.harness.current();
      const output = handleHarnessCommand(runtime.harness, args);
      const after = runtime.harness.current();
      if (after !== before) {
        try {
          await slices.syncHarnessTier(after);
        } catch (cause) {
          runtime.harness.switchTo(before);
          ctx.ui.notify(
            `harness switch cancelled because Task state could not be synchronized: ${cause instanceof Error ? cause.message : String(cause)}`,
            "error",
          );
          return;
        }
        promptOverride = undefined;
        pi.appendEntry(HARNESS_ENTRY_TYPE, { tier: after });
        pi.appendEntry(PROMPT_LEVEL_ENTRY_TYPE, { level: "harness-default" });
        ctx.ui.notify(output, "info");
        await ctx.reload();
        return;
      }
      ctx.ui.notify(output, output.startsWith("unknown") ? "error" : "info");
    },
  });
  pi.registerCommand("system", {
    description: "Show or switch session prompt guidance: /system prompt [none|lean|full]",
    handler: async (args, ctx) => {
      const match = args.trim().match(/^prompt(?:\s+(none|lean|full))?$/i);
      if (match === null) {
        ctx.ui.notify("usage: /system prompt [none|lean|full]", "error");
        return;
      }
      let level = match[1]?.toLowerCase() as PromptLevel | undefined;
      if (level === undefined && typeof ctx.ui.select === "function") {
        const selected = await ctx.ui.select("System prompt guidance", [
          "none — upstream Pi only",
          "lean — compact engineering guidance",
          "full — complete TDD-oriented guidance",
        ]);
        if (selected === undefined) return;
        level = selected.split(" ", 1)[0] as PromptLevel;
      }
      if (level === undefined) {
        const current = effectivePromptLevel(runtime.harness.current(), promptOverride);
        ctx.ui.notify(`current system prompt: ${current} (none | lean | full)`, "info");
        return;
      }
      const before = effectivePromptLevel(runtime.harness.current(), promptOverride);
      promptOverride = level;
      pi.appendEntry(PROMPT_LEVEL_ENTRY_TYPE, { level });
      if (before !== level) runtime.engine.beginNewEpoch(`system prompt switch: ${before} → ${level}`);
      ctx.ui.notify(
        `system prompt: ${before} → ${level}; guidance only — harness remains ${runtime.harness.current()} and its tools, permissions, sandbox, and verification are unchanged`,
        "info",
      );
    },
  });
  pi.registerCommand("permissions", {
    description: "Show or switch Picode session permissions: readonly, auto, full, or danger-full-access",
    handler: async (args, ctx) => {
      const result = handlePermissionsCommand(runtime.guard, args);
      if (result.changedTo !== undefined) {
        pi.appendEntry(PERMISSION_ENTRY_TYPE, { tier: result.changedTo });
        await options.onPermissionTierReady?.(result.changedTo, ctx);
      }
      const level = result.message.startsWith("unknown")
        ? "error"
        : result.changedTo === "full" || result.changedTo === "danger-full-access" ? "warning" : "info";
      ctx.ui.notify(result.message, level);
    },
  });
  pi.registerCommand("plan", {
    description: "Plan through the installed mattpocock/skills workflow",
    handler: async (args, ctx) => {
      const bootstrap = ensurePlanSkills(ctx.cwd);
      if (!bootstrap.ok) {
        ctx.ui.notify(`Picode bundled planning skills could not be enabled: ${bootstrap.error.message}`, "error");
        return;
      }
      if (bootstrap.value.materialized) {
        pi.appendEntry(PLAN_PENDING_ENTRY_TYPE, { state: "pending", args });
        await ctx.reload();
        return;
      }
      const result = planCommandResult(args, findMattPocockSkills(ctx.cwd));
      // Keep planning in the user's conversation. Picode supplies the
      // recommendation; the skill owns the planning interview and documents.
      const delivery = typeof ctx.isIdle === "function" && !ctx.isIdle()
        ? { deliverAs: "followUp" as const }
        : undefined;
      if (delivery === undefined) pi.sendUserMessage(result.message);
      else pi.sendUserMessage(result.message, delivery);
    },
  });
  pi.registerCommand("reinstall", {
    description: "Offer missing Picode recommended components again",
    handler: async (_args, ctx) => {
      if (options.onReinstall === undefined) {
        ctx.ui.notify("Picode reinstall service is unavailable in this host.", "error");
        return;
      }
      await options.onReinstall(ctx);
    },
  });
  pi.registerCommand("accounts", {
    description: "List, select, label, or import Picode accounts",
    handler: async (args, ctx) => {
      const argv = args.trim() === "" ? [] : args.trim().split(/\s+/);
      if (argv[0] === "import" && options.startAccountImport !== undefined) {
        await openAccountImport(ctx);
        return;
      }
      if (argv[0] === "login") {
        const providerId = argv[1];
        if (providerId === undefined) {
          ctx.ui.notify("usage: /accounts login <provider>", "error");
          return;
        }
        const provider = ctx.modelRegistry.getProvider(providerId);
        if (provider === undefined) {
          ctx.ui.notify(`unknown Pi provider: ${providerId}`, "error");
          return;
        }
        const login = await loginProviderIntoVault(
          runtime.accounts,
          provider,
          ctx.ui,
          ctx.signal ?? new AbortController().signal,
        );
        ctx.ui.notify(
          login.ok
            ? `stored account ${login.value.id}; use /accounts use ${login.value.id} to activate it`
            : `error: ${login.error.message}`,
          login.ok ? "info" : "error",
        );
        return;
      }
      if (argv[0] === "use") {
        const accountId = argv[1];
        if (accountId === undefined) {
          ctx.ui.notify("usage: /accounts use <account-id>", "error");
          return;
        }
        const listed = runtime.accounts.list();
        const account = listed.ok
          ? listed.value.find((candidate) => candidate.id === accountId)
          : undefined;
        if (account === undefined) {
          ctx.ui.notify(`error: no account: ${accountId}`, "error");
          return;
        }
        const credentials = runtime.accounts.credentialsFor(accountId);
        if (!credentials.ok) {
          ctx.ui.notify(`error: ${credentials.error.message}`, "error");
          return;
        }
        const catalog = knownModels(ctx);
        const repaired = await repairLegacyAccountCapacity(
          runtime.accounts,
          account,
          credentials.value,
          catalog,
        );
        if (!repaired.ok) {
          ctx.ui.notify(`Account capacity could not be refreshed: ${repaired.error.message}`, "warning");
        }
        const accountToApply = repaired.ok ? repaired.value.account : account;
        const applied = accountAdapter.apply(
          accountToApply,
          credentials.value,
          ctx.modelRegistry.getProvider(account.provider) !== undefined,
          catalog,
        );
        if (!applied.ok) {
          ctx.ui.notify(`error: ${applied.error.message}`, "error");
          return;
        }
        const switched = await runtime.accounts.setActive(accountId);
        ctx.ui.notify(
          switched.ok
            ? `active account for ${switched.value.provider}: ${switched.value.label}\ncontext unchanged; new execution epoch started (cache epoch reset)`
            : `error: ${switched.error.message}`,
          switched.ok ? "info" : "error",
        );
        return;
      }
      const output = await handleAccountsCommand(runtime.accounts, argv);
      ctx.ui.notify(output, output.startsWith("error:") ? "error" : "info");
    },
  });
  pi.registerCommand("import", {
    description: "Open the Picode Web import wizard",
    handler: async (_args, ctx) => openAccountImport(ctx),
  });
  pi.registerCommand("subagent-model", {
    description: "Choose the model used by pi-subagents, or inherit the current chat model",
    handler: async (args, ctx) => {
      const inherit = "Inherit current session model";
      const available = ctx.modelRegistry.getAvailable()
        .map((model) => `${model.provider}/${model.id}`);
      const requested = args.trim() === ""
        ? await ctx.ui.select("Subagent model", [inherit, ...available])
        : args.trim();
      if (requested === undefined) return;
      if (requested !== inherit && requested !== "inherit" && !available.includes(requested)) {
        ctx.ui.notify(`unknown or unavailable model: ${requested}`, "error");
        return;
      }
      const selected = requested === inherit || requested === "inherit" ? undefined : requested;
      if (selected === undefined) delete runtime.config.subagentModel;
      else runtime.config.subagentModel = selected;
      const saved = await saveConfig(runtime.config);
      if (!saved.ok) {
        ctx.ui.notify(saved.error.message, "error");
        return;
      }
      const configured = await configureSubagentsForSession({
        harnessTier: runtime.harness.current(),
        agentDir: piAgentDir(),
        ...(selected === undefined ? {} : { defaultModel: selected }),
      });
      if (!configured.ok) {
        ctx.ui.notify(configured.error.message, "error");
        return;
      }
      ctx.ui.notify(`Subagent model: ${selected ?? "inherit current session"}`, "info");
      await ctx.reload();
    },
  });

  pi.registerTool({
    name: "todo_write",
    label: "Todo Write",
    description: "Replace the current task todo list. Keep at most one item in_progress.",
    parameters: Type.Object({
      items: Type.Array(Type.Object({
        id: Type.String({ minLength: 1 }),
        content: Type.String({ minLength: 1 }),
        status: Type.Union([
          Type.Literal("pending"),
          Type.Literal("in_progress"),
          Type.Literal("completed"),
        ]),
      })),
    }),
    async execute(_toolCallId, params) {
      const result = await todos.replace(params.items);
      const text = result.ok
        ? JSON.stringify({ items: result.value }, null, 2)
        : `error: ${result.error.message}`;
      return { content: [{ type: "text", text }], details: result.ok ? result.value : result.error, ...(result.ok ? {} : { isError: true }) };
    },
  });

  pi.registerTool({
    name: "git",
    label: "Structured Git",
    description: "Inspect or change Git through fixed actions. Ownership actions always require explicit user approval.",
    parameters: Type.Object({
      action: Type.Union(["status", "diff", "log", "show", "branches", "worktrees", "stage", "unstage", "switch", "create_branch", "restore", "create_worktree", "claim_worktree", "release_worktree", "remove_worktree", "commit", "merge", "rebase", "push", "delete_branch"].map((value) => Type.Literal(value))),
      paths: Type.Optional(Type.Array(Type.String())),
      ref: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
      remote: Type.Optional(Type.String()),
      taskId: Type.Optional(Type.String()),
      worktreePath: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, input, signal, _onUpdate, ctx) {
      if (runtime.harness.current() === "simple") return { content: [{ type: "text", text: "git is available only in standard or tdd harness" }], details: {}, isError: true };
      const result = await structuredGit.execute({ ...(input as Omit<GitRequest, "cwd">), cwd: ctx.cwd }, signal);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result, ...(result.ok ? {} : { isError: true }) };
    },
  });

  pi.registerTool({
    name: "search_tools",
    label: "Search optional tools",
    description:
      "Discover enabled optional capabilities or activate one. Disabled capabilities are intentionally invisible.",
    promptSnippet: "Use search_tools to discover optional capabilities only when the current task needs one.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("search"), Type.Literal("activate")]),
      query: Type.Optional(Type.String()),
      capabilityId: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
      const taskContext = {
        sessionId: ctx.sessionManager.getSessionId(),
        harnessTier: runtime.harness.current(),
        currentTurn: runtime.cacheMeter.snapshot().turns,
      };
      const text = await handleSearchTools(
        {
          guard: runtime.guard,
          readiness: (id, activationContext) => suiteReadiness(id, ctx.cwd, activationContext.harnessTier),
          activate: async (id, activationContext) => {
            const gate = runtime.guard.checkActivatable(id);
            return gate.ok ? runtime.engine.activate(id, activationContext) : gate;
          },
        },
        input,
        taskContext,
      );
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerTool({
    name: "harness_result",
    label: "Picode TDD Gate",
    description: "Advance bounded TDD. Completion requires recorded RED, target gate, a fresh independent reviewer, integration smoke, and a same-snapshot confirmation rerun.",
    promptSnippet: "In TDD mode call harness_result begin, then prove_red, and finally run_gate with an integrationCommand. Never self-report completion.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("status"),
        Type.Literal("begin"),
        Type.Literal("prove_red"),
        Type.Literal("run_gate"),
      ]),
      gateId: Type.Optional(Type.String()),
      command: Type.Optional(Type.String()),
      integrationCommand: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number({ minimum: 1_000, maximum: 600_000 })),
    }),
    async execute(toolCallId, input, _signal, _onUpdate, ctx) {
      const admit = (kind: string, payload: unknown): void => {
        runtime.admitRuntime(JSON.stringify({
          version: 1,
          eventId: `tdd:${toolCallId}:${kind}`,
          kind,
          payload,
          taskId: slices.currentTaskId(),
          sliceId: ctx.sessionManager.getSessionId(),
        }), {
          executionEpoch: runtime.engine.currentEpoch(),
          runId: ctx.sessionManager.getSessionId(),
          requestId: toolCallId,
        });
      };
      if (runtime.harness.current() !== "tdd") {
        return { content: [{ type: "text", text: "harness_result is only active in /harness tdd" }], details: {} };
      }
      if (input.action === "status") {
        return { content: [{ type: "text", text: JSON.stringify(tdd.snapshot(), null, 2) }], details: tdd.snapshot() };
      }
      if (input.action === "begin") {
        const begun = tdd.begin();
        if (begun.ok) {
          pi.appendEntry(TDD_STATE_ENTRY_TYPE, tdd.checkpoint());
          admit("tdd.state", tdd.snapshot());
        }
        return {
          content: [{
            type: "text",
            text: begun.ok
              ? "TDD phase started: RED evidence pending. Write tests only, then call harness_result prove_red with the target command; do not pre-run it through bash. Production writes remain blocked until prove_red records a real failing test."
              : `error: ${begun.error.message}`,
          }],
          details: tdd.snapshot(),
        };
      }
      if (input.gateId === undefined || input.command === undefined) {
        return { content: [{ type: "text", text: "gateId and command are required" }], details: {}, isError: true };
      }
      const contract: GateContract = {
        gateId: input.gateId,
        command: input.command,
        timeoutMs: input.timeoutMs ?? 120_000,
      };
      if (input.action === "prove_red") {
        const red = await tdd.proveRed(contract);
        if (red.ok) {
          pi.appendEntry(TDD_STATE_ENTRY_TYPE, tdd.checkpoint());
          admit("tdd.red", red.value);
        }
        return { content: [{ type: "text", text: red.ok ? JSON.stringify(red.value, null, 2) : `error: ${red.error.message}` }], details: tdd.snapshot(), ...(red.ok ? {} : { isError: true }) };
      }
      if (input.integrationCommand === undefined || input.integrationCommand.trim() === "") {
        return {
          content: [{ type: "text", text: "integrationCommand is required for the completion pipeline" }],
          details: tdd.snapshot(),
          isError: true,
        };
      }
      const snapshot = await candidateSnapshot(pi, ctx.cwd);
      const completed = await tdd.runGate(contract, snapshot, {
        review: () => requestFreshReview({
          pi,
          ownerRunId: ctx.sessionManager.getSessionId(),
          cwd: ctx.cwd,
          task: buildFreshReviewTask(contract.gateId),
          ...(runtime.config.subagentModel === undefined ? {} : { model: runtime.config.subagentModel }),
          timeoutMs: contract.timeoutMs,
        }),
        integrationContract: {
          gateId: `${contract.gateId}:integration`,
          command: input.integrationCommand,
          timeoutMs: input.timeoutMs ?? 120_000,
          requiresTests: false,
        },
        checkpoint: (checkpoint) => { pi.appendEntry(TDD_STATE_ENTRY_TYPE, checkpoint); },
        targetPassed: (evidence) => admit("tdd.green", evidence),
        snapshotNow: () => candidateSnapshot(pi, ctx.cwd),
      });
      pi.appendEntry(TDD_STATE_ENTRY_TYPE, tdd.checkpoint());
      admit(completed.ok ? "tdd.completed" : "tdd.gate-failed", completed.ok ? completed.value : completed.error);
      return { content: [{ type: "text", text: completed.ok ? JSON.stringify(completed.value, null, 2) : `error: ${completed.error.message}` }], details: tdd.snapshot(), ...(completed.ok ? {} : { isError: true }) };
    },
  });

  return {
    snapshot: () => ({
      compactionsObserved,
      historyTransitionsObserved,
      toolIntentLatencyMs: [...toolIntentLatencyMs],
    }),
  };
}
