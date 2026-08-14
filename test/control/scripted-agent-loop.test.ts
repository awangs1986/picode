import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RpcControlDriver } from "../../src/control/rpc-driver.ts";
import { ControlRpcServer } from "../../src/control/rpc-server.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { restoreTaskBinding } from "../../src/extension/slice-session.ts";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const scratch = mkdtempSync(join(tmpdir(), "picode-scripted-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("no-key real Agent Loop", () => {
  it("uses the user-owned Capability Catalog as the tools search visibility authority", async () => {
    const driver = new RpcControlDriver({
      packageRoot: root,
      piEntry: join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
      cwd: scratch,
      env: { ...process.env, PICODE_DIR: join(scratch, "catalog-search-data") },
    });

    expect((await driver.searchTools("pi-lens")) as unknown[]).toHaveLength(1);
    await driver.setCapabilityState("pi-lens", "disabled");
    expect(await driver.searchTools("pi-lens")).toEqual([]);
    await driver.setCapabilityState("pi-lens", "trusted");
    expect((await driver.searchTools("pi-lens")) as unknown[]).toHaveLength(1);
  });

  it("persists a session created through the control interface", async () => {
    const driver = new RpcControlDriver({
      packageRoot: root,
      piEntry: join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
      cwd: scratch,
      env: { ...process.env, PICODE_DIR: join(scratch, "create-session-data") },
    });
    const identity = await driver.createSession({ cwd: scratch });
    expect(identity.sessionFile).toBeTypeOf("string");
    expect(existsSync(identity.sessionFile as string)).toBe(true);
    expect(await driver.harnessTier(identity.sessionFile as string)).toBe("simple");
  });

  it.each(["standard", "tdd"] as const)("persists the %s harness tier when a headless run creates its session", async (harnessTier) => {
    const driver = new RpcControlDriver({
      packageRoot: root,
      piEntry: join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
      cwd: scratch,
      env: { ...process.env, PICODE_DIR: join(scratch, `${harnessTier}-data`) },
      extraExtensions: [join(root, "test", "fixtures", "scripted-model-extension.ts")],
    });
    const events = [];
    for await (const event of driver.run({
      prompt: `persist ${harnessTier}`,
      provider: "picode-scripted-test",
      model: "fixture",
      harnessTier,
      nonInteractive: true,
      timeoutMs: 20_000,
    })) events.push(event);

    const started = events.find((event) => event.kind === "run.started");
    const sessionFile = (started?.payload as { sessionFile?: string } | undefined)?.sessionFile;
    expect(sessionFile).toBeTypeOf("string");
    expect(await driver.harnessTier(sessionFile as string)).toBe(harnessTier);
  }, 30_000);

  it("preserves requested run policy and exposes task identity through the public RPC stream", async () => {
    const driver = new RpcControlDriver({
      packageRoot: root,
      piEntry: join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
      cwd: scratch,
      env: { ...process.env, PICODE_DIR: join(scratch, "rpc-run-policy-data") },
      extraExtensions: [join(root, "test", "fixtures", "scripted-model-extension.ts")],
    });
    const output: Array<{ id: string; event?: string; payload?: unknown }> = [];
    const server = new ControlRpcServer(driver, (message) => output.push(message as typeof output[number]));

    await server.receive({
      version: 1,
      id: "run-policy",
      method: "run.start",
      params: {
        prompt: "public rpc run policy",
        provider: "picode-scripted-test",
        model: "fixture",
        harnessTier: "tdd",
        permissionTier: "full",
        timeoutMs: 20_000,
      },
    });
    await server.settle();

    const started = output.find((message) => message.event === "run.started")?.payload as {
      sessionFile?: string;
      taskId?: string;
      effectiveHarnessTier?: string;
      effectivePermissionTier?: string;
    } | undefined;
    expect(started).toMatchObject({
      effectiveHarnessTier: "tdd",
      effectivePermissionTier: "full",
      taskId: expect.any(String),
    });
    expect(started?.sessionFile).toBeTypeOf("string");
    expect(await driver.harnessTier(started?.sessionFile as string)).toBe("tdd");
    expect(await driver.permissionTier(started?.sessionFile as string)).toBe("full");
    expect(await driver.taskStatus(started?.taskId as string)).toMatchObject({
      task: { harnessTier: "tdd" },
    });
  }, 30_000);

  it("applies requested harness and permission tiers when reusing an existing session", async () => {
    const driver = new RpcControlDriver({
      packageRoot: root,
      piEntry: join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
      cwd: scratch,
      env: { ...process.env, PICODE_DIR: join(scratch, "existing-session-tier-data") },
      extraExtensions: [join(root, "test", "fixtures", "scripted-model-extension.ts")],
    });
    const identity = await driver.createSession({ cwd: scratch });
    expect(identity.sessionFile).toBeTypeOf("string");
    await driver.setHarnessTier(identity.sessionFile as string, "simple");
    await driver.setPermissionTier(identity.sessionFile as string, "auto");

    const events = [];
    for await (const event of driver.run({
      session: identity.sessionFile as string,
      prompt: "/compact",
      harnessTier: "tdd",
      permissionTier: "full",
      nonInteractive: true,
      timeoutMs: 20_000,
    })) events.push(event);

    expect(await driver.harnessTier(identity.sessionFile as string)).toBe("tdd");
    expect(await driver.permissionTier(identity.sessionFile as string)).toBe("full");
    expect(events.find((event) => event.kind === "run.started")).toMatchObject({
      payload: { effectiveHarnessTier: "tdd", effectivePermissionTier: "full" },
    });
    const binding = restoreTaskBinding(
      SessionManager.open(identity.sessionFile as string).getBranch(),
    );
    expect(binding?.taskId).toBeTypeOf("string");
    if (binding !== undefined) {
      await driver.setHarnessTier(identity.sessionFile as string, "standard");
      const status = await driver.taskStatus(binding.taskId) as {
        task?: { harnessTier?: string };
      };
      expect(status.task?.harnessTier).toBe("standard");
    }
  }, 30_000);

  it("creates a pre-seeded headless session below the configured PICODE_DIR", async () => {
    const configuredRoot = join(scratch, "configured-data");
    const driver = new RpcControlDriver({
      packageRoot: root,
      piEntry: join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
      cwd: scratch,
      env: { ...process.env, PICODE_DIR: configuredRoot },
      extraExtensions: [join(root, "test", "fixtures", "scripted-model-extension.ts")],
    });
    const events = [];
    for await (const event of driver.run({ prompt: "use configured root", provider: "picode-scripted-test", model: "fixture", harnessTier: "standard", nonInteractive: true, timeoutMs: 20_000 })) events.push(event);

    const started = events.find((event) => event.kind === "run.started");
    const sessionFile = (started?.payload as { sessionFile?: string } | undefined)?.sessionFile;
    expect(sessionFile?.startsWith(join(configuredRoot, "agent", "sessions"))).toBe(true);
  }, 30_000);

  it("runs the real vendored Pi loop and Picode extension with a test-only scripted provider", async () => {
    const driver = new RpcControlDriver({
      packageRoot: root,
      piEntry: join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
      cwd: scratch,
      env: { ...process.env, PICODE_DIR: join(scratch, "data") },
      extraExtensions: [join(root, "test", "fixtures", "scripted-model-extension.ts")],
    });
    const events = [];
    for await (const event of driver.run({ prompt: "reply", provider: "picode-scripted-test", model: "fixture", nonInteractive: true, timeoutMs: 20_000 })) events.push(event);
    expect(events.at(-1)).toMatchObject({ kind: "run.completed", payload: { text: "scripted-ok" } });
  }, 30_000);

  it("dispatches /compact through Pi RPC instead of sending it to the model", async () => {
    const driver = new RpcControlDriver({
      packageRoot: root,
      piEntry: join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
      cwd: scratch,
      env: { ...process.env, PICODE_DIR: join(scratch, "compact-data") },
      extraExtensions: [join(root, "test", "fixtures", "scripted-model-extension.ts")],
    });
    const first = [];
    for await (const event of driver.run({ prompt: "seed", provider: "picode-scripted-test", model: "fixture", nonInteractive: true, timeoutMs: 20_000 })) first.push(event);
    const sessionFile = (first.find((event) => event.kind === "run.started")?.payload as { sessionFile?: string } | undefined)?.sessionFile;
    expect(sessionFile).toBeTypeOf("string");

    const compactEvents = [];
    for await (const event of driver.send({ session: sessionFile as string, message: "/compact", nonInteractive: true })) compactEvents.push(event);

    expect(compactEvents.some((event) => event.kind === "pi.compaction_start")).toBe(true);
    expect(compactEvents.some((event) => event.kind === "run.error")).toBe(false);
    expect(compactEvents.at(-1)).toMatchObject({
      kind: "run.completed",
      payload: { text: "Nothing to compact" },
    });
    expect(compactEvents.some((event) => event.kind === "run.completed" && (event.payload as { text?: string }).text === "scripted-ok")).toBe(false);
  }, 30_000);

  it("persists each fresh Slice session so the next headless process can resume it", async () => {
    const driver = new RpcControlDriver({
      packageRoot: root,
      piEntry: join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
      cwd: scratch,
      env: { ...process.env, PICODE_DIR: join(scratch, "slice-resume-data") },
      extraExtensions: [join(root, "test", "fixtures", "scripted-model-extension.ts")],
    });
    const seedEvents = [];
    for await (const event of driver.run({
      prompt: "seed",
      provider: "picode-scripted-test",
      model: "fixture",
      nonInteractive: true,
      timeoutMs: 20_000,
    })) seedEvents.push(event);
    let currentSession = (seedEvents.find((event) => event.kind === "run.started")?.payload as {
      sessionFile?: string;
    } | undefined)?.sessionFile;
    expect(currentSession).toBeTypeOf("string");

    for (const intent of ["continue phase three", "continue phase five"]) {
      const sliceEvents = [];
      for await (const event of driver.sliceSession(currentSession as string, intent)) sliceEvents.push(event);
      const completed = sliceEvents.find((event) => event.kind === "run.completed")?.payload as {
        sessionFile?: string;
      } | undefined;
      expect(completed?.sessionFile).toBeTypeOf("string");
      expect(existsSync(completed?.sessionFile as string)).toBe(true);
      const reopened = SessionManager.open(completed?.sessionFile as string);
      expect(restoreTaskBinding(reopened.getBranch())).toMatchObject({
        taskId: expect.any(String),
        taskRevision: 1,
      });
      expect(JSON.stringify(reopened.buildSessionContext().messages)).toContain(intent);
      currentSession = completed?.sessionFile;
    }
  }, 30_000);

  it("round-trips a real Guard approval through the long-lived RPC channel", async () => {
    const driver = new RpcControlDriver({ packageRoot: root, piEntry: join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"), cwd: scratch, env: { ...process.env, PICODE_DIR: join(scratch, "approval-data") }, extraExtensions: [join(root, "test", "fixtures", "scripted-model-extension.ts")] });
    const output: Array<{ id: string; event?: string; payload?: unknown }> = [];
    const server = new ControlRpcServer(driver, (message) => output.push(message as typeof output[number]));
    await server.receive({ version: 1, id: "run", method: "run.start", params: { prompt: "TOOL: run node", provider: "picode-scripted-test", model: "fixture", timeoutMs: 20_000 } });
    const deadline = Date.now() + 10_000;
    while (!output.some((item) => item.event === "approval.required") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    const approval = output.find((item) => item.event === "approval.required")?.payload as { id?: string } | undefined;
    expect(approval?.id).toBeTypeOf("string");
    await server.receive({ version: 1, id: "allow", method: "approval.respond", params: { requestId: approval?.id, action: "once" } });
    await server.settle();
    expect(output.some((item) => item.event === "run.completed"), JSON.stringify(output)).toBe(true);
  }, 30_000);

  it.each([
    { action: "once" as const, expectedApprovals: 2 },
    { action: "session" as const, expectedApprovals: 1 },
    { action: "session-full" as const, expectedApprovals: 1 },
  ])("enforces $action approval scope across two exact commands", async ({ action, expectedApprovals }) => {
    const driver = new RpcControlDriver({ packageRoot: root, piEntry: join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"), cwd: scratch, env: { ...process.env, PICODE_DIR: join(scratch, `approval-${action}`) }, extraExtensions: [join(root, "test", "fixtures", "scripted-model-extension.ts")] });
    const output: Array<{ id: string; event?: string; payload?: unknown }> = [];
    const server = new ControlRpcServer(driver, (message) => output.push(message as typeof output[number]));
    await server.receive({ version: 1, id: "run", method: "run.start", params: { prompt: "TOOL:TWICE", provider: "picode-scripted-test", model: "fixture", timeoutMs: 20_000 } });
    let answered = 0;
    const deadline = Date.now() + 20_000;
    while (!output.some((item) => item.event === "run.completed") && Date.now() < deadline) {
      const approvals = output.filter((item) => item.event === "approval.required");
      while (answered < approvals.length) {
        const requestId = (approvals[answered]?.payload as { id?: string } | undefined)?.id;
        expect(requestId).toBeTypeOf("string");
        answered += 1;
        await server.receive({ version: 1, id: `allow-${answered}`, method: "approval.respond", params: { requestId, action } });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await server.settle();
    expect(output.some((item) => item.event === "run.completed"), JSON.stringify(output)).toBe(true);
    expect(answered).toBe(expectedApprovals);
  }, 30_000);

  it("deny prevents the requested shell side effect", async () => {
    const effect = join(scratch, "approval-effect.txt");
    rmSync(effect, { force: true });
    const driver = new RpcControlDriver({ packageRoot: root, piEntry: join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"), cwd: scratch, env: { ...process.env, PICODE_DIR: join(scratch, "approval-deny") }, extraExtensions: [join(root, "test", "fixtures", "scripted-model-extension.ts")] });
    const output: Array<{ id: string; event?: string; payload?: unknown }> = [];
    const server = new ControlRpcServer(driver, (message) => output.push(message as typeof output[number]));
    await server.receive({ version: 1, id: "run", method: "run.start", params: { prompt: "TOOL:WRITE", provider: "picode-scripted-test", model: "fixture", timeoutMs: 20_000 } });
    const deadline = Date.now() + 10_000;
    while (!output.some((item) => item.event === "approval.required") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    const approval = output.find((item) => item.event === "approval.required")?.payload as { id?: string } | undefined;
    expect(approval?.id).toBeTypeOf("string");
    await server.receive({ version: 1, id: "deny", method: "approval.respond", params: { requestId: approval?.id, action: "deny" } });
    await server.settle();
    expect(existsSync(effect)).toBe(false);
  }, 30_000);

  it("readonly headless runs cannot create a side effect without approval", async () => {
    const effect = join(scratch, "approval-effect.txt");
    rmSync(effect, { force: true });
    const driver = new RpcControlDriver({ packageRoot: root, piEntry: join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"), cwd: scratch, env: { ...process.env, PICODE_DIR: join(scratch, "approval-readonly") }, extraExtensions: [join(root, "test", "fixtures", "scripted-model-extension.ts")] });
    const events = [];
    for await (const event of driver.run({ prompt: "TOOL:WRITE", provider: "picode-scripted-test", model: "fixture", permissionTier: "readonly", nonInteractive: true, timeoutMs: 20_000 })) events.push(event);
    expect(existsSync(effect)).toBe(false);
    expect(events.some((event) => event.kind === "approval.required")).toBe(true);
  }, 30_000);

  it("danger-full-access runs a real side effect without an approval event", async () => {
    const effect = join(scratch, "approval-effect.txt");
    rmSync(effect, { force: true });
    const driver = new RpcControlDriver({ packageRoot: root, piEntry: join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"), cwd: scratch, env: { ...process.env, PICODE_DIR: join(scratch, "approval-danger-full-access") }, extraExtensions: [join(root, "test", "fixtures", "scripted-model-extension.ts")] });
    const events = [];
    for await (const event of driver.run({ prompt: "TOOL:WRITE", provider: "picode-scripted-test", model: "fixture", harnessTier: "standard", permissionTier: "danger-full-access", nonInteractive: true, timeoutMs: 20_000 })) events.push(event);
    expect(existsSync(effect)).toBe(true);
    expect(events.some((event) => event.kind === "approval.required")).toBe(false);
    expect(events.at(-1)?.kind).toBe("run.completed");
  }, 30_000);

  it("TDD host blocks a production side effect before RED even with full permission", async () => {
    const effect = join(scratch, "approval-effect.txt");
    rmSync(effect, { force: true });
    const driver = new RpcControlDriver({ packageRoot: root, piEntry: join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"), cwd: scratch, env: { ...process.env, PICODE_DIR: join(scratch, "tdd-pre-red") }, extraExtensions: [join(root, "test", "fixtures", "scripted-model-extension.ts")] });
    const events = [];
    for await (const event of driver.run({ prompt: "TOOL:WRITE", provider: "picode-scripted-test", model: "fixture", harnessTier: "tdd", permissionTier: "full", nonInteractive: true, timeoutMs: 20_000 })) events.push(event);
    expect(existsSync(effect)).toBe(false);
    expect(events.some((event) => event.kind === "approval.required")).toBe(false);
    expect(JSON.stringify(events)).toContain("recorded RED");
    expect(events.at(-1)?.kind).toBe("run.completed");
  }, 30_000);
});
