import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  RpcClient,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import open from "open";
import { picodeDir } from "../shared/paths.ts";
import type { ControlDriver, ControlEvent, SessionIdentity } from "./index.ts";
import { TaskIngress } from "../devloop/index.ts";
import { StateFile } from "../store/state-file.ts";
import { AccountsManager } from "../store/accounts.ts";
import { HARNESS_ENTRY_TYPE, restoreHarnessTier } from "../extension/harness.ts";
import { PERMISSION_ENTRY_TYPE, restorePermissionTier } from "../extension/permissions.ts";
import { startAccountImportWizard } from "../extension/account-import-wizard.ts";
import { CapabilityReadinessRegistry } from "../engine/readiness.ts";
import { PiSessionLifecycle } from "../engine/pi-session-lifecycle.ts";
import { PICODE_SUBAGENT_RESULT_PREFIX } from "../extension/subagent-control-command.ts";
import { WorktreeRegistry } from "../engine/worktree.ts";
import { bootRuntime } from "../extension/index.ts";
import { loadCapabilitySettings, saveCapabilitySettings } from "../store/capabilities.ts";
import { ForeignChatImportService } from "../extension/foreign-chat-import.ts";
import { restoreTaskBinding, TASK_BINDING_ENTRY_TYPE } from "../extension/slice-session.ts";
import { adapterFor } from "../store/import-adapters.ts";
import { WebChatImportCoordinator } from "../extension/web-chat-import.ts";

function controlTasks(tasksRoot: string): TaskIngress {
  return new TaskIngress({
    tasksRoot,
    stateFile: (path, validate) => new StateFile(path, validate),
  });
}

function asEvent(kind: string, payload: unknown): ControlEvent {
  return { version: 1, kind, payload };
}

class EventQueue {
  private readonly values: ControlEvent[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;

  push(value: ControlEvent): void {
    if (this.closed) return;
    this.values.push(value);
    this.waiters.shift()?.();
  }

  close(): void {
    this.closed = true;
    for (const wake of this.waiters.splice(0)) wake();
  }

  async next(): Promise<ControlEvent | undefined> {
    while (this.values.length === 0 && !this.closed) {
      await new Promise<void>((resolveWait) => this.waiters.push(resolveWait));
    }
    return this.values.shift();
  }
}

function eventKind(event: JsonAgentSessionEvent): string {
  const type = (event as { type?: unknown }).type;
  return typeof type === "string" ? `pi.${type}` : "pi.event";
}

function isUiApproval(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  const row = event as { type?: unknown; method?: unknown };
  return row.type === "extension_ui_request" &&
    (row.method === "confirm" || row.method === "select" || row.method === "input" || row.method === "editor");
}

export interface DriverOptions {
  packageRoot: string;
  piEntry: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  extraExtensions?: string[];
}

export class RpcControlDriver implements ControlDriver {
  private readonly approvalClients = new Map<string, RpcClient>();
  private readonly activeRuns = new Map<string, { client: RpcClient; queue: EventQueue }>();
  private readonly cancelledRuns = new Set<string>();
  constructor(private readonly options: DriverOptions) {}

  private picodeRoot(): string {
    return this.options.env?.["PICODE_DIR"] ?? picodeDir();
  }

  private agentRoot(): string {
    return this.options.env?.["PI_CODING_AGENT_DIR"] ?? join(this.picodeRoot(), "agent");
  }

  private sessionsRoot(): string {
    return join(this.agentRoot(), "sessions");
  }

  private sessions(): PiSessionLifecycle {
    return new PiSessionLifecycle(this.sessionsRoot());
  }

  private tasksRoot(): string {
    return join(this.picodeRoot(), "tasks");
  }

  private evidenceRoot(): string {
    return join(this.picodeRoot(), "evidence");
  }

  private client(input: { cwd?: string; session?: string; provider?: string; model?: string } = {}): RpcClient {
    const extension = join(this.options.packageRoot, "src", "extension", "pi-entry.ts");
    const cursorSdkExtension = join(this.options.packageRoot, "src", "extension", "cursor-sdk-entry.ts");
    const args = [
      "--extension", extension,
      "--extension", cursorSdkExtension,
      "--session-dir", this.sessionsRoot(),
    ];
    for (const extra of this.options.extraExtensions ?? []) args.push("--extension", extra);
    if (input.session !== undefined) args.push("--session", input.session);
    return new RpcClient({
      cliPath: this.options.piEntry,
      cwd: input.cwd ?? this.options.cwd ?? process.cwd(),
      env: {
        ...this.options.env,
        PICODE_DIR: this.picodeRoot(),
        PICODE_PACKAGE_ROOT: this.options.packageRoot,
        PI_CODING_AGENT_DIR: this.agentRoot(),
        PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE: "1",
      },
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.model === undefined ? {} : { model: input.model }),
      args,
    });
  }

