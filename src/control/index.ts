export const CONTROL_EXIT = {
  completed: 0,
  gateFailed: 2,
  approvalRequired: 3,
  timeout: 4,
  cancelled: 5,
  usage: 64,
  internal: 70,
} as const;

export const CONTROL_HELP = `Picode — lightweight Pi development harness

Usage:
  picode                         Start the upstream Pi TUI
  picode tui [pi options]        Start Pi explicitly
  picode run [options]           Run one headless turn
  picode rpc                     Serve versioned NDJSON on stdin/stdout
  picode serve [options]         Start the trusted-LAN Picode Remote Host
  picode session <action>        List, create, resume, switch, branch, send, or read events
  picode subagent <action>       Inspect, stop, or resume pi-subagents runs
  picode slice create            Seal a Capsule and continue in a fresh session
  picode capsule <action>        List or read sealed task Capsules
  picode worktree <action>       Inspect, claim, or release workspace write ownership
  picode capability <action>     Inspect or change user-owned capability state
  picode chat preview|import     Preview and selectively import foreign chats
  picode task <action>           Inspect, wait for, or cancel a task
  picode gate <action>           Inspect gate status or evidence
  picode harness get|set         Read or change the session harness tier
  picode permissions get|set     Read or change the session permission tier
  picode account <action>        List, use, or import accounts
  picode tools doctor            Inspect capability readiness
  picode tools search            Discover available tools
  picode doctor [tools]          Diagnose the installation

Run "picode <subject> --help" for machine-command options. Output is JSON/JSONL.`;

export interface ControlEvent {
  version: 1;
  kind: string;
  payload: unknown;
}

export interface SessionIdentity {
  sessionId: string;
  sessionFile?: string;
}

export interface ControlImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ControlDriver {
  run(input: {
    prompt: string;
    images?: ControlImage[];
    cwd?: string;
    session?: string;
    provider?: string;
    model?: string;
    nonInteractive: boolean;
    timeoutMs?: number;
    permissionTier?: "readonly" | "auto" | "full" | "danger-full-access";
    harnessTier?: "simple" | "standard" | "tdd";
  }): AsyncIterable<ControlEvent>;
  respondApproval?(requestId: string, action: "once" | "session" | "session-full" | "deny"): Promise<unknown>;
  cancelRun?(runId: string): Promise<unknown>;
  steerRun?(runId: string, message: string): Promise<unknown>;
  createSession(input: { id?: string; cwd?: string }): Promise<SessionIdentity>;
  listSessions(): Promise<unknown>;
  resumeSession(session: string): Promise<SessionIdentity>;
  switchSession(session: string): Promise<SessionIdentity>;
  branchSession(session: string, from: string): Promise<SessionIdentity & { from: string }>;
  subagentStatus(session: string, runId?: string): Promise<unknown>;
  stopSubagent(session: string, runId: string): Promise<unknown>;
  resumeSubagent(session: string, runId: string, message: string): Promise<unknown>;
  sliceSession(session: string, intent: string): AsyncIterable<ControlEvent>;
  listCapsules(taskId: string): Promise<unknown>;
  readCapsule(taskId: string, capsuleId: string): Promise<unknown>;
  worktreeStatus(): Promise<unknown>;
  claimWorktree(workspace: string, taskId: string): Promise<unknown>;
  releaseWorktree(workspace: string, taskId: string): Promise<unknown>;
  capabilityStatus(): Promise<unknown>;
  setCapabilityState(capabilityId: string, state: "disabled" | "enabled" | "trusted"): Promise<unknown>;
  previewChats(source: string, path: string): Promise<unknown>;
  importChats(source: string, path: string, selectionIds: string[], workspace: string): Promise<unknown>;
  send(input: {
    session: string;
    message: string;
    nonInteractive: boolean;
  }): AsyncIterable<ControlEvent>;
  events(input: { session: string; since?: string }): AsyncIterable<ControlEvent>;
  cancelTask(taskId: string): Promise<unknown>;
  waitTask(taskId: string, timeoutMs?: number): Promise<unknown>;
  taskStatus(taskId: string): Promise<unknown>;
  harnessTier(session: string): Promise<string>;
  setHarnessTier(session: string, tier: "simple" | "standard" | "tdd"): Promise<string>;
  permissionTier(session: string): Promise<string>;
  setPermissionTier(session: string, tier: "readonly" | "auto" | "full" | "danger-full-access"): Promise<string>;
  sessionModelState?(session: string): Promise<unknown>;
  setSessionModel?(session: string, provider: string, modelId: string): Promise<unknown>;
  setSessionThinking?(session: string, level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): Promise<unknown>;
  importAccount(): AsyncIterable<ControlEvent>;
  listAccounts(): Promise<unknown>;
  useAccount(accountId: string): Promise<unknown>;
  gateStatus(taskId: string): Promise<unknown>;
  evidence(taskId: string): Promise<unknown>;
  doctor(): Promise<unknown>;
  searchTools(query?: string): Promise<unknown>;
  doctorTools(input?: { cwd?: string; harnessTier?: "simple" | "standard" | "tdd" }): Promise<unknown>;
}

