import { describe, expect, it, vi } from "vitest";
import {
  CONTROL_EXIT,
  CONTROL_HELP,
  executeControlCommand,
  type ControlDriver,
  type ControlEvent,
} from "../../src/control/index.ts";

function driver(overrides: Partial<ControlDriver> = {}): ControlDriver {
  return {
    async *run() {
      yield { version: 1, kind: "assistant.delta", payload: { text: "hello" } };
      yield { version: 1, kind: "run.completed", payload: { sessionId: "s-1" } };
    },
    createSession: vi.fn(async () => ({ sessionId: "s-1", sessionFile: "C:/sessions/s-1.jsonl" })),
    resumeSession: vi.fn(async (session) => ({ sessionId: session, sessionFile: session })),
    async *send() {
      yield { version: 1, kind: "run.completed", payload: { sessionId: "s-1" } };
    },
    async *events() {
      yield { version: 1, kind: "session.event", payload: { id: "e-1" } };
    },
    cancelTask: vi.fn(async () => ({ taskId: "t-1", cancelled: true })),
    waitTask: vi.fn(async () => ({ taskId: "t-1", state: "completed" })),
    taskStatus: vi.fn(async () => ({ taskId: "t-1", state: "running" })),
    harnessTier: vi.fn(async () => "simple"),
    setHarnessTier: vi.fn(async (_session, tier) => tier),
    async *importAccount() {
      yield { version: 1, kind: "account.import.ready", payload: { url: "http://127.0.0.1/once" } };
      yield { version: 1, kind: "account.import.completed", payload: { status: "cancelled" } };
    },
    gateStatus: vi.fn(async () => ({ taskId: "t-1", gates: [] })),
    evidence: vi.fn(async () => []),
    doctor: vi.fn(async () => ({ healthy: true, checks: [] })),
    permissionTier: vi.fn(async () => "auto"),
    setPermissionTier: vi.fn(async (_session, tier) => tier),
    listSessions: vi.fn(async () => []),
    listAccounts: vi.fn(async () => []),
    useAccount: vi.fn(async (accountId) => ({ accountId })),
    searchTools: vi.fn(async () => []),
    doctorTools: vi.fn(async () => ({ healthy: true, capabilities: [] })),
    ...overrides,
  };
}

describe("CLI-first Control Interface", () => {
  it("streams a headless run as versioned JSONL without TUI parsing", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const control = driver();

    const exitCode = await executeControlCommand(
      ["run", "--prompt", "hello", "--jsonl", "--non-interactive"],
      { driver: control, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    );

    expect(exitCode).toBe(CONTROL_EXIT.completed);
    expect(stdout.map((line) => JSON.parse(line) as ControlEvent)).toEqual([
      { version: 1, kind: "assistant.delta", payload: { text: "hello" } },
      { version: 1, kind: "run.completed", payload: { sessionId: "s-1" } },
    ]);
    expect(stderr).toEqual([]);
  });

  it("publishes a stable product help contract instead of upstream Pi help", async () => {
    const stdout: string[] = [];
    const exitCode = await executeControlCommand(["--help"], {
      driver: driver(), stdout: (line) => stdout.push(line), stderr: () => undefined,
    });

    expect(exitCode).toBe(CONTROL_EXIT.completed);
    expect(stdout.join("\n")).toBe(CONTROL_HELP);
    expect(CONTROL_HELP).toContain("picode rpc");
    expect(CONTROL_HELP).toContain("picode tools doctor");
  });

  it("maps a non-interactive approval request to a stable exit code", async () => {
    const stdout: string[] = [];
    const control = driver({
      async *run() {
        yield {
          version: 1,
          kind: "approval.required",
          payload: { reason: "command requires confirmation" },
        };
      },
    });

    const exitCode = await executeControlCommand(
      ["run", "--prompt", "deploy", "--jsonl", "--non-interactive"],
      { driver: control, stdout: (line) => stdout.push(line), stderr: () => undefined },
    );

    expect(exitCode).toBe(CONTROL_EXIT.approvalRequired);
    expect(JSON.parse(stdout[0] ?? "{}")).toMatchObject({
      version: 1,
      kind: "approval.required",
    });
  });

  it("creates a named session through the same machine contract", async () => {
    const stdout: string[] = [];
    const control = driver();

    const exitCode = await executeControlCommand(
      ["session", "create", "--id", "s-1", "--cwd", "C:/repo", "--json"],
      { driver: control, stdout: (line) => stdout.push(line), stderr: () => undefined },
    );

    expect(exitCode).toBe(CONTROL_EXIT.completed);
    expect(control.createSession).toHaveBeenCalledWith({ id: "s-1", cwd: "C:/repo" });
    expect(JSON.parse(stdout[0] ?? "{}")).toEqual({
      version: 1,
      kind: "session.created",
      payload: { sessionId: "s-1", sessionFile: "C:/sessions/s-1.jsonl" },
    });
  });

  it("gets and sets the harness tier for a session", async () => {
    const stdout: string[] = [];
    const control = driver();
    const io = { driver: control, stdout: (line: string) => stdout.push(line), stderr: () => undefined };

    expect(await executeControlCommand(["harness", "get", "--session", "s-1"], io)).toBe(0);
    expect(await executeControlCommand(
      ["harness", "set", "--session", "s-1", "--tier", "tdd"],
      io,
    )).toBe(0);
    expect(control.harnessTier).toHaveBeenCalledWith("s-1");
    expect(control.setHarnessTier).toHaveBeenCalledWith("s-1", "tdd");
  });

  it("gets and sets the permission tier through the session authority", async () => {
    const stdout: string[] = [];
    const control = driver();
    const io = { driver: control, stdout: (line: string) => stdout.push(line), stderr: () => undefined };

    expect(await executeControlCommand(["permissions", "get", "--session", "s-1"], io)).toBe(0);
    expect(await executeControlCommand(["permissions", "set", "--session", "s-1", "--tier", "full"], io)).toBe(0);
    expect(control.permissionTier).toHaveBeenCalledWith("s-1");
    expect(control.setPermissionTier).toHaveBeenCalledWith("s-1", "full");
  });

  it("reports tool readiness independently from the general doctor", async () => {
    const stdout: string[] = [];
    const control = driver();
    const io = { driver: control, stdout: (line: string) => stdout.push(line), stderr: () => undefined };

    expect(await executeControlCommand(["doctor", "tools"], io)).toBe(0);
    expect(control.doctorTools).toHaveBeenCalledOnce();
    expect(JSON.parse(stdout[0] ?? "{}").kind).toBe("tools.doctor");
  });

  it("waits for a task and exposes the account Web Wizard as JSONL", async () => {
    const stdout: string[] = [];
    const control = driver();
    const io = { driver: control, stdout: (line: string) => stdout.push(line), stderr: () => undefined };

    expect(await executeControlCommand(["task", "wait", "--task", "t-1"], io)).toBe(0);
    expect(await executeControlCommand(["account", "import"], io)).toBe(0);
    expect(control.waitTask).toHaveBeenCalledWith("t-1", undefined);
    expect(stdout.some((line) => line.includes("account.import.ready"))).toBe(true);
  });
});
