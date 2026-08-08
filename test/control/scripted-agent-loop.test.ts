import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RpcControlDriver } from "../../src/control/rpc-driver.ts";
import { ControlRpcServer } from "../../src/control/rpc-server.ts";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const scratch = mkdtempSync(join(tmpdir(), "picode-scripted-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("no-key real Agent Loop", () => {
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
    expect(compactEvents.some((event) => event.kind === "run.completed" && (event.payload as { text?: string }).text === "scripted-ok")).toBe(false);
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
});
