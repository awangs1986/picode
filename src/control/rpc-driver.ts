import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  RpcClient,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import open from "open";
import { dataPaths, picodeDir } from "../shared/paths.ts";
import type { ControlDriver, ControlEvent, SessionIdentity } from "./index.ts";
import { TaskIngress } from "../devloop/index.ts";
import { StateFile } from "../store/state-file.ts";
import { AccountsManager } from "../store/accounts.ts";
import { HARNESS_ENTRY_TYPE, restoreHarnessTier } from "../extension/harness.ts";
import { PERMISSION_ENTRY_TYPE, restorePermissionTier } from "../extension/permissions.ts";
import { startAccountImportWizard } from "../extension/account-import-wizard.ts";
import { CapabilityReadinessRegistry } from "../engine/readiness.ts";

function controlTasks(): TaskIngress {
  return new TaskIngress({
    tasksRoot: dataPaths.tasks(),
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

function sessionIdentity(manager: SessionManager): SessionIdentity {
  const file = manager.getSessionFile();
  return {
    sessionId: manager.getSessionId(),
    ...(file === undefined ? {} : { sessionFile: file }),
  };
}

function persistSessionSeed(manager: SessionManager): string {
  const sessionFile = manager.getSessionFile();
  if (sessionFile === undefined) throw new Error("new session has no persistent file");
  const entries = [manager.getHeader(), ...manager.getEntries()];
  writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx" });
  return sessionFile;
}

async function resolveSession(value: string, sessionDir: string): Promise<SessionIdentity> {
  const direct = isAbsolute(value) ? value : resolve(value);
  if (existsSync(direct)) return sessionIdentity(SessionManager.open(direct, sessionDir));
  const all = await SessionManager.listAll(sessionDir);
  const matches = all.filter((session) => session.id === value || session.id.startsWith(value));
  if (matches.length !== 1) {
    throw new Error(matches.length === 0 ? `session not found: ${value}` : `session id is ambiguous: ${value}`);
  }
  const match = matches[0];
  if (match === undefined) throw new Error(`session not found: ${value}`);
  return { sessionId: match.id, sessionFile: match.path };
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

  private client(input: { cwd?: string; session?: string; provider?: string; model?: string } = {}): RpcClient {
    const extension = join(this.options.packageRoot, "src", "extension", "pi-entry.ts");
    const args = ["--extension", extension, "--session-dir", this.sessionsRoot()];
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
    cwd?: string;
    session?: string;
    provider?: string;
    model?: string;
    nonInteractive: boolean;
    timeoutMs?: number;
    permissionTier?: "readonly" | "auto" | "full";
    harnessTier?: "simple" | "standard" | "tdd";
  }): AsyncIterable<ControlEvent> {
    let session = input.session;
    if (session === undefined && (input.permissionTier !== undefined || input.harnessTier !== undefined)) {
      const manager = SessionManager.create(input.cwd ?? this.options.cwd ?? process.cwd(), this.sessionsRoot());
      if (input.harnessTier !== undefined) manager.appendCustomEntry(HARNESS_ENTRY_TYPE, { tier: input.harnessTier });
      if (input.permissionTier !== undefined) manager.appendCustomEntry(PERMISSION_ENTRY_TYPE, { tier: input.permissionTier });
      session = persistSessionSeed(manager);
    }
    const client = this.client({ ...input, ...(session === undefined ? {} : { session }) });
    const queue = new EventQueue();
    let approvalRequired = false;
    const runId = randomUUID();
    const unsubscribe = client.onEvent((raw) => {
      if (this.cancelledRuns.has(runId)) return;
      if (isUiApproval(raw)) {
        approvalRequired = true;
        const requestId = (raw as { id?: unknown }).id;
        if (typeof requestId === "string") this.approvalClients.set(requestId, client);
        queue.push(asEvent("approval.required", raw));
      } else {
        queue.push(asEvent(eventKind(raw), raw));
      }
    });
    const execute = (async () => {
      try {
        await client.start();
        const initialState = await client.getState();
        this.activeRuns.set(runId, { client, queue });
        queue.push(asEvent("run.started", { runId, executionEpoch: 1, sessionId: initialState.sessionId, sessionFile: initialState.sessionFile }));
        const compact = input.prompt.match(/^\/compact(?:\s+([\s\S]+))?\s*$/i);
        if (compact !== null) {
          await client.compact(compact[1]?.trim() || undefined);
        } else {
          await client.prompt(input.prompt);
        }
        if (input.nonInteractive) {
          const started = Date.now();
          while (!approvalRequired) {
            const state = await client.getState();
            if (!state.isStreaming && state.pendingMessageCount === 0) break;
            if (Date.now() - started > (input.timeoutMs ?? 600_000)) throw new Error("Timeout waiting for headless run");
            await new Promise((resolveWait) => setTimeout(resolveWait, 25));
          }
          if (approvalRequired) await client.abort().catch(() => undefined);
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
            text: compact === null ? await client.getLastAssistantText() : "Session compacted",
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

  async respondApproval(requestId: string, action: "once" | "session" | "session-full" | "deny"): Promise<unknown> {
    const client = this.approvalClients.get(requestId);
    if (client === undefined) throw new Error(`approval request not found: ${requestId}`);
    const value = action === "once" ? "Allow once"
      : action === "session" ? "Allow exact command for this session"
      : action === "session-full" ? "Allow routine operations for this session"
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

  async createSession(input: { id?: string; cwd?: string }): Promise<SessionIdentity> {
    mkdirSync(this.sessionsRoot(), { recursive: true });
    const manager = SessionManager.create(input.cwd ?? this.options.cwd ?? process.cwd(), this.sessionsRoot(), {
      ...(input.id === undefined ? {} : { id: input.id }),
    });
    persistSessionSeed(manager);
    return sessionIdentity(manager);
  }

  async listSessions(): Promise<unknown> {
    return (await SessionManager.listAll(this.sessionsRoot())).map((session) => ({
      sessionId: session.id, sessionFile: session.path, cwd: session.cwd, modified: session.modified,
    }));
  }

  resumeSession(session: string): Promise<SessionIdentity> {
    return resolveSession(session, this.sessionsRoot());
  }

  async *send(input: { session: string; message: string; nonInteractive: boolean }): AsyncIterable<ControlEvent> {
    const identity = await resolveSession(input.session, this.sessionsRoot());
    if (identity.sessionFile === undefined) throw new Error(`session has no persistent file: ${input.session}`);
    yield* this.run({
      prompt: input.message,
      session: identity.sessionFile,
      nonInteractive: input.nonInteractive,
    });
  }

  async *events(input: { session: string; since?: string }): AsyncIterable<ControlEvent> {
    const identity = await resolveSession(input.session, this.sessionsRoot());
    if (identity.sessionFile === undefined) return;
    const manager = SessionManager.open(identity.sessionFile, this.sessionsRoot());
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
    const ingress = controlTasks();
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
    const identity = await resolveSession(session, this.sessionsRoot());
    if (identity.sessionFile === undefined) throw new Error(`session has no persistent file: ${session}`);
    return SessionManager.open(identity.sessionFile, this.sessionsRoot());
  }

  async harnessTier(session: string): Promise<string> {
    const manager = await this.sessionManager(session);
    return restoreHarnessTier(manager.getBranch());
  }

  async setHarnessTier(session: string, tier: "simple" | "standard" | "tdd"): Promise<string> {
    const manager = await this.sessionManager(session);
    manager.appendCustomEntry(HARNESS_ENTRY_TYPE, { tier });
    return tier;
  }

  async permissionTier(session: string): Promise<string> {
    const manager = await this.sessionManager(session);
    return restorePermissionTier(manager.getBranch());
  }

  async setPermissionTier(session: string, tier: "readonly" | "auto" | "full"): Promise<string> {
    const manager = await this.sessionManager(session);
    manager.appendCustomEntry(PERMISSION_ENTRY_TYPE, { tier });
    return tier;
  }

  async *importAccount(): AsyncIterable<ControlEvent> {
    const wizard = await startAccountImportWizard({
      accounts: new AccountsManager(() => undefined),
      openBrowser: async (url) => { await open(url); },
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

  async taskStatus(taskId: string): Promise<unknown> {
    const taskPath = join(dataPaths.tasks(), taskId, "task.json");
    if (!existsSync(taskPath)) throw new Error(`task not found: ${taskId}`);
    const task = JSON.parse(readFileSync(taskPath, "utf8")) as unknown;
    const control = await controlTasks().readControl(taskId);
    return { task, control: control.ok ? control.value : undefined };
  }

  async gateStatus(taskId: string): Promise<unknown> {
    const evidence = await this.evidence(taskId) as Array<{ kind?: string }>;
    return { taskId, gates: evidence.filter((row) => row.kind?.startsWith("tdd.") || row.kind?.startsWith("gate.")) };
  }

  async evidence(taskId: string): Promise<unknown> {
    const events: unknown[] = [];
    if (!existsSync(dataPaths.evidence())) return events;
    for (const file of readdirSync(dataPaths.evidence()).filter((name) => name.endsWith(".jsonl"))) {
      for (const line of readFileSync(join(dataPaths.evidence(), file), "utf8").split(/\r?\n/)) {
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

  async doctorTools(): Promise<unknown> {
    const capabilities = await CapabilityReadinessRegistry.defaults({ env: this.options.env ?? process.env })
      .inspectAll({ cwd: this.options.cwd ?? process.cwd(), harnessTier: "standard" });
    return {
      healthy: capabilities.every((item) => item.status !== "Unavailable"),
      needsSetup: capabilities.filter((item) => item.status === "NeedsSetup").map((item) => item.capabilityId),
      capabilities,
    };
  }

  async searchTools(query = ""): Promise<unknown> {
    const rows = await CapabilityReadinessRegistry.defaults({ env: this.options.env ?? process.env })
      .inspectAll({ cwd: this.options.cwd ?? process.cwd(), harnessTier: "standard" });
    const normalized = query.trim().toLowerCase();
    return rows.filter((row) => normalized === "" || `${row.capabilityId} ${row.summary}`.toLowerCase().includes(normalized));
  }
}
