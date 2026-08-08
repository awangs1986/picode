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
    switchSession: vi.fn(async (session) => ({ sessionId: session, sessionFile: session })),
    branchSession: vi.fn(async (_session, from) => ({ sessionId: "branched", from })),
    subagentStatus: vi.fn(async () => ({ entries: [] })),
    stopSubagent: vi.fn(async (_session, runId) => ({ runId, state: "stopping" })),
    resumeSubagent: vi.fn(async (_session, runId, message) => ({ runId, message, state: "running" })),
    async *sliceSession() { yield { version: 1, kind: "run.completed", payload: { sessionId: "slice-2" } }; },
    listCapsules: vi.fn(async () => []),
    readCapsule: vi.fn(async (_task, capsule) => ({ capsuleId: capsule })),
    worktreeStatus: vi.fn(async () => ({ writers: [], managed: [] })),
    claimWorktree: vi.fn(async (workspace, task) => ({ workspace, task })),
    releaseWorktree: vi.fn(async (workspace, task) => ({ workspace, task })),
    capabilityStatus: vi.fn(async () => []),
    setCapabilityState: vi.fn(async (id, state) => ({ id, state })),
    previewChats: vi.fn(async () => [{ selectionId: "i-1", title: "Renderer" }]),
    importChats: vi.fn(async () => [{ importId: "i-1", sessionId: "s-imported" }]),
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
  it("rejects unknown options instead of silently changing the requested policy", async () => {
    const stderr: string[] = [];
    const exitCode = await executeControlCommand(
      ["run", "--prompt", "hello", "--permission", "full"],
      { driver: driver(), stdout: () => undefined, stderr: (line) => stderr.push(line) },
    );

    expect(exitCode).toBe(CONTROL_EXIT.usage);
    expect(stderr).toEqual(["unknown option: --permission"]);
  });

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

  it("switches and branches sessions through upstream Pi session semantics", async () => {
    const stdout: string[] = [];
    const control = driver();
    const io = { driver: control, stdout: (line: string) => stdout.push(line), stderr: () => undefined };

    expect(await executeControlCommand(["session", "switch", "--session", "s-1"], io)).toBe(0);
    expect(await executeControlCommand(["session", "branch", "--session", "s-1", "--from", "e-7"], io)).toBe(0);
    expect(control.switchSession).toHaveBeenCalledWith("s-1");
    expect(control.branchSession).toHaveBeenCalledWith("s-1", "e-7");
    expect(stdout.map((line) => JSON.parse(line).kind)).toEqual(["session.switched", "session.branched"]);
  });

  it("exposes pi-subagents status, stop, and resume without asking the model to operate them", async () => {
    const stdout: string[] = [];
    const control = driver();
    const io = { driver: control, stdout: (line: string) => stdout.push(line), stderr: () => undefined };

    expect(await executeControlCommand(["subagent", "status", "--session", "s-1"], io)).toBe(0);
    expect(await executeControlCommand(["subagent", "stop", "--session", "s-1", "--run", "r-1"], io)).toBe(0);
    expect(await executeControlCommand(["subagent", "resume", "--session", "s-1", "--run", "r-1", "--message", "continue"], io)).toBe(0);
    expect(control.subagentStatus).toHaveBeenCalledWith("s-1", undefined);
    expect(control.stopSubagent).toHaveBeenCalledWith("s-1", "r-1");
    expect(control.resumeSubagent).toHaveBeenCalledWith("s-1", "r-1", "continue");
    expect(stdout.map((line) => JSON.parse(line).kind)).toEqual([
      "subagent.status", "subagent.stopping", "subagent.resumed",
    ]);
  });

  it("exposes Slice/Capsule, Worktree ownership, and Tier-3 capability acceptance paths", async () => {
    const stdout: string[] = [];
    const control = driver();
    const io = { driver: control, stdout: (line: string) => stdout.push(line), stderr: () => undefined };

    expect(await executeControlCommand(["slice", "create", "--session", "s-1", "--intent", "next module"], io)).toBe(0);
    expect(await executeControlCommand(["capsule", "list", "--task", "t-1"], io)).toBe(0);
    expect(await executeControlCommand(["capsule", "read", "--task", "t-1", "--capsule", "c-1"], io)).toBe(0);
    expect(await executeControlCommand(["worktree", "claim", "--workspace", "C:/repo", "--task", "t-1"], io)).toBe(0);
    expect(await executeControlCommand(["worktree", "release", "--workspace", "C:/repo", "--task", "t-1"], io)).toBe(0);
    expect(await executeControlCommand(["capability", "set", "--id", "herdr", "--state", "trusted"], io)).toBe(0);
    expect(control.setCapabilityState).toHaveBeenCalledWith("herdr", "trusted");
    expect(stdout.some((line) => line.includes("capsule.list"))).toBe(true);
  });

  it("previews foreign chats and imports only explicitly selected candidates", async () => {
    const stdout: string[] = [];
    const control = driver();
    const io = { driver: control, stdout: (line: string) => stdout.push(line), stderr: () => undefined };
    expect(await executeControlCommand(["chat", "preview", "--source", "codex", "--path", "C:/history"], io)).toBe(0);
    expect(await executeControlCommand(["chat", "import", "--source", "codex", "--path", "C:/history", "--select", "i-1", "--workspace", "C:/repo"], io)).toBe(0);
    expect(control.previewChats).toHaveBeenCalledWith("codex", "C:/history");
    expect(control.importChats).toHaveBeenCalledWith("codex", "C:/history", ["i-1"], "C:/repo");
    expect(stdout.map((line) => JSON.parse(line).kind)).toEqual(["chat.preview", "chat.imported"]);
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
    expect(control.doctorTools).toHaveBeenCalledWith({});
    expect(JSON.parse(stdout[0] ?? "{}").kind).toBe("tools.doctor");
  });

  it("passes workspace and harness context to tools doctor", async () => {
    const control = driver();
    const stdout: string[] = [];
    const code = await executeControlCommand([
      "tools", "doctor", "--cwd", "fixture-project", "--harness", "tdd",
    ], { driver: control, stdout: (line: string) => stdout.push(line), stderr: () => undefined });
    expect(code).toBe(0);
    expect(control.doctorTools).toHaveBeenCalledWith({ cwd: "fixture-project", harnessTier: "tdd" });
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