  async *run(input: {
    prompt: string;
    images?: Array<{ type: "image"; data: string; mimeType: string }>;
    cwd?: string;
    session?: string;
    provider?: string;
    model?: string;
    nonInteractive: boolean;
    timeoutMs?: number;
    permissionTier?: "readonly" | "auto" | "full" | "danger-full-access";
    harnessTier?: "simple" | "standard" | "tdd";
  }): AsyncIterable<ControlEvent> {
    let session = input.session;
    let effectiveHarnessTier: "simple" | "standard" | "tdd" = "simple";
    let effectivePermissionTier: "readonly" | "auto" | "full" | "danger-full-access" = "auto";
    if (session === undefined && (input.permissionTier !== undefined || input.harnessTier !== undefined)) {
      const identity = this.sessions().createSeeded(input.cwd ?? this.options.cwd ?? process.cwd(), (manager) => {
        if (input.harnessTier !== undefined) manager.appendCustomEntry(HARNESS_ENTRY_TYPE, { tier: input.harnessTier });
        if (input.permissionTier !== undefined) manager.appendCustomEntry(PERMISSION_ENTRY_TYPE, { tier: input.permissionTier });
      });
      if (identity.sessionFile === undefined) throw new Error("new session has no persistent file");
      session = identity.sessionFile;
      const manager = await this.sessions().open(identity.sessionFile);
      effectiveHarnessTier = restoreHarnessTier(manager.getBranch());
      effectivePermissionTier = restorePermissionTier(manager.getBranch());
    } else if (session !== undefined) {
      const manager = await this.sessions().open(session);
      if (input.harnessTier !== undefined) manager.appendCustomEntry(HARNESS_ENTRY_TYPE, { tier: input.harnessTier });
      if (input.permissionTier !== undefined) manager.appendCustomEntry(PERMISSION_ENTRY_TYPE, { tier: input.permissionTier });
      session = this.sessions().identity(manager).sessionFile;
      effectiveHarnessTier = restoreHarnessTier(manager.getBranch());
      effectivePermissionTier = restorePermissionTier(manager.getBranch());
    }
    const client = this.client({ ...input, ...(session === undefined ? {} : { session }) });
    const queue = new EventQueue();
    let approvalRequired = false;
    let pendingApprovalId: string | undefined;
    let settleCompaction: ((event: { errorMessage?: string }) => void) | undefined;
    const compactionSettled = new Promise<{ errorMessage?: string }>((resolveCompaction) => {
      settleCompaction = resolveCompaction;
    });
    const runId = randomUUID();
    const unsubscribe = client.onEvent((raw) => {
      if (this.cancelledRuns.has(runId)) return;
      if (isUiApproval(raw)) {
        approvalRequired = true;
        const requestId = (raw as { id?: unknown }).id;
        if (typeof requestId === "string") {
          pendingApprovalId = requestId;
          this.approvalClients.set(requestId, client);
        }
        queue.push(asEvent("approval.required", raw));
      } else {
        queue.push(asEvent(eventKind(raw), raw));
      }
      if ((raw as { type?: unknown }).type === "compaction_end") {
        const errorMessage = (raw as { errorMessage?: unknown }).errorMessage;
        settleCompaction?.(typeof errorMessage === "string" ? { errorMessage } : {});
      }
    });
    const execute = (async () => {
      try {
        await client.start();
        const initialState = await client.getState();
        const taskBinding = initialState.sessionFile === undefined
          ? undefined
          : restoreTaskBinding(SessionManager.open(initialState.sessionFile, this.sessionsRoot()).getBranch());
        this.activeRuns.set(runId, { client, queue });
        queue.push(asEvent("run.started", {
          runId,
          executionEpoch: 1,
          sessionId: initialState.sessionId,
          sessionFile: initialState.sessionFile,
          ...(taskBinding === undefined ? {} : { taskId: taskBinding.taskId }),
          effectiveHarnessTier,
          effectivePermissionTier,
        }));
        const compact = input.prompt.match(/^\/compact(?:\s+([\s\S]+))?\s*$/i);
        let compactResult = "Session compacted";
        if (compact !== null) {
          try {
            await client.compact(compact[1]?.trim() || undefined);
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            if (/nothing to compact/i.test(message)) {
              compactResult = "Nothing to compact";
            } else if (/timeout waiting for response to compact/i.test(message)) {
              // Upstream RpcClient has a fixed 30 s request timeout, while a
              // real gateway summary can legitimately take longer. The Pi
              // runtime continues working and emits the authoritative terminal
              // event, so wait for that event within Picode's run budget.
              const terminal = await new Promise<{ errorMessage?: string }>((resolveCompaction, reject) => {
                const timer = setTimeout(
                  () => reject(new Error("Timeout waiting for compaction terminal event")),
                  input.timeoutMs ?? 600_000,
                );
                void compactionSettled.then((value) => {
                  clearTimeout(timer);
                  resolveCompaction(value);
                }, reject);
              });
              if (terminal.errorMessage) throw new Error(terminal.errorMessage);
            } else {
              throw cause;
            }
          }
        } else {
          await client.prompt(input.prompt, input.images);
        }
        if (input.nonInteractive) {
          const started = Date.now();
          while (!approvalRequired) {
            const state = await client.getState();
            if (!state.isStreaming && state.pendingMessageCount === 0) break;
            if (Date.now() - started > (input.timeoutMs ?? 600_000)) throw new Error("Timeout waiting for headless run");
            await new Promise((resolveWait) => setTimeout(resolveWait, 25));
          }
          if (approvalRequired) {
            if (pendingApprovalId !== undefined) {
              await this.respondApproval(pendingApprovalId, "deny").catch(() => undefined);
            }
            try {
              await client.waitForIdle(5_000);
            } catch {
              await client.abort().catch(() => undefined);
            }
          }
        } else {
          await client.waitForIdle(input.timeoutMs ?? 600_000);
        }
        if (this.cancelledRuns.has(runId)) {
          // cancelRun already emitted the single terminal event.
        } else if (!approvalRequired || !input.nonInteractive) {
          const state = await client.getState();
          queue.push(asEvent("run.completed", {
            runId,
            executionEpoch: 1,
            sessionId: state.sessionId,
            sessionFile: state.sessionFile,
            text: compact === null ? await client.getLastAssistantText() : compactResult,
          }));
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        queue.push(asEvent(/timeout/i.test(message) ? "run.timeout" : "run.error", { message }));
      } finally {
        this.activeRuns.delete(runId);
        this.cancelledRuns.delete(runId);
        for (const [id, owner] of this.approvalClients) if (owner === client) this.approvalClients.delete(id);
        unsubscribe();
        await client.stop();
        queue.close();
      }
    })();
    while (true) {
      const item = await queue.next();
      if (item === undefined) break;
      yield item;
    }
    await execute;
  }

  async respondApproval(requestId: string, action: "once" | "session" | "session-full" | "session-unrestricted" | "deny"): Promise<unknown> {
    const client = this.approvalClients.get(requestId);
    if (client === undefined) throw new Error(`approval request not found: ${requestId}`);
    const value = action === "once" ? "Allow once"
      : action === "session" ? "Allow exact command for this session"
      : action === "session-full" ? "Allow routine operations for this session (destructive/Git still ask)"
      : action === "session-unrestricted" ? "Danger: allow everything for this session (no more prompts)"
      : "Deny";
    // Pi 0.84 exposes extension_ui_response on the wire but RpcClient has no
    // public responder. Keep this pinned-version compatibility access here.
    const compatibility = client as unknown as { process?: { stdin?: { writable: boolean; write(value: string): void } } };
    const stdin = compatibility.process?.stdin;
    if (stdin?.writable !== true) throw new Error("Pi RPC stdin is not writable");
    stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: requestId, value })}\n`);
    this.approvalClients.delete(requestId);
    return { accepted: action !== "deny", action };
  }

  async cancelRun(runId: string): Promise<unknown> {
    const active = this.activeRuns.get(runId);
    if (active === undefined) throw new Error(`run not found: ${runId}`);
    this.cancelledRuns.add(runId);
    active.queue.push(asEvent("run.cancelled", { runId }));
    await active.client.abort();
    return { runId, cancelled: true };
  }

  async steerRun(runId: string, message: string): Promise<unknown> {
    const active = this.activeRuns.get(runId);
    if (active === undefined) throw new Error(`run not found: ${runId}`);
    await active.client.steer(message);
    return { runId, steered: true };
  }

  async createSession(input: { id?: string; cwd?: string }): Promise<SessionIdentity> {
    return this.sessions().createSeeded(
      input.cwd ?? this.options.cwd ?? process.cwd(),
      undefined,
      { ...(input.id === undefined ? {} : { id: input.id }) },
    );
  }

  async listSessions(): Promise<unknown> {
    return (await SessionManager.listAll(this.sessionsRoot())).map((session) => ({
      sessionId: session.id, sessionFile: session.path, cwd: session.cwd, modified: session.modified,
    }));
  }

  resumeSession(session: string): Promise<SessionIdentity> {
    return this.sessions().resolve(session);
  }

  switchSession(session: string): Promise<SessionIdentity> {
    // The CLI is intentionally stateless: this validates and returns the Pi
    // identity that the caller passes to its next command; no second active-session authority.
    return this.sessions().resolve(session);
  }

  async branchSession(session: string, from: string): Promise<SessionIdentity & { from: string }> {
    const identity = await this.sessions().resolve(session);
    if (identity.sessionFile === undefined) throw new Error(`session has no persistent file: ${session}`);
    const client = this.client({ session: identity.sessionFile });
    try {
      await client.start();
      const available = await client.getForkMessages();
      if (!available.some((entry) => entry.entryId === from)) throw new Error(`fork entry not found or is not a user message: ${from}`);
      const result = await client.fork(from);
      if (result.cancelled) throw new Error("session branch was cancelled by an extension");
      const state = await client.getState();
      if (state.sessionFile === undefined || !existsSync(state.sessionFile)) {
        // Forking before the first user message produces an intentionally empty
        // Pi session that upstream defers writing. A one-shot CLI would otherwise
        // return a path that vanishes when the RPC child exits, so persist its
        // upstream SessionManager header before returning the identity.
        const source = await this.sessions().open(identity.sessionFile);
        const emptyBranch = this.sessions().createSeeded(source.getCwd(), undefined, {
          id: state.sessionId,
          parentSession: identity.sessionFile,
        });
        return { ...emptyBranch, from };
      }
      return {
        sessionId: state.sessionId,
        ...(state.sessionFile === undefined ? {} : { sessionFile: state.sessionFile }),
        from,
      };
    } finally {
      await client.stop().catch(() => undefined);
    }
  }

  private async subagentRpc(session: string, method: "status" | "stop" | "resume", params?: Record<string, unknown>): Promise<unknown> {
    const identity = await this.sessions().resolve(session);
    if (identity.sessionFile === undefined) throw new Error(`session has no persistent file: ${session}`);
    const client = this.client({ session: identity.sessionFile });
    let settle: ((value: unknown) => void) | undefined;
    const result = new Promise<unknown>((resolveResult) => { settle = resolveResult; });
    const unsubscribe = client.onEvent((raw) => {
      const row = raw as { type?: unknown; method?: unknown; message?: unknown };
      if (row.type !== "extension_ui_request" || row.method !== "notify" || typeof row.message !== "string") return;
      if (!row.message.startsWith(PICODE_SUBAGENT_RESULT_PREFIX)) return;
      settle?.(JSON.parse(row.message.slice(PICODE_SUBAGENT_RESULT_PREFIX.length)));
    });
    try {
      await client.start();
      const encoded = Buffer.from(JSON.stringify({ method, ...(params === undefined ? {} : { params }) }), "utf8").toString("base64url");
      await client.prompt(`/picode-subagent-rpc ${encoded}`);
      const reply = await Promise.race([
        result,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for pi-subagents control reply")), 12_000)),
      ]) as { success?: boolean; data?: unknown; error?: { message?: string } };
      if (reply.success !== true) throw new Error(reply.error?.message ?? "pi-subagents control request failed");
      return reply.data;
    } finally {
      unsubscribe();
      await client.stop().catch(() => undefined);
    }
  }

  subagentStatus(session: string, runId?: string): Promise<unknown> {
    return this.subagentRpc(session, "status", runId === undefined ? {} : { runId });
  }

  stopSubagent(session: string, runId: string): Promise<unknown> {
    return this.subagentRpc(session, "stop", { runId });
  }

  resumeSubagent(session: string, runId: string, message: string): Promise<unknown> {
    return this.subagentRpc(session, "resume", { runId, message });
  }

  sliceSession(session: string, intent: string): AsyncIterable<ControlEvent> {
    return this.run({ prompt: `/slice ${intent}`, session, nonInteractive: true });
  }

  async listCapsules(taskId: string): Promise<unknown> {
    const root = join(this.tasksRoot(), taskId, "capsules");
    if (!existsSync(root)) return [];
    return readdirSync(root).filter((name) => name.endsWith(".json")).sort().map((name) => {
      const capsule = JSON.parse(readFileSync(join(root, name), "utf8")) as { capsuleId?: string; status?: string; createdAt?: string; intent?: string; digest?: string };
      return {
        capsuleId: capsule.capsuleId ?? name.slice(0, -5),
        status: capsule.status,
        createdAt: capsule.createdAt,
        intent: capsule.intent,
        digest: capsule.digest,
      };
    });
  }

  async readCapsule(taskId: string, capsuleId: string): Promise<unknown> {
    if (!/^[A-Za-z0-9._-]+$/.test(taskId) || !/^[A-Za-z0-9._-]+$/.test(capsuleId)) throw new Error("invalid task or capsule id");
    const path = join(this.tasksRoot(), taskId, "capsules", `${capsuleId}.json`);
    if (!existsSync(path)) throw new Error(`capsule not found: ${capsuleId}`);
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  }

  worktreeStatus(): Promise<unknown> {
    return Promise.resolve(new WorktreeRegistry().list());
  }

  async claimWorktree(workspace: string, taskId: string): Promise<unknown> {
    const result = await new WorktreeRegistry().claimWriter(workspace, taskId, { persistent: true });
    if (!result.ok) throw new Error(result.error.message);
    return { workspace: resolve(workspace), taskId, claimed: true };
  }

  async releaseWorktree(workspace: string, taskId: string): Promise<unknown> {
    const result = await new WorktreeRegistry().releaseWriter(workspace, taskId);
    if (!result.ok) throw new Error(result.error.message);
    return { workspace: resolve(workspace), taskId, released: true };
  }

  private async capabilityRuntime() {
    const runtime = bootRuntime();
    const saved = await loadCapabilitySettings();
    if (saved.ok) runtime.guard.catalog.restoreSettings(saved.value);
    else if (saved.error.code !== "store/state-missing") throw new Error(saved.error.message);
    return runtime;
  }

  async capabilityStatus(): Promise<unknown> {
    const runtime = await this.capabilityRuntime();
    return runtime.guard.catalog.list().map((record) => ({
      id: record.manifest.id,
      title: record.manifest.title,
      origin: record.manifest.origin,
      state: record.setting,
      manifestDigest: record.manifestDigest,
    }));
  }

  async setCapabilityState(capabilityId: string, state: "disabled" | "enabled" | "trusted"): Promise<unknown> {
    const runtime = await this.capabilityRuntime();
    const changed = runtime.guard.catalog.userSetState(capabilityId, state);
    if (!changed.ok) throw new Error(changed.error.message);
    const saved = await saveCapabilitySettings(runtime.guard.catalog.toJSON());
    if (!saved.ok) throw new Error(saved.error.message);
    return { capabilityId, state };
  }

  private importFiles(path: string): string[] {
    const absolute = resolve(path);
    if (!existsSync(absolute)) throw new Error(`import path not found: ${path}`);
    if (statSync(absolute).isFile()) return [absolute];
    const files: string[] = [];
    const pending: Array<{ path: string; depth: number }> = [{ path: absolute, depth: 0 }];
    while (pending.length > 0 && files.length < 1_000) {
      const current = pending.pop();
      if (current === undefined) break;
      for (const entry of readdirSync(current.path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) continue;
        const child = join(current.path, entry.name);
        if (entry.isDirectory() && current.depth < 12) pending.push({ path: child, depth: current.depth + 1 });
        else if (entry.isFile() && /\.jsonl?$/i.test(entry.name)) files.push(child);
        if (files.length >= 1_000) break;
      }
    }
    return files.sort();
  }

  private normalizedImportSource(source: string): string {
    return source === "claude" ? "claude-code" : source;
  }

  private previewCandidate(source: string, file: string): {
    selectionId: string; file: string; source: string; title: string; lastMessage: string;
    lastTimestamp?: string; bytes: number; archived: false;
  } {
    const stat = statSync(file);
    const headBytes = Math.min(stat.size, 128 * 1024);
    const tailBytes = Math.min(Math.max(0, stat.size - headBytes), 512 * 1024);
    const descriptor = openSync(file, "r");
    try {
      const head = Buffer.alloc(headBytes);
      if (headBytes > 0) readSync(descriptor, head, 0, headBytes, 0);
      const tail = Buffer.alloc(tailBytes);
      if (tailBytes > 0) readSync(descriptor, tail, 0, tailBytes, stat.size - tailBytes);
      const sampled = tailBytes === 0 ? head.toString("utf8") : `${head.toString("utf8")}\n${tail.toString("utf8")}`;
      const parsed = adapterFor(source)?.parse(sampled);
      const events = parsed?.ok ? parsed.value.events : [];
      const firstUser = events.find((event) => event.kind === "user" && event.text?.trim());
      const lastDialog = [...events].reverse().find((event) =>
        (event.kind === "user" || event.kind === "assistant") && event.text?.trim()
      );
      const lastTimestamp = [...events].reverse().find((event) => event.timestamp !== undefined)?.timestamp;
      return {
        selectionId: createHash("sha256")
          .update(`${source}\0${resolve(file)}\0${stat.size}\0${stat.mtimeMs}`)
          .digest("hex").slice(0, 24),
        file: resolve(file),
        source,
        title: parsed?.ok
          ? parsed.value.sessionTitle ?? firstUser?.text?.slice(0, 120) ?? file.split(/[\\/]/).at(-1) ?? file
          : file.split(/[\\/]/).at(-1) ?? file,
        lastMessage: lastDialog?.text?.slice(0, 280) ?? "",
        ...(lastTimestamp === undefined ? {} : { lastTimestamp }),
        bytes: stat.size,
        archived: false,
      };
    } finally {
      closeSync(descriptor);
    }
  }

  async previewChats(source: string, path: string): Promise<unknown> {
    const normalized = this.normalizedImportSource(source);
    const candidates: unknown[] = [];
    const errors: Array<{ file: string; message: string }> = [];
    for (const file of this.importFiles(path)) {
      try { candidates.push(this.previewCandidate(normalized, file)); }
      catch (cause) { errors.push({ file, message: cause instanceof Error ? cause.message : String(cause) }); }
    }
    return { candidates, errors, archivedDefault: false };
  }

  async importChats(source: string, path: string, selectionIds: string[], workspace: string): Promise<unknown> {
    const normalized = this.normalizedImportSource(source);
    const runtime = bootRuntime();
    const service = new ForeignChatImportService(runtime);
    const selected = new Set(selectionIds);
    const imported: unknown[] = [];
    for (const file of this.importFiles(path)) {
      const candidate = this.previewCandidate(normalized, file);
      if (!selected.has(candidate.selectionId)) continue;
      const persisted = await service.persist(normalized, file);
      if (!persisted.ok) throw new Error(persisted.error.message);
      const task = await runtime.taskIngress.accept({
        source: `import:${normalized}`,
        externalId: persisted.value.importId,
        title: candidate.title,
        harnessTier: "simple",
        workspace: resolve(workspace),
      });
      if (!task.ok) throw new Error(task.error.message);
      const taskRecord = await runtime.taskIngress.read(task.value.taskId);
      if (!taskRecord.ok) throw new Error(taskRecord.error.message);
      if (taskRecord.value.workspace !== resolve(workspace)) {
        throw new Error(`import ${persisted.value.importId} is already bound to workspace ${taskRecord.value.workspace ?? "(none)"}`);
      }
      const existingSession = (await SessionManager.listAll(this.sessionsRoot())).find((session) => {
        if (resolve(session.cwd) !== resolve(workspace)) return false;
        return SessionManager.open(session.path, this.sessionsRoot()).getEntries().some((entry) => {
          if (entry.type !== "custom" || entry.customType !== "picode.foreign-import") return false;
          return (entry.data as { importId?: unknown } | undefined)?.importId === persisted.value.importId;
        });
      });
      if (existingSession !== undefined) {
        imported.push({
          importId: persisted.value.importId,
          selectionId: candidate.selectionId,
          taskId: task.value.taskId,
          sessionId: existingSession.id,
          sessionFile: existingSession.path,
          archived: false,
          reused: true,
        });
        continue;
      }
      const session = this.sessions().createSeeded(resolve(workspace), (manager) => {
        manager.appendCustomEntry(TASK_BINDING_ENTRY_TYPE, { taskId: task.value.taskId, taskRevision: 1 });
        manager.appendCustomEntry("picode.foreign-import", { importId: persisted.value.importId, sourceAgent: normalized });
        manager.appendMessage({
          role: "custom",
          customType: "picode.foreign-resume",
          content: persisted.value.resumeCapsule,
          display: true,
          details: { importId: persisted.value.importId, sourceAgent: normalized },
          timestamp: Date.now(),
        });
      });
      imported.push({
        importId: persisted.value.importId,
        selectionId: candidate.selectionId,
        taskId: task.value.taskId,
        ...session,
        archived: false,
      });
    }
    const missing = [...selected].filter((id) => !imported.some((row) => (row as { selectionId?: string }).selectionId === id));
    if (missing.length > 0) throw new Error(`selected chat not found or invalid: ${missing.join(", ")}`);
    return imported;
  }

  async *send(input: { session: string; message: string; nonInteractive: boolean }): AsyncIterable<ControlEvent> {
    const identity = await this.sessions().resolve(input.session);
    if (identity.sessionFile === undefined) throw new Error(`session has no persistent file: ${input.session}`);
    yield* this.run({
      prompt: input.message,
      session: identity.sessionFile,
      nonInteractive: input.nonInteractive,
    });
  }

  async *events(input: { session: string; since?: string }): AsyncIterable<ControlEvent> {
    const identity = await this.sessions().resolve(input.session);
    if (identity.sessionFile === undefined) return;
    const manager = await this.sessions().open(identity.sessionFile);
    let include = input.since === undefined;
    for (const entry of manager.getEntries()) {
      if (!include) {
        if (entry.id === input.since) include = true;
        continue;
      }
      yield asEvent("session.event", entry);
    }
  }

  async cancelTask(taskId: string): Promise<unknown> {
    const ingress = controlTasks(this.tasksRoot());
    const written = await ingress.writeControl(taskId, "cancel_requested");
    if (!written.ok) throw new Error(written.error.message);
    const state = await ingress.readControl(taskId);
    return state.ok ? state.value : { taskId, state: "cancel_requested" };
  }

  async waitTask(taskId: string, timeoutMs?: number): Promise<unknown> {
    const started = Date.now();
    while (true) {
      const status = await this.taskStatus(taskId) as { control?: { state?: string } };
      const state = status.control?.state;
      if (state === "completed" || state === "cancelled" || state === "failed") return status;
      if (timeoutMs !== undefined && Date.now() - started >= timeoutMs) {
        throw new Error(`Timeout waiting for task ${taskId}`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }

  private async sessionManager(session: string): Promise<SessionManager> {
    return this.sessions().open(session);
  }

  async harnessTier(session: string): Promise<string> {
    const manager = await this.sessionManager(session);
    return restoreHarnessTier(manager.getBranch());
  }

  async setHarnessTier(session: string, tier: "simple" | "standard" | "tdd"): Promise<string> {
    const manager = await this.sessionManager(session);
    manager.appendCustomEntry(HARNESS_ENTRY_TYPE, { tier });
    const binding = restoreTaskBinding(manager.getBranch());
    if (binding !== undefined) {
      const synchronized = await controlTasks(this.tasksRoot()).updateHarnessTier(binding.taskId, tier);
      if (!synchronized.ok) throw new Error(synchronized.error.message);
    }
    return tier;
  }

  async permissionTier(session: string): Promise<string> {
    const manager = await this.sessionManager(session);
    return restorePermissionTier(manager.getBranch());
  }

  async setPermissionTier(session: string, tier: "readonly" | "auto" | "full" | "danger-full-access"): Promise<string> {
    const manager = await this.sessionManager(session);
    manager.appendCustomEntry(PERMISSION_ENTRY_TYPE, { tier });
    return tier;
  }

  async sessionModelState(session: string): Promise<unknown> {
    const identity = await this.sessions().resolve(session);
    const client = this.client({ session: identity.sessionFile ?? session });
    try {
      await client.start();
      const [state, models, thinkingLevels, harnessTier, permissionTier] = await Promise.all([
        client.getState(), client.getAvailableModels(), client.getAvailableThinkingLevels(),
        this.harnessTier(session), this.permissionTier(session),
      ]);
      return {
        model: state.model === undefined ? null : { provider: state.model.provider, id: state.model.id, name: state.model.name },
        thinkingLevel: state.thinkingLevel,
        harnessTier,
        permissionTier,
        availableModels: models.map((model) => ({ provider: model.provider, id: model.id })),
        availableThinkingLevels: thinkingLevels,
      };
    } finally {
      await client.stop();
    }
  }

  async setSessionModel(session: string, provider: string, modelId: string): Promise<unknown> {
    const identity = await this.sessions().resolve(session);
    const client = this.client({ session: identity.sessionFile ?? session });
    try {
      await client.start();
      const model = await client.setModel(provider, modelId);
      const state = await client.getState();
      return { model, thinkingLevel: state.thinkingLevel };
    } finally {
      await client.stop();
    }
  }

  async setSessionThinking(session: string, level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): Promise<unknown> {
    const identity = await this.sessions().resolve(session);
    const client = this.client({ session: identity.sessionFile ?? session });
    try {
      await client.start();
      await client.setThinkingLevel(level);
      const state = await client.getState();
      return { model: state.model === undefined ? null : { provider: state.model.provider, id: state.model.id }, thinkingLevel: state.thinkingLevel };
    } finally {
      await client.stop();
    }
  }

  async *importAccount(): AsyncIterable<ControlEvent> {
    const runtime = bootRuntime();
    const chats = new WebChatImportCoordinator(runtime, this.sessionsRoot());
    const wizard = await startAccountImportWizard({
      accounts: runtime.accounts,
      openBrowser: async (url) => { await open(url); },
      chatImport: {
        scan: async (input) => chats.scan(input),
        apply: async (input) => chats.apply(input),
      },
    });
    try {
      yield asEvent("account.import.ready", {
        url: wizard.url.toString(),
        browserOpened: wizard.browserOpened,
      });
      yield asEvent("account.import.completed", await wizard.completion);
    } finally {
      wizard.cancel();
    }
  }

  async listAccounts(): Promise<unknown> {
    const accounts = new AccountsManager(() => undefined).list();
    if (!accounts.ok) throw new Error(accounts.error.message);
    return accounts.value;
  }

  async useAccount(accountId: string): Promise<unknown> {
    const selected = await new AccountsManager(() => undefined).setActive(accountId);
    if (!selected.ok) throw new Error(selected.error.message);
    return selected.value;
  }

  async logoutAccount(accountId: string): Promise<unknown> {
    const loggedOut = await new AccountsManager(() => undefined).logout(accountId);
    if (!loggedOut.ok) throw new Error(loggedOut.error.message);
    return loggedOut.value;
  }

  async taskStatus(taskId: string): Promise<unknown> {
    const taskPath = join(this.tasksRoot(), taskId, "task.json");
    if (!existsSync(taskPath)) throw new Error(`task not found: ${taskId}`);
    const task = JSON.parse(readFileSync(taskPath, "utf8")) as unknown;
    const control = await controlTasks(this.tasksRoot()).readControl(taskId);
    return { task, control: control.ok ? control.value : undefined };
  }

  async gateStatus(taskId: string): Promise<unknown> {
    const evidence = await this.evidence(taskId) as Array<{ kind?: string }>;
    return { taskId, gates: evidence.filter((row) => row.kind?.startsWith("tdd.") || row.kind?.startsWith("gate.")) };
  }

  async evidence(taskId: string): Promise<unknown> {
    const events: unknown[] = [];
    if (!existsSync(this.evidenceRoot())) return events;
    for (const file of readdirSync(this.evidenceRoot()).filter((name) => name.endsWith(".jsonl"))) {
      for (const line of readFileSync(join(this.evidenceRoot(), file), "utf8").split(/\r?\n/)) {
        if (line.trim() === "") continue;
        try {
          const row = JSON.parse(line) as { taskId?: string };
          if (row.taskId === taskId) events.push(row);
        } catch {
          // Evidence is append-only; malformed rows are ignored but never rewritten.
        }
      }
    }
    return events;
  }

  async doctor(): Promise<unknown> {
    const checks = [
      { name: "vendored-pi", ok: existsSync(this.options.piEntry), path: this.options.piEntry },
      { name: "picode-extension", ok: existsSync(join(this.options.packageRoot, "src", "extension", "pi-entry.ts")) },
      { name: "agent-dir", ok: true, path: this.agentRoot() },
    ];
    return { healthy: checks.every((check) => check.ok), checks };
  }

  async doctorTools(input: { cwd?: string; harnessTier?: "simple" | "standard" | "tdd" } = {}): Promise<unknown> {
    const env = {
      ...(this.options.env ?? process.env),
      PICODE_PACKAGE_ROOT: this.options.packageRoot,
    };
    const capabilities = await CapabilityReadinessRegistry.defaults({ env })
      .inspectAll({
        cwd: input.cwd ?? this.options.cwd ?? process.cwd(),
        harnessTier: input.harnessTier ?? "standard",
      });
    return {
      healthy: capabilities.every((item) => item.status !== "Unavailable"),
      needsSetup: capabilities.filter((item) => item.status === "NeedsSetup").map((item) => item.capabilityId),
      capabilities,
    };
  }

  async searchTools(query = ""): Promise<unknown> {
    const runtime = await this.capabilityRuntime();
    const manifests = runtime.guard.catalog.search(query);
    const readiness = CapabilityReadinessRegistry.defaults({ env: this.options.env ?? process.env });
    const readinessId = (id: string): string => {
      if (id === "pi-mcp-adapter") return "mcp";
      if (id === "pi-web-access") return "web.search";
      return id;
    };
    return Promise.all(manifests.map(async (manifest) => ({
      capabilityId: manifest.id,
      title: manifest.title,
      summary: manifest.summary,
      origin: manifest.origin,
      readiness: await readiness.inspect(readinessId(manifest.id), {
        cwd: this.options.cwd ?? process.cwd(),
        harnessTier: "standard",
      }),
    })));
  }
}
