import { describe, expect, it, vi } from "vitest";
import { ControlRpcServer } from "../../src/control/rpc-server.ts";
import type { ControlDriver } from "../../src/control/index.ts";

function rpcDriver(): ControlDriver {
  return {
    async *run() {
      yield { version: 1, kind: "approval.required", payload: { id: "ui-1" } };
      yield { version: 1, kind: "run.completed", payload: { runId: "run-1" } };
    },
    respondApproval: vi.fn(async () => ({ accepted: true })),
    cancelRun: vi.fn(async () => ({ cancelled: true })),
    createSession: vi.fn(), resumeSession: vi.fn(), switchSession: vi.fn(), branchSession: vi.fn(),
    subagentStatus: vi.fn(), stopSubagent: vi.fn(), resumeSubagent: vi.fn(), send: vi.fn(), events: vi.fn(),
    sliceSession: vi.fn(), listCapsules: vi.fn(), readCapsule: vi.fn(), worktreeStatus: vi.fn(),
    claimWorktree: vi.fn(), releaseWorktree: vi.fn(), capabilityStatus: vi.fn(), setCapabilityState: vi.fn(),
    previewChats: vi.fn(), importChats: vi.fn(),
    listSessions: vi.fn(async () => []), cancelTask: vi.fn(), waitTask: vi.fn(), taskStatus: vi.fn(),
    harnessTier: vi.fn(), setHarnessTier: vi.fn(), permissionTier: vi.fn(), setPermissionTier: vi.fn(),
    importAccount: vi.fn(), listAccounts: vi.fn(async () => []), useAccount: vi.fn(),
    gateStatus: vi.fn(), evidence: vi.fn(), doctor: vi.fn(), searchTools: vi.fn(), doctorTools: vi.fn(),
  } as unknown as ControlDriver;
}

describe("versioned Control RPC", () => {
  it("correlates streaming run events and accepts approval responses on stdin only", async () => {
    const output: unknown[] = [];
    const driver = rpcDriver();
    const server = new ControlRpcServer(driver, (message) => output.push(message));

    await server.receive({ version: 1, id: "r1", method: "run.start", params: { prompt: "x" } });
    await server.settle();
    await server.receive({ version: 1, id: "a1", method: "approval.respond", params: { requestId: "ui-1", action: "once" } });

    expect(output).toContainEqual(expect.objectContaining({ version: 1, id: "r1", event: "approval.required" }));
    expect(output).toContainEqual(expect.objectContaining({ version: 1, id: "a1", result: { accepted: true } }));
    expect(driver.respondApproval).toHaveBeenCalledWith("ui-1", "once");
  });

  it("accepts an explicit no-prompt approval response", async () => {
    const output: unknown[] = [];
    const driver = rpcDriver();
    const server = new ControlRpcServer(driver, (message) => output.push(message));

    await server.receive({
      version: 1,
      id: "unrestricted",
      method: "approval.respond",
      params: { requestId: "ui-1", action: "session-unrestricted" },
    });

    expect(driver.respondApproval).toHaveBeenCalledWith("ui-1", "session-unrestricted");
    expect(output).toContainEqual(expect.objectContaining({
      id: "unrestricted",
      result: { accepted: true },
    }));
  });

  it("rejects unsupported protocol versions with a stable error", async () => {
    const output: unknown[] = [];
    const server = new ControlRpcServer(rpcDriver(), (message) => output.push(message));
    await server.receive({ version: 2, id: "bad", method: "run.start", params: {} });
    expect(output).toEqual([{ version: 1, id: "bad", error: { code: "control/version-unsupported", message: "unsupported protocol version: 2" } }]);
  });

  it("accepts danger-full-access as an explicit run policy", async () => {
    let received: unknown;
    const driver = rpcDriver();
    driver.run = vi.fn(async function* (input) {
      received = input;
      yield { version: 1 as const, kind: "run.completed", payload: { runId: "danger-run" } };
    });
    const output: unknown[] = [];
    const server = new ControlRpcServer(driver, (message) => output.push(message));

    await server.receive({
      version: 1,
      id: "danger",
      method: "run.start",
      params: { prompt: "x", permissionTier: "danger-full-access" },
    });
    await server.settle();

    expect(received).toMatchObject({ prompt: "x", permissionTier: "danger-full-access" });
    expect(output).toContainEqual(expect.objectContaining({ id: "danger", event: "run.completed" }));
  });

  it.each([
    [{ harnessTier: "strict" }, "invalid harness tier: strict"],
    [{ permissionTier: "unsafe" }, "invalid permission tier: unsafe"],
  ])("rejects invalid run policy instead of silently falling back", async (policy, message) => {
    const output: unknown[] = [];
    const driver = rpcDriver();
    const run = vi.spyOn(driver, "run");
    const server = new ControlRpcServer(driver, (event) => output.push(event));

    await server.receive({ version: 1, id: "bad-policy", method: "run.start", params: { prompt: "x", ...policy } });

    expect(output).toEqual([{
      version: 1,
      id: "bad-policy",
      error: { code: "control/request-invalid", message },
    }]);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs every product command through the same Control Interface", async () => {
    const output: unknown[] = [];
    const driver = rpcDriver();
    const server = new ControlRpcServer(driver, (message) => output.push(message));
    await server.receive({ version: 1, id: "p1", method: "command.execute", params: { argv: ["permissions", "get", "--session", "s-1"] } });
    expect(output).toContainEqual(expect.objectContaining({ version: 1, id: "p1", result: expect.objectContaining({ exitCode: 0 }) }));
    expect(driver.permissionTier).toHaveBeenCalledWith("s-1");
  });
});
