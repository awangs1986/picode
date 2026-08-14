import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { atomicWriteFile } from "../shared/fs.ts";
import { dataPaths, piSessionsDir } from "../shared/paths.ts";
import type { PicodeRuntime } from "../extension/index.ts";

/**
 * HTTP+SSE 调试面（PICODE-V3-DESIGN.md §3.2，P2 完整版）。
 * 仅绑定 loopback；token 鉴权；实例锁决定哪个 pi 进程是宿主；
 * 写类端点过 Guard，headless ask → fail-closed approval_required。
 */

// ---------------------------------------------------------------------------
// 实例锁：后启动进程发现锁被持有（且持有者存活）则跳过托管
// ---------------------------------------------------------------------------

export function tryAcquireHostLock(): boolean {
  const lockPath = dataPaths.apiLock();
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      return true;
    } catch {
      try {
        const holder = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
        if (isProcessAlive(holder.pid)) return false;
        rmSync(lockPath, { force: true }); // 残留锁：持有者已死，清除重试
      } catch {
        return false;
      }
    }
  }
}

export function releaseHostLock(): void {
  try {
    const holder = JSON.parse(readFileSync(dataPaths.apiLock(), "utf8")) as { pid: number };
    if (holder.pid === process.pid) rmSync(dataPaths.apiLock(), { force: true });
  } catch {
    // 无锁或不可读：无事可做
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// token 与服务器
// ---------------------------------------------------------------------------

export function ensureApiToken(): string {
  const path = dataPaths.apiToken();
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const token = randomBytes(24).toString("hex");
  atomicWriteFile(path, token, { mode: 0o600 });
  return token;
}

type Json = Record<string, unknown> | unknown[];
const MAX_DEBUG_API_BODY_BYTES = 1024 * 1024;

class DebugApiBodyError extends Error {
  constructor(readonly code: "request_body_too_large" | "invalid_utf8") {
    super(code);
  }
}

const sendJson = (res: ServerResponse, status: number, body: Json): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage): Promise<string> {
  const declaredLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DEBUG_API_BODY_BYTES) {
    throw new DebugApiBodyError("request_body_too_large");
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.byteLength;
    if (received > MAX_DEBUG_API_BODY_BYTES) throw new DebugApiBodyError("request_body_too_large");
    chunks.push(buffer);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new DebugApiBodyError("invalid_utf8");
  }
}

export function createDebugApi(runtime: PicodeRuntime): Server {
  const token = ensureApiToken();

  return createServer((req, res) => {
    void route(runtime, token, req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof DebugApiBodyError) {
        sendJson(res, error.code === "request_body_too_large" ? 413 : 400, { error: error.code });
        return;
      }
      sendJson(res, 500, { error: "internal_error" });
    });
  });
}

