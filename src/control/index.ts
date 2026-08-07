export const CONTROL_EXIT = {
  completed: 0,
  gateFailed: 2,
  approvalRequired: 3,
  timeout: 4,
  cancelled: 5,
  usage: 64,
  internal: 70,
} as const;

export interface ControlEvent {
  version: 1;
  kind: string;
  payload: unknown;
}

export interface SessionIdentity {
  sessionId: string;
  sessionFile?: string;
}

export interface ControlDriver {
  run(input: {
    prompt: string;
    cwd?: string;
    session?: string;
    provider?: string;
    model?: string;
    nonInteractive: boolean;
  }): AsyncIterable<ControlEvent>;
  createSession(input: { id?: string; cwd?: string }): Promise<SessionIdentity>;
  resumeSession(session: string): Promise<SessionIdentity>;
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
  importAccount(): AsyncIterable<ControlEvent>;
  gateStatus(taskId: string): Promise<unknown>;
  evidence(taskId: string): Promise<unknown>;
  doctor(): Promise<unknown>;
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

/** Public CLI seam. All product behavior stays behind ControlDriver. */
export async function executeControlCommand(
  argv: readonly string[],
  io: ControlIo,
): Promise<number> {
  const parsed = parseArgs(argv);
  const [subject, action] = parsed.positionals;
  try {
    if (subject === "run") {
      const prompt = required(stringFlag(parsed, "--prompt"), "--prompt");
      const cwd = stringFlag(parsed, "--cwd");
      const session = stringFlag(parsed, "--session");
      const provider = stringFlag(parsed, "--provider");
      const model = stringFlag(parsed, "--model");
      return emitStream(io.driver.run({
        prompt,
        ...(cwd === undefined ? {} : { cwd }),
        ...(session === undefined ? {} : { session }),
        ...(provider === undefined ? {} : { provider }),
        ...(model === undefined ? {} : { model }),
        nonInteractive: parsed.flags.has("--non-interactive"),
      }), io);
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
    if (subject === "account" && action === "import") {
      return emitStream(io.driver.importAccount(), io);
    }
    if (subject === "doctor") {
      emitJson(io, event("doctor.result", await io.driver.doctor()));
      return CONTROL_EXIT.completed;
    }

    io.stderr("usage: picode run|session|task|gate|harness|account|doctor [options]");
    return CONTROL_EXIT.usage;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    io.stderr(message);
    return message.startsWith("missing ") ? CONTROL_EXIT.usage : CONTROL_EXIT.internal;
  }
}