export interface ControlIo {
  driver: ControlDriver;
  stdout(line: string): void;
  stderr(line: string): void;
}

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

const CONTROL_OPTIONS = new Set([
  "--account", "--capsule", "--cwd", "--from", "--harness", "--help", "--id",
  "--intent", "--json", "--jsonl", "--message", "--model", "--non-interactive",
  "--path", "--permissions", "--prompt", "--provider", "--query", "--run", "--select",
  "--session", "--since", "--source", "--state", "--task", "--tier", "--timeout-ms",
  "--workspace",
]);

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === undefined) continue;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const [name, inline] = value.split("=", 2);
    if (name === undefined) continue;
    if (inline !== undefined) {
      flags.set(name, inline);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { positionals, flags };
}

function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function event(kind: string, payload: unknown): ControlEvent {
  return { version: 1, kind, payload };
}

function emitJson(io: ControlIo, value: ControlEvent): void {
  io.stdout(JSON.stringify(value));
}

async function emitStream(
  stream: AsyncIterable<ControlEvent>,
  io: ControlIo,
): Promise<number> {
  let exitCode: number = CONTROL_EXIT.completed;
  for await (const item of stream) {
    emitJson(io, item);
    if (item.kind === "approval.required") exitCode = CONTROL_EXIT.approvalRequired;
    else if (item.kind === "gate.failed") exitCode = CONTROL_EXIT.gateFailed;
    else if (item.kind === "run.timeout") exitCode = CONTROL_EXIT.timeout;
    else if (item.kind === "run.cancelled") exitCode = CONTROL_EXIT.cancelled;
    else if (item.kind === "run.error") exitCode = CONTROL_EXIT.internal;
  }
  return exitCode;
}

function required(value: string | undefined, label: string): string {
  if (value === undefined || value.trim() === "") throw new Error(`missing ${label}`);
  return value;
}

const SUBJECT_HELP: Record<string, string> = {
  run: "Usage: picode run --prompt <text> [--cwd <dir>] [--session <id>] [--harness simple|standard|tdd] [--permissions readonly|auto|full|danger-full-access] [--timeout-ms <ms>] [--non-interactive]",
  serve: "Usage: picode serve [--bind <ipv4>] [--port <port>] [--name <name>] [--workspace <dir>] [--no-qr]",
  rpc: `Usage: picode rpc

Serve versioned NDJSON requests on stdin and stream correlated events on stdout.

Methods:
  run.start         params: prompt, cwd?, session?, harnessTier?, permissionTier?, timeoutMs?
  approval.respond  params: requestId, action=once|session|session-full|deny
  run.cancel        params: runId
  command.execute   params: argv[]`,
  session: "Usage: picode session list|create|resume|switch|branch|send|events [options]",
  subagent: "Usage: picode subagent status|stop|resume --session <id> [--run <id>] [--message <text>]",
  slice: "Usage: picode slice create --session <id> --intent <text>",
  capsule: "Usage: picode capsule list|read --task <id> [--capsule <id>]",
  worktree: "Usage: picode worktree status|claim|release [--workspace <path> --task <id>]",
  capability: "Usage: picode capability status|set [--id <id> --state disabled|enabled|trusted]",
  chat: "Usage: picode chat preview|import --source claude-code|codex|cursor --path <file-or-directory> [--select <id,id> --workspace <path>]",
  task: "Usage: picode task status|wait|cancel --task <id> [options]",
  gate: "Usage: picode gate status|evidence --task <id>",
  harness: "Usage: picode harness get|set --session <id> [--tier simple|standard|tdd]",
  permissions: "Usage: picode permissions get|set --session <id> [--tier readonly|auto|full|danger-full-access]",
  account: "Usage: picode account list|use|import [options]",
  tools: "Usage: picode tools doctor [--cwd <dir>] [--harness simple|standard|tdd] | picode tools search [--query <text>]",
  doctor: "Usage: picode doctor [tools]",
};

