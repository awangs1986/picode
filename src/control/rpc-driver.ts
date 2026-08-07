import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  RpcClient,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import open from "open";
import { dataPaths, piAgentDir, piSessionsDir, picodeDir } from "../shared/paths.ts";
import type { ControlDriver, ControlEvent, SessionIdentity } from "./index.ts";
import { TaskIngress } from "../devloop/index.ts";
import { StateFile } from "../store/state-file.ts";
import { AccountsManager } from "../store/accounts.ts";
import { HARNESS_ENTRY_TYPE, restoreHarnessTier } from "../extension/harness.ts";
import { startAccountImportWizard } from "../extension/account-import-wizard.ts";

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

async function resolveSession(value: string): Promise<SessionIdentity> {
  const direct = isAbsolute(value) ? value : resolve(value);
  if (existsSync(direct)) return sessionIdentity(SessionManager.open(direct, piSessionsDir()));
  const all = await SessionManager.listAll(piSessionsDir());
  const matches = all.filter((session) => session.id === value || session.id.startsWith(value));
  if (matches.length !== 1) {
    throw new Error(matches.length === 0 ? `session not found: ${value}` : `session id is ambiguous: ${value}`);
  }
  const match = matches[0];
  if (match === undefined) throw new Error(`session not found: ${value}`);
  return { sessionId: match.id, sessionFile: match.path };
}

interface DriverOptions {
  packageRoot: string;
  piEntry: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export class RpcControlDriver implements ControlDriver {
  constructor(private readonly options: DriverOptions) {}

  private client(input: { cwd?: string; session?: string; provider?: string; model?: string } = {}): RpcClient {
    const extension = join(this.options.packageRoot, "src", "extension", "pi-entry.ts");
    const args = ["--extension", extension, "--session-dir", piSessionsDir()];
    if (input.session !== undefined) args.push("--session", input.session);
    return new RpcClient({
      cliPath: this.options.piEntry,
      cwd: input.cwd ?? this.options.cwd ?? process.cwd(),
      env: {
        ...this.options.env,
        PICODE_DIR: picodeDir(),
        PICODE_PACKAGE_ROOT: this.options.packageRoot,
        PI_CODING_AGENT_DIR: piAgentDir(),
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
  }): AsyncIterable<ControlEvent> {
    const client = this.client(input);
    const queue = new EventQueue();
    let approvalRequired = false;
    const unsubscribe = client.onEvent((raw) => {
      if (isUiApproval(raw)) {
        approvalRequired = true;
        queue.push(asEvent("approval.required", raw));
      } else {
        queue.push(asEvent(eventKind(raw), raw));
      }
    });
    const execute = (async () => {
      try {
        await client.start();
        await client.prompt(input.prompt);
        if (input.nonInteractive) {
          const started = Date.now();
          while (!approvalRequired) {
            const state = await client.getState();
            if (!state.isStreaming && state.pendingMessageCount === 0) break;
            if (Date.now() - started > 600_000) throw new Error("Timeout waiting for headless run");
            await new Promise((resolveWait) => setTimeout(resolveWait, 25));
          }
          if (approvalRequired) await client.abort().catch(() => undefined);
        } else {
          await client.waitForIdle(600_000);
        }
        if (!approvalRequired) {
          const state = await client.getState();
          queue.push(asEvent("run.completed", {
            sessionId: state.sessionId,
            sessionFile: state.sessionFile,
            text: await client.getLastAssistantText(),
          }));
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        queue.push(asEvent(/timeout/i.test(message) ? "run.timeout" : "run.error", { message }));
      } finally {
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

  async createSession(input: { id?: string; cwd?: string }): Promise<SessionIdentity> {
    mkdirSync(piSessionsDir(), { recursive: true });
    return sessionIdentity(SessionManager.create(input.cwd ?? this.options.cwd ?? process.cwd(), piSessionsDir(), {
      ...(input.id === undefined ? {} : { id: input.id }),
    }));
  }

  resumeSession(session: string): Promise<SessionIdentity> {
    return resolveSession(session);
  }

  async *send(input: { session: string; message: string; nonInteractive: boolean }): AsyncIterable<ControlEvent> {
    const identity = await resolveSession(input.session);
    if (identity.sessionFile === undefined) throw new Error(`session has no persistent file: ${input.session}`);
    yield* this.run({
      prompt: input.message,
      session: identity.sessionFile,
      nonInteractive: input.nonInteractive,
    });
  }

  async *events(input: { session: string; since?: string }): AsyncIterable<ControlEvent> {
    const identity = await resolveSession(input.session);
    if (identity.sessionFile === undefined) return;
    const manager = SessionManager.open(identity.sessionFile, piSessionsDir());
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
    const identity = await resolveSession(session);
    if (identity.sessionFile === undefined) throw new Error(`session has no persistent file: ${session}`);
    return SessionManager.open(identity.sessionFile, piSessionsDir());
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
      { name: "agent-dir", ok: true, path: piAgentDir() },
    ];
    return { healthy: checks.every((check) => check.ok), checks };
  }
}
