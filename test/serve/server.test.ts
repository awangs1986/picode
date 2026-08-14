import { mkdirSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { ControlDriver } from "../../src/control/index.ts";
import { isRemoteControlCommand } from "../../src/serve/command-catalog.ts";
import { startRemoteServe } from "../../src/serve/server.ts";
import { dataPaths } from "../../src/shared/paths.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";
import { ChatWriterLeases } from "../../src/guard/chat-writer-lease.ts";

function driver(): ControlDriver {
  return {
    async *run(input: Parameters<ControlDriver["run"]>[0]) {
      yield { version: 1, kind: "run.started", payload: { runId: "run-1", sessionId: input.session ?? "s-1" } };
      yield { version: 1, kind: "run.completed", payload: { runId: "run-1", sessionId: input.session ?? "s-1", text: `reply:${input.prompt}` } };
    },
    respondApproval: vi.fn(async () => ({ accepted: true })),
    cancelRun: vi.fn(async () => ({ cancelled: true })),
    listSessions: vi.fn(async () => [{ sessionId: "s-1", cwd: "D:/repo", modified: "2026-08-10T00:00:00.000Z" }]),
    async *events() {
      yield { version: 1, kind: "session.event", payload: { type: "message", id: "e-1", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } } };
    },
    createSession: vi.fn(async () => ({ sessionId: "s-new" })),
    resumeSession: vi.fn(async (session: string) => ({ sessionId: session })), switchSession: vi.fn(), branchSession: vi.fn(),
    subagentStatus: vi.fn(), stopSubagent: vi.fn(), resumeSubagent: vi.fn(),
    sliceSession: vi.fn(), listCapsules: vi.fn(), readCapsule: vi.fn(),
    worktreeStatus: vi.fn(), claimWorktree: vi.fn(), releaseWorktree: vi.fn(),
    capabilityStatus: vi.fn(), setCapabilityState: vi.fn(), previewChats: vi.fn(), importChats: vi.fn(),
    send: vi.fn(), cancelTask: vi.fn(), waitTask: vi.fn(), taskStatus: vi.fn(),
    harnessTier: vi.fn(async () => "standard"), setHarnessTier: vi.fn(),
    permissionTier: vi.fn(async () => "auto"), setPermissionTier: vi.fn(),
    sessionModelState: vi.fn(async () => ({ model: { provider: "openai", id: "gpt-5" }, thinkingLevel: "medium", availableModels: [{ provider: "openai", id: "gpt-5" }], availableThinkingLevels: ["low", "medium", "high"] })),
    setSessionModel: vi.fn(async (_session: string, provider: string, modelId: string) => ({ model: { provider, id: modelId }, thinkingLevel: "medium" })),
    setSessionThinking: vi.fn(async (_session: string, level: string) => ({ model: { provider: "openai", id: "gpt-5" }, thinkingLevel: level })),
    importAccount: vi.fn(), listAccounts: vi.fn(), useAccount: vi.fn(),
    gateStatus: vi.fn(), evidence: vi.fn(), doctor: vi.fn(), searchTools: vi.fn(), doctorTools: vi.fn(),
  } as unknown as ControlDriver;
}

function request(input: {
  port: number;
  method: string;
  path: string;
  token?: string;
  body?: unknown;
  declaredLength?: number;
}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const body = input.body === undefined ? "" : JSON.stringify(input.body);
    const req = httpsRequest({
      hostname: "127.0.0.1",
      port: input.port,
      method: input.method,
      path: input.path,
      rejectUnauthorized: false,
      headers: {
        ...(input.token === undefined ? {} : { authorization: `Bearer ${input.token}` }),
        ...(body === "" ? {} : { "content-type": "application/json", "content-length": input.declaredLength ?? Buffer.byteLength(body) }),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk as Buffer));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text === "" ? undefined : JSON.parse(text) });
      });
    });
    req.on("error", reject);
    if (body !== "") req.write(body);
    req.end();
  });
}