/** Public CLI seam. All product behavior stays behind ControlDriver. */
export async function executeControlCommand(
  argv: readonly string[],
  io: ControlIo,
): Promise<number> {
  const parsed = parseArgs(argv);
  const [subject, action] = parsed.positionals;
  try {
    const unknownOption = [...parsed.flags.keys()].find((name) => !CONTROL_OPTIONS.has(name));
    if (unknownOption !== undefined) throw new Error(`unknown option: ${unknownOption}`);
    if (subject === "help" || parsed.flags.has("--help") || action === "-h") {
      io.stdout(subject !== undefined && SUBJECT_HELP[subject] !== undefined
        ? SUBJECT_HELP[subject]
        : CONTROL_HELP);
      return CONTROL_EXIT.completed;
    }
    if (subject === "run") {
      const prompt = required(stringFlag(parsed, "--prompt"), "--prompt");
      const cwd = stringFlag(parsed, "--cwd");
      const session = stringFlag(parsed, "--session");
      const provider = stringFlag(parsed, "--provider");
      const model = stringFlag(parsed, "--model");
      const rawTimeout = stringFlag(parsed, "--timeout-ms");
      const timeoutMs = rawTimeout === undefined ? undefined : Number(rawTimeout);
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new Error("invalid --timeout-ms");
      const permissionTier = stringFlag(parsed, "--permissions");
      if (permissionTier !== undefined && permissionTier !== "readonly" && permissionTier !== "auto" && permissionTier !== "full" && permissionTier !== "danger-full-access") throw new Error(`invalid permission tier: ${permissionTier}`);
      const harnessTier = stringFlag(parsed, "--harness");
      if (harnessTier !== undefined && harnessTier !== "simple" && harnessTier !== "standard" && harnessTier !== "tdd") throw new Error(`invalid harness tier: ${harnessTier}`);
      return emitStream(io.driver.run({
        prompt,
        ...(cwd === undefined ? {} : { cwd }),
        ...(session === undefined ? {} : { session }),
        ...(provider === undefined ? {} : { provider }),
        ...(model === undefined ? {} : { model }),
        nonInteractive: parsed.flags.has("--non-interactive"),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(permissionTier === undefined ? {} : { permissionTier }),
        ...(harnessTier === undefined ? {} : { harnessTier }),
      }), io);
    }

    if (subject === "session" && action === "list") {
      emitJson(io, event("session.list", await io.driver.listSessions()));
      return CONTROL_EXIT.completed;
    }

    if (subject === "session" && action === "create") {
      const id = stringFlag(parsed, "--id");
      const cwd = stringFlag(parsed, "--cwd");
      const identity = await io.driver.createSession({
        ...(id === undefined ? {} : { id }),
        ...(cwd === undefined ? {} : { cwd }),
      });
      emitJson(io, event("session.created", identity));
      return CONTROL_EXIT.completed;
    }

    if (subject === "session" && action === "resume") {
      const identity = await io.driver.resumeSession(required(stringFlag(parsed, "--session"), "--session"));
      emitJson(io, event("session.resumed", identity));
      return CONTROL_EXIT.completed;
    }

    if (subject === "session" && action === "switch") {
      const identity = await io.driver.switchSession(required(stringFlag(parsed, "--session"), "--session"));
      emitJson(io, event("session.switched", identity));
      return CONTROL_EXIT.completed;
    }

    if (subject === "session" && action === "branch") {
      const identity = await io.driver.branchSession(
        required(stringFlag(parsed, "--session"), "--session"),
        required(stringFlag(parsed, "--from"), "--from"),
      );
      emitJson(io, event("session.branched", identity));
      return CONTROL_EXIT.completed;
    }

    if (subject === "subagent" && action === "status") {
      const session = required(stringFlag(parsed, "--session"), "--session");
      emitJson(io, event("subagent.status", await io.driver.subagentStatus(session, stringFlag(parsed, "--run"))));
      return CONTROL_EXIT.completed;
    }
    if (subject === "subagent" && action === "stop") {
      const session = required(stringFlag(parsed, "--session"), "--session");
      const runId = required(stringFlag(parsed, "--run"), "--run");
      emitJson(io, event("subagent.stopping", await io.driver.stopSubagent(session, runId)));
      return CONTROL_EXIT.completed;
    }
    if (subject === "subagent" && action === "resume") {
      const session = required(stringFlag(parsed, "--session"), "--session");
      const runId = required(stringFlag(parsed, "--run"), "--run");
      const message = required(stringFlag(parsed, "--message"), "--message");
      emitJson(io, event("subagent.resumed", await io.driver.resumeSubagent(session, runId, message)));
      return CONTROL_EXIT.completed;
    }

    if (subject === "slice" && action === "create") {
      return emitStream(io.driver.sliceSession(
        required(stringFlag(parsed, "--session"), "--session"),
        required(stringFlag(parsed, "--intent"), "--intent"),
      ), io);
    }
    if (subject === "capsule" && action === "list") {
      emitJson(io, event("capsule.list", await io.driver.listCapsules(required(stringFlag(parsed, "--task"), "--task"))));
      return CONTROL_EXIT.completed;
    }
    if (subject === "capsule" && action === "read") {
      emitJson(io, event("capsule.read", await io.driver.readCapsule(
        required(stringFlag(parsed, "--task"), "--task"),
        required(stringFlag(parsed, "--capsule"), "--capsule"),
      )));
      return CONTROL_EXIT.completed;
    }
    if (subject === "worktree" && action === "status") {
      emitJson(io, event("worktree.status", await io.driver.worktreeStatus()));
      return CONTROL_EXIT.completed;
    }
    if (subject === "worktree" && (action === "claim" || action === "release")) {
      const workspace = required(stringFlag(parsed, "--workspace"), "--workspace");
      const taskId = required(stringFlag(parsed, "--task"), "--task");
      const payload = action === "claim"
        ? await io.driver.claimWorktree(workspace, taskId)
        : await io.driver.releaseWorktree(workspace, taskId);
      emitJson(io, event(action === "claim" ? "worktree.claimed" : "worktree.released", payload));
      return CONTROL_EXIT.completed;
    }
    if (subject === "capability" && action === "status") {
      emitJson(io, event("capability.status", await io.driver.capabilityStatus()));
      return CONTROL_EXIT.completed;
    }
    if (subject === "capability" && action === "set") {
      const id = required(stringFlag(parsed, "--id"), "--id");
      const state = required(stringFlag(parsed, "--state"), "--state");
      if (state !== "disabled" && state !== "enabled" && state !== "trusted") throw new Error(`invalid capability state: ${state}`);
      emitJson(io, event("capability.changed", await io.driver.setCapabilityState(id, state)));
      return CONTROL_EXIT.completed;
    }
    if (subject === "chat" && action === "preview") {
      emitJson(io, event("chat.preview", await io.driver.previewChats(
        required(stringFlag(parsed, "--source"), "--source"),
        required(stringFlag(parsed, "--path"), "--path"),
      )));
      return CONTROL_EXIT.completed;
    }
    if (subject === "chat" && action === "import") {
      const selected = required(stringFlag(parsed, "--select"), "--select").split(",").map((id) => id.trim()).filter(Boolean);
      if (selected.length === 0) throw new Error("invalid --select");
      emitJson(io, event("chat.imported", await io.driver.importChats(
        required(stringFlag(parsed, "--source"), "--source"),
        required(stringFlag(parsed, "--path"), "--path"),
        selected,
        required(stringFlag(parsed, "--workspace"), "--workspace"),
      )));
      return CONTROL_EXIT.completed;
    }

    if (subject === "session" && action === "send") {
      return emitStream(io.driver.send({
        session: required(stringFlag(parsed, "--session"), "--session"),
        message: required(stringFlag(parsed, "--message"), "--message"),
        nonInteractive: parsed.flags.has("--non-interactive"),
      }), io);
    }

    if (subject === "session" && action === "events") {
      const since = stringFlag(parsed, "--since");
      return emitStream(io.driver.events({
        session: required(stringFlag(parsed, "--session"), "--session"),
        ...(since === undefined ? {} : { since }),
      }), io);
    }

    if (subject === "task" && action === "status") {
      const taskId = required(stringFlag(parsed, "--task"), "--task");
      emitJson(io, event("task.status", await io.driver.taskStatus(taskId)));
      return CONTROL_EXIT.completed;
    }
    if (subject === "task" && action === "cancel") {
      const taskId = required(stringFlag(parsed, "--task"), "--task");
      emitJson(io, event("task.cancelled", await io.driver.cancelTask(taskId)));
      return CONTROL_EXIT.completed;
    }
    if (subject === "task" && action === "wait") {
      const taskId = required(stringFlag(parsed, "--task"), "--task");
      const rawTimeout = stringFlag(parsed, "--timeout-ms");
      const timeoutMs = rawTimeout === undefined ? undefined : Number(rawTimeout);
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
        throw new Error("invalid --timeout-ms");
      }
      emitJson(io, event("task.settled", await io.driver.waitTask(taskId, timeoutMs)));
      return CONTROL_EXIT.completed;
    }
    if (subject === "gate" && action === "status") {
      const taskId = required(stringFlag(parsed, "--task"), "--task");
      emitJson(io, event("gate.status", await io.driver.gateStatus(taskId)));
      return CONTROL_EXIT.completed;
    }
    if (subject === "gate" && action === "evidence") {
      const taskId = required(stringFlag(parsed, "--task"), "--task");
      emitJson(io, event("gate.evidence", await io.driver.evidence(taskId)));
      return CONTROL_EXIT.completed;
    }
    if (subject === "harness" && action === "get") {
      const session = required(stringFlag(parsed, "--session"), "--session");
      emitJson(io, event("harness.tier", { session, tier: await io.driver.harnessTier(session) }));
      return CONTROL_EXIT.completed;
    }
    if (subject === "harness" && action === "set") {
      const session = required(stringFlag(parsed, "--session"), "--session");
      const rawTier = required(stringFlag(parsed, "--tier"), "--tier");
      if (rawTier !== "simple" && rawTier !== "standard" && rawTier !== "tdd") {
        throw new Error(`invalid harness tier: ${rawTier}`);
      }
      emitJson(io, event("harness.changed", {
        session,
        tier: await io.driver.setHarnessTier(session, rawTier),
      }));
      return CONTROL_EXIT.completed;
    }
    if (subject === "permissions" && action === "get") {
      const session = required(stringFlag(parsed, "--session"), "--session");
      emitJson(io, event("permissions.tier", { session, tier: await io.driver.permissionTier(session) }));
      return CONTROL_EXIT.completed;
    }
    if (subject === "permissions" && action === "set") {
      const session = required(stringFlag(parsed, "--session"), "--session");
      const tier = required(stringFlag(parsed, "--tier"), "--tier");
      if (tier !== "readonly" && tier !== "auto" && tier !== "full" && tier !== "danger-full-access") throw new Error(`invalid permission tier: ${tier}`);
      emitJson(io, event("permissions.changed", { session, tier: await io.driver.setPermissionTier(session, tier) }));
      return CONTROL_EXIT.completed;
    }
    if (subject === "account" && action === "import") {
      return emitStream(io.driver.importAccount(), io);
    }
    if (subject === "account" && action === "list") {
      emitJson(io, event("account.list", await io.driver.listAccounts()));
      return CONTROL_EXIT.completed;
    }
    if (subject === "account" && action === "use") {
      emitJson(io, event("account.active", await io.driver.useAccount(required(stringFlag(parsed, "--account"), "--account"))));
      return CONTROL_EXIT.completed;
    }
    if (subject === "tools" && action === "search") {
      emitJson(io, event("tools.search", await io.driver.searchTools(stringFlag(parsed, "--query"))));
      return CONTROL_EXIT.completed;
    }
    if ((subject === "tools" && action === "doctor") || (subject === "doctor" && action === "tools")) {
      const cwd = stringFlag(parsed, "--cwd");
      const harnessTier = stringFlag(parsed, "--harness");
      if (harnessTier !== undefined && harnessTier !== "simple" && harnessTier !== "standard" && harnessTier !== "tdd") {
        throw new Error(`invalid harness tier: ${harnessTier}`);
      }
      emitJson(io, event("tools.doctor", await io.driver.doctorTools({
        ...(cwd === undefined ? {} : { cwd }),
        ...(harnessTier === undefined ? {} : { harnessTier }),
      })));
      return CONTROL_EXIT.completed;
    }
    if (subject === "doctor" && action === undefined) {
      emitJson(io, event("doctor.result", await io.driver.doctor()));
      return CONTROL_EXIT.completed;
    }

    io.stderr(CONTROL_HELP);
    return CONTROL_EXIT.usage;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    io.stderr(message);
    return message.startsWith("missing ") || message.startsWith("invalid ") || message.startsWith("unknown option:")
      ? CONTROL_EXIT.usage
      : CONTROL_EXIT.internal;
  }
}