async function route(
  runtime: PicodeRuntime,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.headers.authorization !== `Bearer ${token}`) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  // GET /v1/health
  if (req.method === "GET" && path === "/v1/health") {
    sendJson(res, 200, {
      pid: process.pid,
      executionEpoch: runtime.engine.currentEpoch(),
      harnessTier: runtime.harness.current(),
      cache: runtime.cacheMeter.snapshot(),
    });
    return;
  }

  // GET /v1/sessions — vendored pi 会话池的目录级列表（只读，不解析全文）
  if (req.method === "GET" && path === "/v1/sessions") {
    const dir = piSessionsDir();
    const sessions = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => ({ id: f.replace(/\.jsonl$/, ""), file: join(dir, f) }))
      : [];
    sendJson(res, 200, { sessions });
    return;
  }

  // GET /v1/sessions/:id/events — SSE（转发内部事件总线）
  const eventsMatch = path.match(/^\/v1\/sessions\/([^/]+)\/events$/);
  if (req.method === "GET" && eventsMatch) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`: connected\n\n`);
    const unsubscribe = runtime.bus.subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    req.on("close", unsubscribe);
    return;
  }

  // POST /v1/sessions/:id/messages — 注入用户消息（steer 缝：Spike 7 后接 pi）
  const messagesMatch = path.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
  if (req.method === "POST" && messagesMatch) {
    const body = await readBody(req);
    let input: { externalId?: string; title?: string; message?: string };
    try {
      input = JSON.parse(body) as { externalId?: string; title?: string; message?: string };
    } catch {
      sendJson(res, 400, { error: "invalid json" });
      return;
    }
    if (typeof input.externalId !== "string" || typeof input.title !== "string" || typeof input.message !== "string") {
      sendJson(res, 400, { error: "externalId, title and message are required" });
      return;
    }
    const task = await runtime.taskIngress.accept({
      source: "http",
      externalId: input.externalId,
      title: input.title,
      harnessTier: runtime.harness.current(),
    });
    if (!task.ok) {
      sendJson(res, 500, { error: "task_ingress_failed", reason: task.error.message });
      return;
    }
    const targetSessionId = messagesMatch[1];
    if (targetSessionId === undefined) {
      sendJson(res, 400, { error: "invalid_session_id" });
      return;
    }
    const delivered = await runtime.sendRemoteMessage(targetSessionId, input.message);
    if (!delivered.ok) {
      sendJson(res, 409, { error: "session_not_writable", reason: delivered.error.message });
      return;
    }
    runtime.bus.publish({
      ts: new Date().toISOString(),
      kind: "steer-request",
      taskId: task.value.taskId,
      payload: { sessionId: messagesMatch[1], message: input.message },
    });
    sendJson(res, 202, { accepted: true, taskId: task.value.taskId });
    return;
  }

  // GET /v1/tasks
  if (req.method === "GET" && path === "/v1/tasks") {
    const dir = dataPaths.tasks();
    const tasks = existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => ({ id: d.name }))
      : [];
    sendJson(res, 200, { tasks });
    return;
  }

  // GET /v1/evidence?task=
  if (req.method === "GET" && path === "/v1/evidence") {
    const taskFilter = url.searchParams.get("task");
    const dir = dataPaths.evidence();
    const events: unknown[] = [];
    if (existsSync(dir)) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
        for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
          if (line.trim() === "") continue;
          try {
            const event = JSON.parse(line) as { taskId?: string };
            if (taskFilter === null || event.taskId === taskFilter) events.push(event);
          } catch {
            // 跳过损坏行；evidence 是 append-only，不修复
          }
        }
      }
    }
    sendJson(res, 200, { events });
    return;
  }

  // POST /v1/commands — 无头执行 slash 命令（受 Guard 裁决；未注册即拒绝）
  if (req.method === "POST" && path === "/v1/commands") {
    const body = await readBody(req);
    let parsed: { command?: string; argv?: string[] };
    try {
      parsed = JSON.parse(body) as { command?: string; argv?: string[] };
    } catch {
      sendJson(res, 400, { error: "invalid json" });
      return;
    }
    if (parsed.command === undefined) {
      sendJson(res, 400, { error: "missing command" });
      return;
    }
    const handler = runtime.commands.get(parsed.command);
    if (handler === undefined) {
      // fail-closed：未注册命令一律拒绝
      sendJson(res, 403, { error: "approval_required", reason: `command ${parsed.command} not registered for headless execution` });
      return;
    }
    const output = await handler(parsed.argv ?? []);
    sendJson(res, 200, { output });
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

/** 仅绑定 loopback；端口写入 api-port 供 picode-ctl 发现；实例锁先行 */
export function startDebugApi(runtime: PicodeRuntime): Promise<Server | undefined> {
  if (!tryAcquireHostLock()) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const server = createDebugApi(runtime);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address !== null && typeof address === "object") {
        writeFileSync(dataPaths.apiPort(), String(address.port), "utf8");
      }
      server.once("close", releaseHostLock);
      resolve(server);
    });
  });
}