function download(port: number, path: string, token: string): Promise<{ status: number; body: Buffer; contentType?: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      hostname: "127.0.0.1", port, method: "GET", path, rejectUnauthorized: false,
      headers: { authorization: `Bearer ${token}` },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk as Buffer));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks),
        ...(typeof res.headers["content-type"] === "string" ? { contentType: res.headers["content-type"] } : {}),
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function pair(handle: Awaited<ReturnType<typeof startRemoteServe>>, deviceName: string) {
  const payload = JSON.parse(handle.pairingPayload) as { bootstrapToken: string };
  const response = await request({
    port: handle.port,
    method: "POST",
    path: "/v1/pair",
    body: { bootstrapToken: payload.bootstrapToken, deviceName },
  });
  expect(response.status).toBe(201);
  return response.body as { deviceId: string; deviceToken: string };
}

describe("P5 Serve Mode transport adapter", () => {
  it("rejects oversized HTTP bodies before JSON decoding", async () => {
    await withTempPicodeDir(async () => {
      const handle = await startRemoteServe({ driver: driver(), bind: "127.0.0.1", advertisedHost: "127.0.0.1", port: 0, hostName: "Test Picode" });
      try {
        const response = await request({
          port: handle.port,
          method: "POST",
          path: "/v1/pair",
          body: "x".repeat(1024 * 1024 + 1),
        });
        expect(response).toEqual({ status: 413, body: { error: "request_body_too_large" } });
      } finally {
        await handle.close();
      }
    });
  });

  it("rejects malformed UTF-8, oversized prompts, and request floods", async () => {
    await withTempPicodeDir(async () => {
      const handle = await startRemoteServe({
        driver: driver(), bind: "127.0.0.1", advertisedHost: "127.0.0.1", port: 0, hostName: "Test Picode",
        rateWindowMs: 60_000, maxRequestsPerWindow: 3,
      });
      try {
        const device = await pair(handle, "Protocol probe");
        const socket = await openSocket(handle.port, device.deviceToken);
        const messages: Array<Record<string, unknown>> = [];
        socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as Record<string, unknown>));

        socket.send(Buffer.from([0xc3, 0x28]));
        await waitUntil(() => messages.some((message) => (message.error as { code?: string } | undefined)?.code === "control/json-invalid"));

        socket.send(JSON.stringify({ version: 1, id: "large-prompt", method: "run.start", params: { session: "s-1", prompt: "x".repeat(128 * 1024 + 1) } }));
        await waitUntil(() => messages.some((message) => message.id === "large-prompt" && (message.error as { code?: string } | undefined)?.code === "serve/prompt-too-large"));

        socket.send(JSON.stringify({ version: 99, id: "unsupported", method: "unknown", params: {} }));
        await waitUntil(() => messages.some((message) => message.id === "unsupported" && (message.error as { code?: string } | undefined)?.code === "control/version-unsupported"));

        socket.send(JSON.stringify({ version: 1, id: "flood", method: "unknown", params: {} }));
        await waitUntil(() => messages.some((message) => (message.error as { code?: string } | undefined)?.code === "serve/rate-limited"));
      } finally {
        await handle.close();
      }
    });
  });

  it("closes WebSockets that exceed the five MiB frame limit", async () => {
    await withTempPicodeDir(async () => {
      const handle = await startRemoteServe({ driver: driver(), bind: "127.0.0.1", advertisedHost: "127.0.0.1", port: 0, hostName: "Test Picode" });
      try {
        const device = await pair(handle, "Oversize probe");
        const socket = await openSocket(handle.port, device.deviceToken);
        const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
        socket.send(Buffer.alloc(5 * 1024 * 1024 + 1));
        expect(await closed).toBe(1009);
      } finally {
        await handle.close();
      }
    });
  });

  it("downloads only explicitly published bounded artifacts", async () => {
    await withTempPicodeDir(async () => {
      const published = join(dataPaths.artifacts(), "published");
      mkdirSync(published, { recursive: true });
      writeFileSync(join(published, "report-1.json"), JSON.stringify({
        version: 1, artifactId: "report-1", sessionId: "s-1", taskId: "task-1",
        displayName: "report.txt", mimeType: "text/plain", createdAt: "2026-08-10T00:00:00.000Z",
      }));
      writeFileSync(join(published, "report-1.bin"), "published result");
      writeFileSync(join(published, "unsafe.json"), JSON.stringify({
        version: 1, artifactId: "../secret", sessionId: "s-1", displayName: "secret.txt",
        mimeType: "text/plain", createdAt: "2026-08-10T00:00:00.000Z",
      }));

      const handle = await startRemoteServe({ driver: driver(), bind: "127.0.0.1", advertisedHost: "127.0.0.1", port: 0, hostName: "Test Picode" });
      try {
        const device = await pair(handle, "Artifact reader");
        const listed = await request({ port: handle.port, method: "GET", path: "/v1/sessions/s-1/artifacts", token: device.deviceToken });
        expect(listed).toMatchObject({ status: 200, body: { artifacts: [{ artifactId: "report-1", displayName: "report.txt", size: 16 }] } });
        expect(JSON.stringify(listed.body)).not.toContain("secret.txt");
        const result = await download(handle.port, "/v1/artifacts/report-1", device.deviceToken);
        expect(result).toEqual({ status: 200, body: Buffer.from("published result"), contentType: "text/plain" });
        const missing = await request({ port: handle.port, method: "GET", path: "/v1/artifacts/not-published", token: device.deviceToken });
        expect(missing).toEqual({ status: 404, body: { error: "artifact_not_found" } });
      } finally {
        await handle.close();
      }
    });
  });

  it("allows accepted Control commands and fences PC-only commands", () => {
    expect(isRemoteControlCommand(["task", "status", "--task", "t-1"])).toBe(true);
    expect(isRemoteControlCommand(["harness", "get", "--session", "s-1"])).toBe(true);
    expect(isRemoteControlCommand(["harness", "set", "--session", "s-1", "--tier", "tdd"])).toBe(false);
    expect(isRemoteControlCommand(["permissions", "set", "--session", "s-1", "--tier", "full"])).toBe(false);
    expect(isRemoteControlCommand(["session", "send", "--session", "s-1", "--message", "bypass"])).toBe(false);
    expect(isRemoteControlCommand(["worktree", "claim", "--workspace", "D:/repo", "--task", "t-1"])).toBe(false);
    expect(isRemoteControlCommand(["capability", "set", "--id", "mcp", "--state", "trusted"])).toBe(false);
    expect(isRemoteControlCommand(["account", "import"])).toBe(false);
    expect(isRemoteControlCommand(["chat", "import", "--path", "D:/secret"])).toBe(false);
    expect(isRemoteControlCommand(["session", "create", "--cwd", "D:/arbitrary"])).toBe(false);
    expect(isRemoteControlCommand(["serve"])).toBe(false);
  });
  it("pairs with a one-use four-digit manual KEY and rate-limits guesses", async () => {
    await withTempPicodeDir(async () => {
      const handle = await startRemoteServe({ driver: driver(), bind: "127.0.0.1", advertisedHost: "127.0.0.1", port: 0, hostName: "Test Picode" });
      try {
        const payload = JSON.parse(handle.pairingPayload) as { pairingCode: string };
        expect(payload.pairingCode).toMatch(/^\d{4}$/);
        const wrongCode = payload.pairingCode === "0000" ? "0001" : "0000";
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          const wrong = await request({ port: handle.port, method: "POST", path: "/v1/pair", body: { pairingCode: wrongCode, deviceName: "Guess" } });
          expect(wrong.status).toBe(409);
        }
        const limited = await request({ port: handle.port, method: "POST", path: "/v1/pair", body: { pairingCode: wrongCode, deviceName: "Guess" } });
        expect(limited).toEqual({ status: 429, body: { error: "pairing_attempts_exceeded" } });
      } finally {
        await handle.close();
      }
    });

    await withTempPicodeDir(async () => {
      const handle = await startRemoteServe({ driver: driver(), bind: "127.0.0.1", advertisedHost: "127.0.0.1", port: 0, hostName: "Test Picode" });
      try {
        const payload = JSON.parse(handle.pairingPayload) as { pairingCode: string };
        const paired = await request({ port: handle.port, method: "POST", path: "/v1/pair", body: { pairingCode: payload.pairingCode, deviceName: "Phone manual" } });
        expect(paired.status).toBe(201);
        const replay = await request({ port: handle.port, method: "POST", path: "/v1/pair", body: { pairingCode: payload.pairingCode, deviceName: "Replay" } });
        expect(replay.status).toBe(409);
      } finally {
        await handle.close();
      }
    });
  });

  it("pairs once, authenticates session/history reads, and rejects bootstrap replay", async () => {
    await withTempPicodeDir(async () => {
      const control = driver();
      const handle = await startRemoteServe({
        driver: control,
        bind: "127.0.0.1",
        advertisedHost: "127.0.0.1",
        port: 0,
        hostName: "Test Picode",
      });
      try {
        const pairing = JSON.parse(handle.pairingPayload) as { bootstrapToken: string; fingerprint: string; endpoint: string };
        expect(pairing.fingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(pairing.endpoint).toBe(`https://127.0.0.1:${handle.port}`);

        const device = await pair(handle, "Phone A");
        const sessions = await request({ port: handle.port, method: "GET", path: "/v1/sessions", token: device.deviceToken });
        expect(sessions).toEqual({ status: 200, body: { sessions: [{ sessionId: "s-1", cwd: "D:/repo", modified: "2026-08-10T00:00:00.000Z" }] } });

        const history = await request({ port: handle.port, method: "GET", path: "/v1/sessions/s-1/events", token: device.deviceToken });
        expect(history.status).toBe(200);
        expect(history.body).toMatchObject({ events: [{ kind: "session.event" }] });

        const replay = await request({
          port: handle.port,
          method: "POST",
          path: "/v1/pair",
          body: { bootstrapToken: pairing.bootstrapToken, deviceName: "Replay" },
        });
        expect(replay.status).toBe(409);
      } finally {
        await handle.close();
      }
    });
  });

  it("resumes history by Event Cursor and requires Snapshot for an unavailable cursor", async () => {
    await withTempPicodeDir(async () => {
      const handle = await startRemoteServe({
        driver: driver(),
        bind: "127.0.0.1",
        advertisedHost: "127.0.0.1",
        port: 0,
        hostName: "Test Picode",
      });
      try {
        const device = await pair(handle, "Phone A");
        const first = await request({ port: handle.port, method: "GET", path: "/v1/sessions/s-1/events?after=v1:0", token: device.deviceToken });
        expect(first).toMatchObject({
          status: 200,
          body: { cursor: "v1:1", snapshotRequired: false, events: [{ kind: "session.event" }] },
        });
        const caughtUp = await request({ port: handle.port, method: "GET", path: "/v1/sessions/s-1/events?after=v1:1", token: device.deviceToken });
        expect(caughtUp).toMatchObject({ status: 200, body: { cursor: "v1:1", latestCursor: "v1:1", hasMore: false, snapshotRequired: false, events: [] } });
        const unavailable = await request({ port: handle.port, method: "GET", path: "/v1/sessions/s-1/events?after=v1:99", token: device.deviceToken });
        expect(unavailable).toEqual({
          status: 409,
          body: { error: "event_cursor_unavailable", snapshotRequired: true, snapshotUrl: "/v1/sessions/s-1/snapshot" },
        });
        const snapshot = await request({ port: handle.port, method: "GET", path: "/v1/sessions/s-1/snapshot", token: device.deviceToken });
        expect(snapshot).toMatchObject({ status: 200, body: { sessionId: "s-1", cursor: "v1:1", events: [{ kind: "session.event" }] } });
      } finally {
        await handle.close();
      }
    });
  });

  it("acquires chat-scoped Writer Leases and does not inherit them after disconnect", async () => {
    await withTempPicodeDir(async () => {
      const handle = await startRemoteServe({
        driver: driver(), bind: "127.0.0.1", advertisedHost: "127.0.0.1", port: 0, hostName: "Test Picode",
        writerLeaseMs: 1_000,
      });
      try {
        const device = await pair(handle, "Phone A");
        const first = await openSocket(handle.port, device.deviceToken);
        const firstMessages: Array<Record<string, unknown>> = [];
        first.on("message", (raw) => firstMessages.push(JSON.parse(raw.toString()) as Record<string, unknown>));
        first.send(JSON.stringify({ version: 1, id: "lease-a", method: "lease.acquire", params: { session: "s-1" } }));
        await waitUntil(() => firstMessages.some((message) => message.id === "lease-a" && "result" in message));
        expect(firstMessages).toContainEqual(expect.objectContaining({
          id: "lease-a",
          result: expect.objectContaining({ session: "s-1", held: true, owner: "remote" }),
        }));
        first.send(JSON.stringify({ version: 1, id: "lease-b", method: "lease.acquire", params: { session: "s-2" } }));
        await waitUntil(() => firstMessages.some((message) => message.id === "lease-b" && "result" in message));
        expect(firstMessages).toContainEqual(expect.objectContaining({ id: "lease-b", result: expect.objectContaining({ session: "s-2", held: true }) }));
        first.close();
        await new Promise((resolve) => first.once("close", resolve));

        const second = await openSocket(handle.port, device.deviceToken);
        const secondMessages: Array<Record<string, unknown>> = [];
        second.on("message", (raw) => secondMessages.push(JSON.parse(raw.toString()) as Record<string, unknown>));
        second.send(JSON.stringify({ version: 1, id: "lease-reacquire", method: "lease.acquire", params: { session: "s-1" } }));
        await waitUntil(() => secondMessages.some((message) => message.id === "lease-reacquire" && "result" in message));
        expect(secondMessages).toContainEqual(expect.objectContaining({ id: "lease-reacquire", result: expect.objectContaining({ held: true, inherited: false }) }));
        second.close();
      } finally {
        await handle.close();
      }
    });
  });

  it("releases an in-flight request id after an exceptional request path", async () => {
    await withTempPicodeDir(async () => {
      const handle = await startRemoteServe({
        driver: driver(), bind: "127.0.0.1", advertisedHost: "127.0.0.1", port: 0, hostName: "Test Picode",
      });
      try {
        const device = await pair(handle, "Retry client");
        const socket = await openSocket(handle.port, device.deviceToken);
        const messages: Array<Record<string, unknown>> = [];
        socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as Record<string, unknown>));

        socket.send(JSON.stringify({ version: 1, id: "retry-id", method: "lease.acquire", params: {} }));
        await waitUntil(() => messages.some((message) => message.id === "retry-id" && "error" in message));
        socket.send(JSON.stringify({ version: 1, id: "retry-id", method: "lease.acquire", params: { session: "s-1" } }));
        await waitUntil(() => messages.some((message) => message.id === "retry-id" && "result" in message));

        expect(messages.some((message) =>
          message.id === "retry-id" &&
          (message.error as { code?: string } | undefined)?.code === "control/request-in-flight"
        )).toBe(false);
        socket.close();
      } finally {
        await handle.close();
      }
    });
  });

  it("uses the Host Guard lease authority instead of a transport-local map", async () => {
    await withTempPicodeDir(async () => {
      const writerLeases = new ChatWriterLeases();
      const tuiOwner = { kind: "tui" as const, id: "host-tui" };
      expect(writerLeases.acquire("s-1", tuiOwner, 60_000).ok).toBe(true);
      const handle = await startRemoteServe({
        driver: driver(),
        bind: "127.0.0.1",
        advertisedHost: "127.0.0.1",
        port: 0,
        hostName: "Test Picode",
        writerLeases,
      });
      try {
        const device = await pair(handle, "Phone A");
        const socket = await openSocket(handle.port, device.deviceToken);
        const messages: Array<Record<string, unknown>> = [];
        socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as Record<string, unknown>));
        socket.send(JSON.stringify({ version: 1, id: "blocked", method: "run.start", params: { prompt: "go", session: "s-1" } }));
        await waitUntil(() => messages.some((message) => message.id === "blocked" && "error" in message));
        expect(messages).toContainEqual(expect.objectContaining({
          id: "blocked",
          error: expect.objectContaining({ code: "serve/writer-lease-held" }),
        }));

        expect(writerLeases.release("s-1", tuiOwner)).toBe(true);
        socket.send(JSON.stringify({ version: 1, id: "allowed", method: "run.start", params: { prompt: "go", session: "s-1" } }));
        await waitUntil(() => messages.some((message) => message.id === "allowed" && message.event === "run.completed"));
        socket.close();
      } finally {
        await handle.close();
      }
    });
  });

  it("fences duplicate terminal and late events before they reach the remote client", async () => {
    await withTempPicodeDir(async () => {
      const control = driver();
      control.run = async function* () {
        yield { version: 1, kind: "run.started", payload: { runId: "run-1", sessionId: "s-1" } };
        yield { version: 1, kind: "run.completed", payload: { runId: "run-1", text: "authoritative" } };
        yield { version: 1, kind: "run.completed", payload: { runId: "run-1", text: "duplicate" } };
        yield { version: 1, kind: "pi.tool_result", payload: { runId: "run-1", text: "late" } };
      };
      const handle = await startRemoteServe({ driver: control, bind: "127.0.0.1", advertisedHost: "127.0.0.1", port: 0, hostName: "Test Picode" });
      try {
        const device = await pair(handle, "Phone A");
        const socket = await openSocket(handle.port, device.deviceToken);
        const messages: Array<{ event?: string }> = [];
        socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as { event?: string }));
        socket.send(JSON.stringify({ version: 1, id: "fence-1", method: "run.start", params: { prompt: "go", session: "s-1" } }));
        await waitUntil(() => messages.some((message) => message.event === "run.completed"));
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(messages.filter((message) => message.event === "run.completed")).toHaveLength(1);
        expect(messages.some((message) => message.event === "pi.tool_result")).toBe(false);
        socket.close();
      } finally {
        await handle.close();
      }
    });
  });

  it("requires an explicit same-connection confirmation before force-Steering", async () => {
    await withTempPicodeDir(async () => {
      const control = driver();
      control.steerRun = vi.fn(async (runId: string, message: string) => ({ runId, steered: true, message }));
      const handle = await startRemoteServe({ driver: control, bind: "127.0.0.1", advertisedHost: "127.0.0.1", port: 0, hostName: "Test Picode" });
      try {
        const device = await pair(handle, "Phone A");
        const socket = await openSocket(handle.port, device.deviceToken);
        const messages: Array<Record<string, unknown>> = [];
        socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as Record<string, unknown>));
        socket.send(JSON.stringify({ version: 1, id: "lease-steer", method: "lease.acquire", params: { session: "s-1" } }));
        await waitUntil(() => messages.some((message) => message.id === "lease-steer" && "result" in message));
        socket.send(JSON.stringify({ version: 1, id: "prepare", method: "steering.prepare", params: { session: "s-1", runId: "run-1", message: "change direction" } }));
        await waitUntil(() => messages.some((message) => message.id === "prepare" && "result" in message));
        expect(control.steerRun).not.toHaveBeenCalled();
        const prepared = messages.find((message) => message.id === "prepare")?.result as { confirmationId?: string };
        expect(prepared.confirmationId).toEqual(expect.any(String));
        socket.send(JSON.stringify({ version: 1, id: "confirm", method: "steering.confirm", params: { confirmationId: prepared.confirmationId } }));
        await waitUntil(() => messages.some((message) => message.id === "confirm" && "result" in message));
        expect(control.steerRun).toHaveBeenCalledOnce();
        expect(control.steerRun).toHaveBeenCalledWith("run-1", "change direction");
        expect(messages).toContainEqual(expect.objectContaining({ id: "confirm", result: expect.objectContaining({ steered: true }) }));
        socket.close();
      } finally {
        await handle.close();
      }
    });
  });

  it("lists paired devices without token hashes and revokes a Device Credential", async () => {
    await withTempPicodeDir(async () => {
      const handle = await startRemoteServe({ driver: driver(), bind: "127.0.0.1", advertisedHost: "127.0.0.1", port: 0, hostName: "Test Picode" });
      try {
        const device = await pair(handle, "Phone A");
        const listed = await request({ port: handle.port, method: "GET", path: "/v1/devices", token: device.deviceToken });
        expect(listed.status).toBe(200);
        expect(JSON.stringify(listed.body)).not.toContain("tokenHash");
        expect(listed.body).toMatchObject({ devices: [{ deviceId: device.deviceId, deviceName: "Phone A" }] });
        const revoked = await request({ port: handle.port, method: "DELETE", path: `/v1/devices/${device.deviceId}`, token: device.deviceToken });
        expect(revoked).toMatchObject({ status: 200, body: { revoked: true, deviceId: device.deviceId } });
        const denied = await request({ port: handle.port, method: "GET", path: "/v1/sessions", token: device.deviceToken });
        expect(denied.status).toBe(401);
      } finally { await handle.close(); }
    });
  });

  it("projects and changes the Host-authoritative model and thinking level", async () => {
    await withTempPicodeDir(async () => {
      const control = driver();
      const handle = await startRemoteServe({ driver: control, bind: "127.0.0.1", advertisedHost: "127.0.0.1", port: 0, hostName: "Test Picode" });
      try {
        const device = await pair(handle, "Phone A");
        const state = await request({ port: handle.port, method: "GET", path: "/v1/sessions/s-1/runtime", token: device.deviceToken });
        expect(state).toMatchObject({ status: 200, body: { model: { provider: "openai", id: "gpt-5" }, thinkingLevel: "medium" } });
        const model = await request({ port: handle.port, method: "POST", path: "/v1/sessions/s-1/runtime/model", token: device.deviceToken, body: { provider: "openai", modelId: "gpt-5-mini" } });
        expect(model).toMatchObject({ status: 200, body: { model: { id: "gpt-5-mini" } } });
        expect(control.setSessionModel).toHaveBeenCalledWith("s-1", "openai", "gpt-5-mini");
        const thinking = await request({ port: handle.port, method: "POST", path: "/v1/sessions/s-1/runtime/thinking", token: device.deviceToken, body: { level: "high" } });
        expect(thinking).toMatchObject({ status: 200, body: { thinkingLevel: "high" } });
        expect(control.setSessionThinking).toHaveBeenCalledWith("s-1", "high");
      } finally {
        await handle.close();
      }
    });
  });

  it("resumes a Host Chat by Session ID with a bounded recent context", async () => {
    await withTempPicodeDir(async () => {
      const control = driver();
      const handle = await startRemoteServe({ driver: control, bind: "127.0.0.1", advertisedHost: "127.0.0.1", port: 0, hostName: "Test Picode" });
      try {
        const device = await pair(handle, "Phone A");
        const resumed = await request({
          port: handle.port,
          method: "POST",
          path: "/v1/sessions/resume",
          token: device.deviceToken,
          body: { sessionId: "s-1" },
        });
        expect(control.resumeSession).toHaveBeenCalledWith("s-1");
        expect(resumed).toMatchObject({
          status: 200,
          body: {
            session: { sessionId: "s-1", cwd: "D:/repo" },
            context: { cursor: "v1:1", truncated: false, events: [{ kind: "session.event" }] },
          },
        });
      } finally {
        await handle.close();
      }
    });
  });

  it("creates a Chat only in a Host-authorized recent workspace", async () => {
    await withTempPicodeDir(async () => {
      const control = driver();
      const handle = await startRemoteServe({
        driver: control, bind: "127.0.0.1", advertisedHost: "127.0.0.1", port: 0, hostName: "Test Picode",
        newChatWorkspace: "D:/picode/tempchat",
      });
      try {
        const device = await pair(handle, "Phone A");
        const commands = await request({ port: handle.port, method: "GET", path: "/v1/commands", token: device.deviceToken });
        expect(commands).toMatchObject({ status: 200, body: { commands: expect.arrayContaining([
          expect.objectContaining({ name: "compact", remote: false }),
          expect.objectContaining({ name: "server", remote: false }),
        ]) } });
        const workspaces = await request({ port: handle.port, method: "GET", path: "/v1/workspaces", token: device.deviceToken });
        expect(workspaces).toEqual({ status: 200, body: { workspaces: [{ path: "D:/picode/tempchat", authorized: true, default: true }] } });
        const denied = await request({ port: handle.port, method: "POST", path: "/v1/sessions", token: device.deviceToken, body: { cwd: "D:/repo" } });
        expect(denied).toEqual({ status: 403, body: { error: "workspace_not_authorized" } });
        const created = await request({ port: handle.port, method: "POST", path: "/v1/sessions", token: device.deviceToken, body: { cwd: "D:/picode/tempchat" } });
        expect(created).toEqual({ status: 201, body: { session: { sessionId: "s-new" } } });
        expect(control.createSession).toHaveBeenCalledWith({ cwd: "D:/picode/tempchat" });
      } finally {
        await handle.close();
      }
    });
  });

  it("persists terminal idempotency across WebSocket disconnect and Serve restart", async () => {
    await withTempPicodeDir(async () => {
      const control = driver();
      let executions = 0;
      control.run = async function* (input) {
        executions += 1;
        yield { version: 1, kind: "run.started", payload: { runId: "run-1", sessionId: input.session ?? "s-1" } };
        yield { version: 1, kind: "run.completed", payload: { runId: "run-1", sessionId: input.session ?? "s-1", text: "first-terminal" } };
      };
      const options = {
        driver: control,
        bind: "127.0.0.1",
        advertisedHost: "127.0.0.1",
        port: 0,
        hostName: "Test Picode",
      };
      const first = await startRemoteServe(options);
      const device = await pair(first, "Phone A");
      const requestFrame = { version: 1, id: "durable-1", method: "run.start", params: { prompt: "continue", session: "s-1" } };
      try {
        const messages = await sendAndCollect(first.port, device.deviceToken, requestFrame, (message) => message.event === "run.completed");
        expect(messages).toContainEqual(expect.objectContaining({ id: "durable-1", event: "run.completed" }));
      } finally {
        await first.close();
      }

      const second = await startRemoteServe(options);
      try {
        const messages = await sendAndCollect(second.port, device.deviceToken, requestFrame, (message) => message.result?.duplicate === true);
        expect(executions).toBe(1);
        expect(messages).toContainEqual(expect.objectContaining({
          id: "durable-1",
          result: { duplicate: true, terminal: expect.objectContaining({ event: "run.completed", payload: expect.objectContaining({ text: "first-terminal" }) }) },
        }));
      } finally {
        await second.close();
      }
    });
  });

  it("maps authenticated WebSocket requests to ControlRpcServer and replays terminal idempotency", async () => {
    await withTempPicodeDir(async () => {
      const control = driver();
      const handle = await startRemoteServe({
        driver: control,
        bind: "127.0.0.1",
        advertisedHost: "127.0.0.1",
        port: 0,
        hostName: "Test Picode",
      });
      try {
        const device = await pair(handle, "Phone A");
        const messages: unknown[] = [];
        const socket = new WebSocket(`wss://127.0.0.1:${handle.port}/v1/ws`, {
          rejectUnauthorized: false,
          headers: { authorization: `Bearer ${device.deviceToken}` },
        });
        socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
        await new Promise<void>((resolve, reject) => {
          socket.once("open", () => resolve());
          socket.once("error", reject);
        });

        const requestFrame = { version: 1, id: "message-1", method: "run.start", params: { prompt: "continue", session: "s-1" } };
        socket.send(JSON.stringify(requestFrame));
        await waitUntil(() => messages.some((value) => (value as { event?: string }).event === "run.completed"));
        expect(messages).toContainEqual(expect.objectContaining({ id: "message-1", event: "run.completed" }));

        socket.send(JSON.stringify(requestFrame));
        await waitUntil(() => messages.some((value) => (value as { result?: { duplicate?: boolean } }).result?.duplicate === true));
        expect(messages).toContainEqual(expect.objectContaining({
          id: "message-1",
          result: expect.objectContaining({ duplicate: true }),
        }));
        socket.close();
      } finally {
        await handle.close();
      }
    });
  });
});

async function openSocket(port: number, token: string): Promise<WebSocket> {
  const socket = new WebSocket(`wss://127.0.0.1:${port}/v1/ws`, {
    rejectUnauthorized: false,
    headers: { authorization: `Bearer ${token}` },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function sendAndCollect(
  port: number,
  token: string,
  frame: unknown,
  done: (message: { event?: string; result?: { duplicate?: boolean } }) => boolean,
): Promise<Array<{ event?: string; result?: { duplicate?: boolean } }>> {
  const messages: Array<{ event?: string; result?: { duplicate?: boolean } }> = [];
  const socket = new WebSocket(`wss://127.0.0.1:${port}/v1/ws`, {
    rejectUnauthorized: false,
    headers: { authorization: `Bearer ${token}` },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as { event?: string; result?: { duplicate?: boolean } }));
    socket.send(JSON.stringify(frame));
    await waitUntil(() => messages.some(done));
    return messages;
  } finally {
    socket.close();
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timeout waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
