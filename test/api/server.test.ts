import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  createDebugApi,
  ensureApiToken,
  releaseHostLock,
  startDebugApi,
  tryAcquireHostLock,
} from "../../src/api/server.ts";
import { createRuntime } from "../../src/extension/index.ts";
import { makeEvent } from "../../src/shared/events.ts";
import { dataPaths } from "../../src/shared/paths.ts";
import { ok } from "../../src/shared/types.ts";
import { withTempPicodeDir } from "../helpers/temp-dir.ts";

function httpGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path, method: "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function httpPost(
  port: number,
  path: string,
  body: string | Buffer,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function listenServer(server: import("node:http").Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

describe("host lock", () => {
  it("tryAcquireHostLock succeeds on first call", async () => {
    await withTempPicodeDir(async () => {
      expect(tryAcquireHostLock()).toBe(true);
      releaseHostLock();
    });
  });

  it("tryAcquireHostLock returns false when lock already held by live process", async () => {
    await withTempPicodeDir(async () => {
      expect(tryAcquireHostLock()).toBe(true);
      expect(tryAcquireHostLock()).toBe(false);
      releaseHostLock();
    });
  });

  it("can re-acquire after releaseHostLock", async () => {
    await withTempPicodeDir(async () => {
      expect(tryAcquireHostLock()).toBe(true);
      releaseHostLock();
      expect(tryAcquireHostLock()).toBe(true);
      releaseHostLock();
    });
  });

  it("takes over stale lock with dead pid", async () => {
    await withTempPicodeDir(async () => {
      writeFileSync(dataPaths.apiLock(), JSON.stringify({ pid: 999999, at: Date.now() }), "utf8");
      expect(tryAcquireHostLock()).toBe(true);
      releaseHostLock();
    });
  });
});

describe("ensureApiToken", () => {
  it("returns the same token on repeated calls", async () => {
    await withTempPicodeDir(async () => {
      const first = ensureApiToken();
      const second = ensureApiToken();
      expect(first).toBe(second);
      expect(existsSync(dataPaths.apiToken())).toBe(true);
    });
  });
});

describe("createDebugApi HTTP", () => {
  it("rejects oversized and malformed UTF-8 request bodies before JSON parsing", async () => {
    await withTempPicodeDir(async () => {
      const runtime = createRuntime();
      const token = ensureApiToken();
      const server = createDebugApi(runtime);
      const port = await listenServer(server);
      try {
        const oversized = await httpPost(port, "/v1/commands", "x".repeat(1024 * 1024 + 1), {
          authorization: `Bearer ${token}`,
        });
        expect(oversized.status).toBe(413);
        expect(JSON.parse(oversized.body).error).toBe("request_body_too_large");

        const invalidUtf8 = await httpPost(port, "/v1/commands", Buffer.from([0xc3, 0x28]), {
          authorization: `Bearer ${token}`,
        });
        expect(invalidUtf8.status).toBe(400);
        expect(JSON.parse(invalidUtf8.body).error).toBe("invalid_utf8");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  it("routes remote messages through TaskIngress before accepting steer work", async () => {
    await withTempPicodeDir(async () => {
      const runtime = createRuntime();
      const deliver = vi.fn(async () => ok(undefined));
      runtime.bindRemoteMessageSender(deliver);
      const token = ensureApiToken();
      const server = createDebugApi(runtime);
      const port = await listenServer(server);
      try {
        const res = await httpPost(
          port,
          "/v1/sessions/session-a/messages",
          JSON.stringify({ externalId: "remote-1", title: "Continue build", message: "continue" }),
          { authorization: `Bearer ${token}` },
        );
        expect(res.status).toBe(202);
        expect(JSON.parse(res.body).taskId).toMatch(/^[a-f0-9]{24}$/);
        expect(deliver).toHaveBeenCalledWith("session-a", "continue");
        const tasks = await httpGet(port, "/v1/tasks", { authorization: `Bearer ${token}` });
        expect(JSON.parse(tasks.body).tasks).toHaveLength(1);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  it("fails explicitly when no live Pi session can accept a remote message", async () => {
    await withTempPicodeDir(async () => {
      const runtime = createRuntime();
      const token = ensureApiToken();
      const server = createDebugApi(runtime);
      const port = await listenServer(server);
      try {
        const res = await httpPost(
          port,
          "/v1/sessions/session-a/messages",
          JSON.stringify({ externalId: "remote-1", title: "Continue build", message: "continue" }),
          { authorization: `Bearer ${token}` },
        );
        expect(res.status).toBe(409);
        expect(JSON.parse(res.body).error).toBe("session_not_writable");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  it("rejects requests without Authorization", async () => {
    await withTempPicodeDir(async () => {
      const runtime = createRuntime();
      const server = createDebugApi(runtime);
      const port = await listenServer(server);
      try {
        const res = await httpGet(port, "/v1/health");
        expect(res.status).toBe(401);
        expect(JSON.parse(res.body).error).toBe("unauthorized");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  it("GET /v1/health returns executionEpoch, harnessTier, and cache", async () => {
    await withTempPicodeDir(async () => {
      const runtime = createRuntime();
      const token = ensureApiToken();
      const server = createDebugApi(runtime);
      const port = await listenServer(server);
      try {
        const res = await httpGet(port, "/v1/health", { authorization: `Bearer ${token}` });
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body) as Record<string, unknown>;
        expect(body.executionEpoch).toBe(runtime.engine.currentEpoch());
        expect(body.harnessTier).toBe(runtime.harness.current());
        expect(body.cache).toEqual(runtime.cacheMeter.snapshot());
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  it("GET /v1/tasks returns empty tasks for empty directory", async () => {
    await withTempPicodeDir(async () => {
      const runtime = createRuntime();
      const token = ensureApiToken();
      const server = createDebugApi(runtime);
      const port = await listenServer(server);
      try {
        const res = await httpGet(port, "/v1/tasks", { authorization: `Bearer ${token}` });
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ tasks: [] });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  it("GET /v1/sessions returns empty sessions when directory missing", async () => {
    await withTempPicodeDir(async () => {
      const runtime = createRuntime();
      const token = ensureApiToken();
      const server = createDebugApi(runtime);
      const port = await listenServer(server);
      try {
        const res = await httpGet(port, "/v1/sessions", { authorization: `Bearer ${token}` });
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ sessions: [] });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  it("POST /v1/commands returns 403 approval_required for unregistered command", async () => {
    await withTempPicodeDir(async () => {
      const runtime = createRuntime();
      const token = ensureApiToken();
      const server = createDebugApi(runtime);
      const port = await listenServer(server);
      try {
        const res = await httpPost(
          port,
          "/v1/commands",
          JSON.stringify({ command: "unknown-cmd", argv: [] }),
          { authorization: `Bearer ${token}` },
        );
        expect(res.status).toBe(403);
        const body = JSON.parse(res.body) as { error: string; reason: string };
        expect(body.error).toBe("approval_required");
        expect(body.reason).toContain("unknown-cmd");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  it("POST /v1/commands runs registered harness command", async () => {
    await withTempPicodeDir(async () => {
      const runtime = createRuntime();
      const token = ensureApiToken();
      const server = createDebugApi(runtime);
      const port = await listenServer(server);
      try {
        const res = await httpPost(
          port,
          "/v1/commands",
          JSON.stringify({ command: "harness", argv: [] }),
          { authorization: `Bearer ${token}` },
        );
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body) as { output: string };
        expect(body.output).toContain("current harness tier");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  it("POST /v1/commands returns 400 for invalid JSON", async () => {
    await withTempPicodeDir(async () => {
      const runtime = createRuntime();
      const token = ensureApiToken();
      const server = createDebugApi(runtime);
      const port = await listenServer(server);
      try {
        const res = await httpPost(port, "/v1/commands", "{not json", {
          authorization: `Bearer ${token}`,
        });
        expect(res.status).toBe(400);
        expect(JSON.parse(res.body).error).toBe("invalid json");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  it("GET /v1/evidence returns empty events", async () => {
    await withTempPicodeDir(async () => {
      const runtime = createRuntime();
      const token = ensureApiToken();
      const server = createDebugApi(runtime);
      const port = await listenServer(server);
      try {
        const res = await httpGet(port, "/v1/evidence", { authorization: `Bearer ${token}` });
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ events: [] });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  it("SSE stream receives bus events as data lines", async () => {
    await withTempPicodeDir(async () => {
      const runtime = createRuntime();
      const token = ensureApiToken();
      const server = createDebugApi(runtime);
      const port = await listenServer(server);

      const ssePromise = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("SSE timeout")), 5000);
        const req = httpRequest(
          {
            hostname: "127.0.0.1",
            port,
            path: "/v1/sessions/x/events",
            method: "GET",
            headers: { authorization: `Bearer ${token}` },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => {
              data += chunk.toString("utf8");
              if (data.includes("data:") && data.includes("sse-test")) {
                clearTimeout(timeout);
                req.destroy();
                resolve(data);
              }
            });
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.end();

        setTimeout(() => {
          runtime.bus.publish(makeEvent("sse-test", { hello: true }));
        }, 50);
      });

      try {
        const sseData = await ssePromise;
        expect(sseData).toContain("data:");
        expect(sseData).toContain("sse-test");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});

describe("startDebugApi", () => {
  it("starts server, writes api-port file, and second call returns undefined", async () => {
    await withTempPicodeDir(async () => {
      const runtime = createRuntime();
      const first = await startDebugApi(runtime);
      expect(first).toBeDefined();
      expect(existsSync(dataPaths.apiPort())).toBe(true);
      expect(readFileSync(dataPaths.apiPort(), "utf8").trim()).not.toBe("");

      const second = await startDebugApi(runtime);
      expect(second).toBeUndefined();

      await new Promise<void>((resolve) => first!.close(() => resolve()));
      expect(existsSync(dataPaths.apiLock())).toBe(false);
    });
  });
});
