import { createHash, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import * as QRCode from "qrcode";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { ControlDriver } from "../control/index.ts";
import { ControlRpcServer, type RpcMessage, type RpcRequest } from "../control/rpc-server.ts";
import { isRemoteControlCommand } from "./command-catalog.ts";
import { atomicWriteFile } from "../shared/fs.ts";
import { dataPaths } from "../shared/paths.ts";
import { StateFile } from "../store/state-file.ts";
import { REMOTE_SLASH_COMMANDS } from "./command-catalog.ts";

const require = createRequire(import.meta.url);
const selfsigned = require("selfsigned") as {
  generate(attrs: Array<{ name: string; value: string }>, options: Record<string, unknown>): {
    private: string;
    cert: string;
  };
};

const PROTOCOL_VERSION = 1;
const PAIRING_TTL_MS = 5 * 60_000;
const HEARTBEAT_MS = 10_000;
const MAX_HTTP_BODY_BYTES = 1024 * 1024;
const MAX_WS_FRAME_BYTES = 5 * 1024 * 1024;
const MAX_PROMPT_BYTES = 128 * 1024;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const DEFAULT_RATE_WINDOW_MS = 10_000;
const DEFAULT_MAX_REQUESTS_PER_WINDOW = 120;
const MAX_LEDGER_ENTRIES = 500;
const MAX_HISTORY_PAGE = 200;
const MAX_SNAPSHOT_EVENTS = 500;
const TERMINAL_EVENTS = new Set(["run.completed", "run.cancelled", "run.timeout", "run.error"]);

type DeviceRecord = {
  deviceId: string;
  deviceName: string;
  tokenHash: string;
  createdAt: string;
  revokedAt?: string;
};

type DeviceState = { version: 1; devices: DeviceRecord[] };

type CompletedRequest = {
  deviceId: string;
  requestId: string;
  completedAt: string;
  terminal: RpcMessage;
};

type RequestState = { version: 1; completed: CompletedRequest[] };

type PairingWindow = {
  token: string;
  code: string;
  expiresAt: number;
  used: boolean;
  failedAttempts: number;
};

type PublishedArtifact = {
  version: 1;
  artifactId: string;
  sessionId: string;
  taskId?: string;
  displayName: string;
  mimeType: string;
  createdAt: string;
  size: number;
};

export interface RemoteServeOptions {
  driver: ControlDriver;
  bind: string;
  advertisedHost: string;
  port: number;
  hostName: string;
  pairingTtlMs?: number;
  heartbeatMs?: number;
  writerLeaseMs?: number;
  newChatWorkspace?: string;
  rateWindowMs?: number;
  maxRequestsPerWindow?: number;
}

export interface RemoteServeHandle {
  port: number;
  endpoint: string;
  fingerprint: string;
  pairingPayload: string;
  pairingQr: string;
  rotatePairing(): Promise<{ pairingPayload: string; pairingQr: string }>;
  close(): Promise<void>;
}

function isDeviceState(value: unknown): value is DeviceState {
  if (typeof value !== "object" || value === null) return false;
  const row = value as { version?: unknown; devices?: unknown };
  return row.version === 1 && Array.isArray(row.devices) && row.devices.every((device) => {
    if (typeof device !== "object" || device === null) return false;
    const entry = device as Record<string, unknown>;
    return typeof entry.deviceId === "string" && typeof entry.deviceName === "string" &&
      typeof entry.tokenHash === "string" && typeof entry.createdAt === "string" &&
      (entry.revokedAt === undefined || typeof entry.revokedAt === "string");
  });
}

function isRequestState(value: unknown): value is RequestState {
  if (typeof value !== "object" || value === null) return false;
  const row = value as { version?: unknown; completed?: unknown };
  return row.version === 1 && Array.isArray(row.completed) && row.completed.every((request) => {
    if (typeof request !== "object" || request === null) return false;
    const entry = request as Record<string, unknown>;
    return typeof entry.deviceId === "string" && typeof entry.requestId === "string" &&
      typeof entry.completedAt === "string" && typeof entry.terminal === "object" && entry.terminal !== null;
  });
}

class DeviceStore {
  private readonly file = new StateFile<DeviceState>(dataPaths.serveDevices(), isDeviceState);
  private state: DeviceState = { version: 1, devices: [] };

  async load(): Promise<void> {
    const loaded = await this.file.read();
    if (loaded.ok) this.state = loaded.value;
    else if (loaded.error.code !== "store/state-missing") throw new Error(loaded.error.message);
  }

  async pair(deviceName: string): Promise<{ deviceId: string; deviceToken: string }> {
    const deviceId = randomUUID();
    const deviceToken = randomBytes(32).toString("base64url");
    this.state.devices.push({
      deviceId,
      deviceName,
      tokenHash: hashToken(deviceToken),
      createdAt: new Date().toISOString(),
    });
    const saved = await this.file.write(this.state);
    if (!saved.ok) throw new Error(saved.error.message);
    return { deviceId, deviceToken };
  }

  authenticate(token: string): DeviceRecord | undefined {
    const digest = hashToken(token);
    return this.state.devices.find((device) => device.revokedAt === undefined && device.tokenHash === digest);
  }

  list(): Array<Omit<DeviceRecord, "tokenHash">> {
    return this.state.devices.map(({ tokenHash: _tokenHash, ...device }) => device);
  }

  async revoke(deviceId: string): Promise<boolean> {
    const device = this.state.devices.find((entry) => entry.deviceId === deviceId && entry.revokedAt === undefined);
    if (device === undefined) return false;
    device.revokedAt = new Date().toISOString();
    const saved = await this.file.write(this.state);
    if (!saved.ok) throw new Error(saved.error.message);
    return true;
  }
}

class RequestLedger {
  private readonly file = new StateFile<RequestState>(dataPaths.serveRequests(), isRequestState);
  private state: RequestState = { version: 1, completed: [] };

  async load(): Promise<void> {
    const loaded = await this.file.read();
    if (loaded.ok) this.state = loaded.value;
    else if (loaded.error.code !== "store/state-missing") throw new Error(loaded.error.message);
  }

  find(deviceId: string, requestId: string): CompletedRequest | undefined {
    return this.state.completed.find((entry) => entry.deviceId === deviceId && entry.requestId === requestId);
  }

  async complete(deviceId: string, requestId: string, terminal: RpcMessage): Promise<void> {
    if (this.find(deviceId, requestId) !== undefined) return;
    this.state.completed.push({ deviceId, requestId, completedAt: new Date().toISOString(), terminal });
    if (this.state.completed.length > MAX_LEDGER_ENTRIES) {
      this.state.completed.splice(0, this.state.completed.length - MAX_LEDGER_ENTRIES);
    }
    const saved = await this.file.write(this.state);
    if (!saved.ok) throw new Error(saved.error.message);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function pairingCode(): string {
  return (randomBytes(2).readUInt16BE(0) % 10_000).toString().padStart(4, "0");
}

function newPairingWindow(ttlMs: number): PairingWindow {
  return {
    token: randomBytes(24).toString("base64url"),
    code: pairingCode(),
    expiresAt: Date.now() + ttlMs,
    used: false,
    failedAttempts: 0,
  };
}

function ensureIdentity(hostName: string, advertisedHost: string): { key: string; cert: string; fingerprint: string } {
  mkdirSync(dataPaths.serve(), { recursive: true });
  const keyPath = dataPaths.serveIdentityKey();
  const certPath = dataPaths.serveIdentityCert();
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    const generated = selfsigned.generate(
      [{ name: "commonName", value: hostName }],
      {
        days: 3650,
        keySize: 2048,
        algorithm: "sha256",
        extensions: [{
          name: "subjectAltName",
          altNames: [
            { type: 2, value: hostName },
            { type: 7, ip: advertisedHost },
            { type: 7, ip: "127.0.0.1" },
          ],
        }],
      },
    );
    atomicWriteFile(keyPath, generated.private, { mode: 0o600 });
    atomicWriteFile(certPath, generated.cert, { mode: 0o600 });
  }
  const key = readFileSync(keyPath, "utf8");
  const cert = readFileSync(certPath, "utf8");
  const fingerprint = new X509Certificate(cert).fingerprint256.replaceAll(":", "").toLowerCase();
  return { key, cert, fingerprint };
}

function acquireServeLock(): void {
  mkdirSync(dataPaths.serve(), { recursive: true });
  const path = dataPaths.serveLock();
  for (;;) {
    try {
      const descriptor = openSync(path, "wx");
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(descriptor);
      return;
    } catch {
      try {
        const holder = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
        if (typeof holder.pid === "number" && processAlive(holder.pid)) {
          throw new Error(`Serve Mode is already running in process ${holder.pid}`);
        }
        rmSync(path, { force: true });
      } catch (cause) {
        if (cause instanceof Error && cause.message.startsWith("Serve Mode is already")) throw cause;
        throw new Error("Serve Mode lock is unreadable");
      }
    }
  }
}

function releaseServeLock(): void {
  try {
    const holder = JSON.parse(readFileSync(dataPaths.serveLock(), "utf8")) as { pid?: number };
    if (holder.pid === process.pid) rmSync(dataPaths.serveLock(), { force: true });
  } catch {
    // No current lock.
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

class RequestBodyTooLargeError extends Error {}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const declaredLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_HTTP_BODY_BYTES) {
    throw new RequestBodyTooLargeError("request body too large");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_HTTP_BODY_BYTES) throw new RequestBodyTooLargeError("request body too large");
    chunks.push(buffer);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

function sendBodyError(res: ServerResponse, cause: unknown): void {
  if (cause instanceof RequestBodyTooLargeError) sendJson(res, 413, { error: "request_body_too_large" });
  else sendJson(res, 400, { error: "invalid_json" });
}

function rawBuffer(raw: RawData): Buffer {
  if (Array.isArray(raw)) return Buffer.concat(raw);
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  return raw;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function bearer(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Bearer ") !== true) return undefined;
  return authorization.slice("Bearer ".length);
}

function rejectUpgrade(socket: import("node:stream").Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
  socket.destroy();
}

function isTerminalMessage(message: RpcMessage): boolean {
  if ("result" in message || "error" in message) return true;
  return TERMINAL_EVENTS.has(message.event);
}

function validRpcRequest(value: unknown): value is RpcRequest {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.version === "number" && typeof row.id === "string" && row.id.trim() !== "" &&
    typeof row.method === "string" && (row.params === undefined || (typeof row.params === "object" && row.params !== null && !Array.isArray(row.params)));
}

function eventCursor(index: number): string {
  return `v1:${index}`;
}

function parseEventCursor(value: string | null): number | undefined {
  if (value === null) return 0;
  const match = /^v1:(\d+)$/.exec(value);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

async function sessionEvents(driver: ControlDriver, session: string): Promise<Array<{ version: 1; kind: string; payload: unknown }>> {
  const events: Array<{ version: 1; kind: string; payload: unknown }> = [];
  for await (const event of driver.events({ session })) events.push(event);
  return events;
}

async function authorizedWorkspaces(driver: ControlDriver, newChatWorkspace?: string): Promise<string[]> {
  if (newChatWorkspace !== undefined && newChatWorkspace.trim() !== "") return [newChatWorkspace];
  const sessions = await driver.listSessions();
  if (!Array.isArray(sessions)) return [];
  return [...new Set(sessions.flatMap((session) => {
    if (typeof session !== "object" || session === null) return [];
    const cwd = (session as { cwd?: unknown }).cwd;
    return typeof cwd === "string" && cwd.trim() !== "" ? [cwd] : [];
  }))];
}

function publishedArtifacts(): PublishedArtifact[] {
  const directory = join(dataPaths.artifacts(), "published");
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".json")) return [];
    try {
      const value = JSON.parse(readFileSync(join(directory, entry.name), "utf8")) as Record<string, unknown>;
      if (value.version !== 1 || typeof value.artifactId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value.artifactId) ||
        typeof value.sessionId !== "string" || typeof value.displayName !== "string" || typeof value.mimeType !== "string" ||
        typeof value.createdAt !== "string" || (value.taskId !== undefined && typeof value.taskId !== "string")) return [];
      const payload = join(directory, `${value.artifactId}.bin`);
      if (!existsSync(payload)) return [];
      const size = statSync(payload).size;
      if (size < 0 || size > MAX_ARTIFACT_BYTES) return [];
      return [{
        version: 1,
        artifactId: value.artifactId,
        sessionId: value.sessionId,
        ...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
        displayName: value.displayName.slice(0, 200),
        mimeType: value.mimeType.slice(0, 100),
        createdAt: value.createdAt,
        size,
      } satisfies PublishedArtifact];
    } catch {
      return [];
    }
  });
}

export async function startRemoteServe(options: RemoteServeOptions): Promise<RemoteServeHandle> {
  acquireServeLock();
  const identity = ensureIdentity(options.hostName, options.advertisedHost);
  const devices = new DeviceStore();
  const requests = new RequestLedger();
  await Promise.all([devices.load(), requests.load()]);

  const pairingTtlMs = options.pairingTtlMs ?? PAIRING_TTL_MS;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const writerLeaseMs = options.writerLeaseMs ?? heartbeatMs * 3;
  const rateWindowMs = options.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
  const maxRequestsPerWindow = options.maxRequestsPerWindow ?? DEFAULT_MAX_REQUESTS_PER_WINDOW;
  let pairing = newPairingWindow(pairingTtlMs);
  let active: { deviceId: string; connectionId: string; socket: WebSocket; alive: boolean } | undefined;
  const pending = new Set<string>();
  const leases = new Map<string, { deviceId: string; connectionId: string; expiresAt: number }>();
  const steeringConfirmations = new Map<string, {
    deviceId: string; connectionId: string; session: string; runId: string; message: string; expiresAt: number;
  }>();

  const server = createHttpsServer({ key: identity.key, cert: identity.cert });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_FRAME_BYTES });

  server.on("request", (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `https://${options.advertisedHost}`);
      if (req.method === "GET" && url.pathname === "/v1/hello") {
        sendJson(res, 200, {
          protocolVersion: PROTOCOL_VERSION,
          hostName: options.hostName,
          fingerprint: identity.fingerprint,
          capabilities: ["sessions", "history", "snapshot", "rpc", "approval", "cancel", "idempotency", "writer-lease", "steering", "authorized-workspaces", "heartbeat", "published-artifacts"],
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/pair") {
        let body: unknown;
        try { body = await readJsonBody(req); }
        catch (cause) { sendBodyError(res, cause); return; }
        const input = body as { bootstrapToken?: unknown; pairingCode?: unknown; deviceName?: unknown };
        const hasBootstrap = typeof input.bootstrapToken === "string";
        const hasCode = typeof input.pairingCode === "string" && /^\d{4}$/.test(input.pairingCode);
        if ((!hasBootstrap && !hasCode) || typeof input.deviceName !== "string" || input.deviceName.trim() === "") {
          sendJson(res, 400, { error: "pairing_credential_and_deviceName_required" });
          return;
        }
        if (pairing.used || Date.now() > pairing.expiresAt) {
          sendJson(res, 409, { error: "pairing_unavailable" });
          return;
        }
        const accepted = (hasBootstrap && input.bootstrapToken === pairing.token) || (hasCode && input.pairingCode === pairing.code);
        if (!accepted) {
          pairing.failedAttempts += 1;
          if (pairing.failedAttempts >= 5) {
            pairing.used = true;
            sendJson(res, 429, { error: "pairing_attempts_exceeded" });
          } else {
            sendJson(res, 409, { error: "pairing_unavailable" });
          }
          return;
        }
        pairing.used = true;
        const paired = await devices.pair(input.deviceName.trim().slice(0, 100));
        sendJson(res, 201, {
          ...paired,
          protocolVersion: PROTOCOL_VERSION,
          hostName: options.hostName,
          fingerprint: identity.fingerprint,
        });
        return;
      }

      const token = bearer(req);
      const device = token === undefined ? undefined : devices.authenticate(token);
      if (device === undefined) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/health") {
        sendJson(res, 200, { protocolVersion: PROTOCOL_VERSION, hostName: options.hostName, activeDevice: active?.deviceId ?? null });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/devices") {
        sendJson(res, 200, { devices: devices.list(), activeDeviceId: active?.deviceId ?? null });
        return;
      }

      const deviceMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)$/);
      if (req.method === "DELETE" && deviceMatch?.[1] !== undefined) {
        const deviceId = decodeURIComponent(deviceMatch[1]);
        if (!await devices.revoke(deviceId)) { sendJson(res, 404, { error: "device_not_found" }); return; }
        sendJson(res, 200, { revoked: true, deviceId });
        if (active?.deviceId === deviceId) setTimeout(() => active?.socket.close(4003, "Device credential revoked"), 10);
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/sessions") {
        sendJson(res, 200, { sessions: await options.driver.listSessions() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/commands") {
        sendJson(res, 200, { commands: REMOTE_SLASH_COMMANDS });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/workspaces") {
        sendJson(res, 200, {
          workspaces: (await authorizedWorkspaces(options.driver, options.newChatWorkspace))
            .map((path) => ({ path, authorized: true, ...(path === options.newChatWorkspace ? { default: true } : {}) })),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/sessions/resume") {
        let body: unknown;
        try { body = await readJsonBody(req); }
        catch (cause) { sendBodyError(res, cause); return; }
        const sessionId = typeof (body as { sessionId?: unknown }).sessionId === "string"
          ? (body as { sessionId: string }).sessionId.trim()
          : "";
        if (sessionId === "") {
          sendJson(res, 400, { error: "sessionId_required" });
          return;
        }
        const identity = await options.driver.resumeSession(sessionId);
        const listed = await options.driver.listSessions();
        const metadata = Array.isArray(listed)
          ? listed.find((item) => typeof item === "object" && item !== null && (item as { sessionId?: unknown }).sessionId === identity.sessionId)
          : undefined;
        const events = await sessionEvents(options.driver, identity.sessionFile ?? identity.sessionId);
        const base = Math.max(0, events.length - 100);
        sendJson(res, 200, {
          session: { ...identity, ...(typeof metadata === "object" && metadata !== null ? metadata : {}) },
          context: {
            baseCursor: eventCursor(base),
            cursor: eventCursor(events.length),
            truncated: base > 0,
            events: events.slice(base),
          },
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/sessions") {
        let body: unknown;
        try { body = await readJsonBody(req); }
        catch (cause) { sendBodyError(res, cause); return; }
        const cwd = typeof (body as { cwd?: unknown }).cwd === "string" ? (body as { cwd: string }).cwd : undefined;
        if (cwd === undefined || cwd.trim() === "") {
          sendJson(res, 400, { error: "cwd_required" });
          return;
        }
        if (!(await authorizedWorkspaces(options.driver, options.newChatWorkspace)).includes(cwd)) {
          sendJson(res, 403, { error: "workspace_not_authorized" });
          return;
        }
        sendJson(res, 201, { session: await options.driver.createSession({ cwd }) });
        return;
      }

      const runtimeMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/runtime$/);
      if (req.method === "GET" && runtimeMatch?.[1] !== undefined) {
        if (options.driver.sessionModelState === undefined) { sendJson(res, 501, { error: "session_runtime_unavailable" }); return; }
        sendJson(res, 200, await options.driver.sessionModelState(decodeURIComponent(runtimeMatch[1])));
        return;
      }

      const modelMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/runtime\/model$/);
      if (req.method === "POST" && modelMatch?.[1] !== undefined) {
        if (options.driver.setSessionModel === undefined) { sendJson(res, 501, { error: "session_model_unavailable" }); return; }
        let body: unknown;
        try { body = await readJsonBody(req); } catch (cause) { sendBodyError(res, cause); return; }
        const provider = (body as { provider?: unknown }).provider;
        const modelId = (body as { modelId?: unknown }).modelId;
        if (typeof provider !== "string" || provider.trim() === "" || typeof modelId !== "string" || modelId.trim() === "") {
          sendJson(res, 400, { error: "provider_and_modelId_required" }); return;
        }
        sendJson(res, 200, await options.driver.setSessionModel(decodeURIComponent(modelMatch[1]), provider, modelId));
        return;
      }

      const thinkingMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/runtime\/thinking$/);
      if (req.method === "POST" && thinkingMatch?.[1] !== undefined) {
        if (options.driver.setSessionThinking === undefined) { sendJson(res, 501, { error: "session_thinking_unavailable" }); return; }
        let body: unknown;
        try { body = await readJsonBody(req); } catch (cause) { sendBodyError(res, cause); return; }
        const level = (body as { level?: unknown }).level;
        const allowed = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
        if (typeof level !== "string" || !allowed.includes(level as typeof allowed[number])) {
          sendJson(res, 400, { error: "invalid_thinking_level" }); return;
        }
        sendJson(res, 200, await options.driver.setSessionThinking(decodeURIComponent(thinkingMatch[1]), level as typeof allowed[number]));
        return;
      }

      const artifactsMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/artifacts$/);
      if (req.method === "GET" && artifactsMatch?.[1] !== undefined) {
        const sessionId = decodeURIComponent(artifactsMatch[1]);
        sendJson(res, 200, { artifacts: publishedArtifacts().filter((artifact) => artifact.sessionId === sessionId) });
        return;
      }

      const artifactMatch = url.pathname.match(/^\/v1\/artifacts\/([^/]+)$/);
      if (req.method === "GET" && artifactMatch?.[1] !== undefined) {
        const artifactId = decodeURIComponent(artifactMatch[1]);
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(artifactId)) { sendJson(res, 404, { error: "artifact_not_found" }); return; }
        const artifact = publishedArtifacts().find((entry) => entry.artifactId === artifactId);
        if (artifact === undefined) { sendJson(res, 404, { error: "artifact_not_found" }); return; }
        const payload = readFileSync(join(dataPaths.artifacts(), "published", `${artifact.artifactId}.bin`));
        res.writeHead(200, {
          "content-type": artifact.mimeType,
          "content-length": payload.length,
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.displayName)}`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(payload);
        return;
      }

      const eventsMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/events$/);
      if (req.method === "GET" && eventsMatch?.[1] !== undefined) {
        const session = decodeURIComponent(eventsMatch[1]);
        const events = await sessionEvents(options.driver, session);
        const after = parseEventCursor(url.searchParams.get("after"));
        if (after === undefined || after > events.length) {
          sendJson(res, 409, {
            error: "event_cursor_unavailable",
            snapshotRequired: true,
            snapshotUrl: `/v1/sessions/${encodeURIComponent(session)}/snapshot`,
          });
          return;
        }
        const requestedLimit = Number(url.searchParams.get("limit") ?? MAX_HISTORY_PAGE);
        const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(MAX_HISTORY_PAGE, Math.floor(requestedLimit))) : MAX_HISTORY_PAGE;
        const next = Math.min(events.length, after + limit);
        sendJson(res, 200, {
          cursor: eventCursor(next),
          latestCursor: eventCursor(events.length),
          hasMore: next < events.length,
          snapshotRequired: false,
          events: events.slice(after, next),
        });
        return;
      }

      const snapshotMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/snapshot$/);
      if (req.method === "GET" && snapshotMatch?.[1] !== undefined) {
        const session = decodeURIComponent(snapshotMatch[1]);
        const events = await sessionEvents(options.driver, session);
        const base = Math.max(0, events.length - MAX_SNAPSHOT_EVENTS);
        sendJson(res, 200, {
          sessionId: session,
          baseCursor: eventCursor(base),
          cursor: eventCursor(events.length),
          truncated: base > 0,
          events: events.slice(base),
        });
        return;
      }

      sendJson(res, 404, { error: "not_found" });
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
      else res.destroy();
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `https://${options.advertisedHost}`);
    if (url.pathname !== "/v1/ws") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    const token = bearer(req);
    const device = token === undefined ? undefined : devices.authenticate(token);
    if (device === undefined) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    if (active !== undefined && active.socket.readyState === WebSocket.OPEN) {
      rejectUpgrade(socket, 409, "Active Remote Device already connected");
      return;
    }
    sockets.handleUpgrade(req, socket, head, (websocket) => {
      const connectionId = randomUUID();
      active = { deviceId: device.deviceId, connectionId, socket: websocket, alive: true };
      sockets.emit("connection", websocket, req, device, connectionId);
    });
  });

  sockets.on("connection", (socket: WebSocket, _request: IncomingMessage, device: DeviceRecord, connectionId: string) => {
    const buffers = new Map<string, RpcMessage[]>();
    let rateWindowStartedAt = Date.now();
    let requestsInWindow = 0;
    const terminalRequestIds = new Set<string>();
    const rpc = new ControlRpcServer(options.driver, (message) => {
      if (terminalRequestIds.has(message.id)) return;
      if (isTerminalMessage(message)) terminalRequestIds.add(message.id);
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      const buffered = buffers.get(message.id);
      if (buffered !== undefined) buffered.push(message);
      if (isTerminalMessage(message)) {
        pending.delete(`${device.deviceId}:${message.id}`);
        buffers.delete(message.id);
        void requests.complete(device.deviceId, message.id, message);
      }
    });

    socket.on("error", () => {
      // Protocol and network failures are represented by close; never expose raw internals to clients.
    });
    socket.on("pong", () => {
      if (active?.socket === socket) active.alive = true;
    });
    socket.on("close", () => {
      if (active?.socket === socket) active = undefined;
      for (const [session, lease] of leases) {
        if (lease.connectionId === connectionId) leases.delete(session);
      }
      for (const [confirmationId, confirmation] of steeringConfirmations) {
        if (confirmation.connectionId === connectionId) steeringConfirmations.delete(confirmationId);
      }
    });
    socket.on("message", (raw: RawData) => {
      void (async () => {
        const now = Date.now();
        if (now - rateWindowStartedAt >= rateWindowMs) {
          rateWindowStartedAt = now;
          requestsInWindow = 0;
        }
        requestsInWindow += 1;
        if (requestsInWindow > maxRequestsPerWindow) {
          socket.send(JSON.stringify({ version: 1, id: "", error: { code: "serve/rate-limited", message: "too many requests" } }));
          socket.close(1008, "Request rate limit exceeded");
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBuffer(raw)));
        } catch {
          socket.send(JSON.stringify({ version: 1, id: "", error: { code: "control/json-invalid", message: "invalid JSON or UTF-8" } }));
          return;
        }
        if (!validRpcRequest(parsed)) {
          socket.send(JSON.stringify({ version: 1, id: "", error: { code: "control/request-invalid", message: "invalid RPC request" } }));
          return;
        }
        const completed = requests.find(device.deviceId, parsed.id);
        if (completed !== undefined) {
          socket.send(JSON.stringify({ version: 1, id: parsed.id, result: { duplicate: true, terminal: completed.terminal } }));
          return;
        }
        if (parsed.method === "run.start") {
          const prompt = parsed.params?.prompt;
          const requestedSession = parsed.params?.session;
          if (typeof requestedSession !== "string" || requestedSession.trim() === "") {
            socket.send(JSON.stringify({ version: 1, id: parsed.id, error: { code: "serve/session-required", message: "an explicit Host Chat is required" } }));
            return;
          }
          if (typeof prompt !== "string" || prompt.trim() === "") {
            socket.send(JSON.stringify({ version: 1, id: parsed.id, error: { code: "control/request-invalid", message: "prompt is required" } }));
            return;
          }
          if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
            socket.send(JSON.stringify({ version: 1, id: parsed.id, error: { code: "serve/prompt-too-large", message: "prompt exceeds 128 KiB" } }));
            return;
          }
        }
        if (parsed.method === "command.execute") {
          const argv = parsed.params?.argv;
          if (!Array.isArray(argv) || argv.some((item) => typeof item !== "string") || !isRemoteControlCommand(argv as string[])) {
            socket.send(JSON.stringify({ version: 1, id: parsed.id, error: { code: "serve/command-pc-only", message: "command is unavailable to remote devices" } }));
            return;
          }
        }
        const key = `${device.deviceId}:${parsed.id}`;
        if (pending.has(key)) {
          socket.send(JSON.stringify({ version: 1, id: parsed.id, error: { code: "control/request-in-flight", message: "request is already running" } }));
          return;
        }
        pending.add(key);
        buffers.set(parsed.id, []);

        const sendServeTerminal = async (message: RpcMessage): Promise<void> => {
          terminalRequestIds.add(parsed.id);
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
          pending.delete(key);
          buffers.delete(parsed.id);
          await requests.complete(device.deviceId, parsed.id, message);
        };
        const sendServeResult = async (result: unknown): Promise<void> => {
          await sendServeTerminal({ version: 1, id: parsed.id, result });
        };
        const sendServeError = async (code: string, message: string): Promise<void> => {
          await sendServeTerminal({ version: 1, id: parsed.id, error: { code, message } });
        };
        const session = typeof parsed.params?.session === "string" ? parsed.params.session : undefined;
        if (parsed.method === "lease.acquire") {
          if (session === undefined || session.trim() === "") throw new Error("missing session");
          const now = Date.now();
          const current = leases.get(session);
          if (current !== undefined && current.expiresAt > now && current.connectionId !== connectionId) {
            await sendServeError("serve/writer-lease-held", "Chat Writer Lease is held by another writer");
            return;
          }
          const expiresAt = now + writerLeaseMs;
          leases.set(session, { deviceId: device.deviceId, connectionId, expiresAt });
          await sendServeResult({ session, held: true, owner: "remote", inherited: false, expiresAt: new Date(expiresAt).toISOString() });
          return;
        }
        if (parsed.method === "lease.release") {
          if (session === undefined || session.trim() === "") throw new Error("missing session");
          const current = leases.get(session);
          if (current?.connectionId === connectionId) leases.delete(session);
          await sendServeResult({ session, released: current?.connectionId === connectionId });
          return;
        }
        if (parsed.method === "lease.heartbeat") {
          if (session === undefined || session.trim() === "") throw new Error("missing session");
          const current = leases.get(session);
          if (current?.connectionId !== connectionId || current.expiresAt <= Date.now()) {
            leases.delete(session);
            await sendServeError("serve/writer-lease-missing", "Chat Writer Lease is not held by this connection");
            return;
          }
          current.expiresAt = Date.now() + writerLeaseMs;
          await sendServeResult({ session, held: true, expiresAt: new Date(current.expiresAt).toISOString() });
          return;
        }
        if (parsed.method === "steering.prepare") {
          const runId = typeof parsed.params?.runId === "string" ? parsed.params.runId : undefined;
          const message = typeof parsed.params?.message === "string" ? parsed.params.message : undefined;
          if (session === undefined || runId === undefined || message === undefined || message.trim() === "") {
            await sendServeError("control/request-invalid", "session, runId, and message are required");
            return;
          }
          if (Buffer.byteLength(message, "utf8") > MAX_PROMPT_BYTES) {
            await sendServeError("serve/prompt-too-large", "Steering message exceeds 128 KiB");
            return;
          }
          const lease = leases.get(session);
          if (lease?.connectionId !== connectionId || lease.expiresAt <= Date.now()) {
            await sendServeError("serve/writer-lease-missing", "Force-Steering requires the Chat Writer Lease");
            return;
          }
          const confirmationId = randomUUID();
          const expiresAt = Date.now() + 30_000;
          steeringConfirmations.set(confirmationId, { deviceId: device.deviceId, connectionId, session, runId, message, expiresAt });
          await sendServeResult({ confirmationId, session, runId, warning: "Force-Steering interrupts the active turn at the Host safe boundary", expiresAt: new Date(expiresAt).toISOString() });
          return;
        }
        if (parsed.method === "steering.confirm") {
          const confirmationId = typeof parsed.params?.confirmationId === "string" ? parsed.params.confirmationId : undefined;
          const confirmation = confirmationId === undefined ? undefined : steeringConfirmations.get(confirmationId);
          if (confirmation === undefined || confirmation.connectionId !== connectionId || confirmation.deviceId !== device.deviceId || confirmation.expiresAt <= Date.now()) {
            if (confirmationId !== undefined) steeringConfirmations.delete(confirmationId);
            await sendServeError("serve/steering-confirmation-invalid", "Steering confirmation is missing, expired, or belongs to another connection");
            return;
          }
          steeringConfirmations.delete(confirmationId as string);
          if (options.driver.steerRun === undefined) {
            await sendServeError("serve/steering-unavailable", "Host steering is unavailable");
            return;
          }
          await sendServeResult(await options.driver.steerRun(confirmation.runId, confirmation.message));
          return;
        }
        if (parsed.method === "run.start" && session !== undefined) {
          const now = Date.now();
          const current = leases.get(session);
          if (current !== undefined && current.expiresAt > now && current.connectionId !== connectionId) {
            await sendServeError("serve/writer-lease-held", "Chat Writer Lease is held by another writer");
            return;
          }
          const expiresAt = now + writerLeaseMs;
          leases.set(session, { deviceId: device.deviceId, connectionId, expiresAt });
          socket.send(JSON.stringify({ version: 1, id: parsed.id, event: "writer.lease", payload: { session, held: true, expiresAt: new Date(expiresAt).toISOString() } }));
        }
        await rpc.receive(parsed);
      })().catch(() => {
        socket.send(JSON.stringify({ version: 1, id: "", error: { code: "serve/internal", message: "internal Host error" } }));
      });
    });

    socket.send(JSON.stringify({
      version: 1,
      id: "",
      event: "serve.connected",
      payload: { protocolVersion: PROTOCOL_VERSION, hostName: options.hostName, deviceId: device.deviceId },
    }));
  });

  const heartbeat = setInterval(() => {
    if (active === undefined) return;
    if (!active.alive) {
      active.socket.terminate();
      active = undefined;
      return;
    }
    active.alive = false;
    active.socket.ping();
  }, heartbeatMs);
  heartbeat.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.bind, () => resolve());
    });
  } catch (cause) {
    clearInterval(heartbeat);
    releaseServeLock();
    throw cause;
  }

  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Serve Mode did not acquire a TCP port");
  const endpoint = `https://${options.advertisedHost}:${address.port}`;

  const pairingView = async (): Promise<{ pairingPayload: string; pairingQr: string }> => {
    const pairingPayload = JSON.stringify({
      type: "picode-remote-pairing",
      protocolVersion: PROTOCOL_VERSION,
      endpoint,
      websocket: `wss://${options.advertisedHost}:${address.port}/v1/ws`,
      fingerprint: identity.fingerprint,
      bootstrapToken: pairing.token,
      pairingCode: pairing.code,
      expiresAt: new Date(pairing.expiresAt).toISOString(),
      hostName: options.hostName,
    });
    return {
      pairingPayload,
      pairingQr: await QRCode.toString(pairingPayload, { type: "terminal", small: true, errorCorrectionLevel: "M" }),
    };
  };

  let view = await pairingView();
  atomicWriteFile(dataPaths.serveInfo(), JSON.stringify({
    pid: process.pid,
    endpoint,
    fingerprint: identity.fingerprint,
    protocolVersion: PROTOCOL_VERSION,
    startedAt: new Date().toISOString(),
  }, null, 2));

  return {
    port: address.port,
    endpoint,
    fingerprint: identity.fingerprint,
    get pairingPayload() { return view.pairingPayload; },
    get pairingQr() { return view.pairingQr; },
    async rotatePairing() {
      pairing = newPairingWindow(pairingTtlMs);
      view = await pairingView();
      return view;
    },
    async close() {
      clearInterval(heartbeat);
      for (const client of sockets.clients) client.close(1001, "Serve Mode closing");
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dataPaths.serveInfo(), { force: true });
      releaseServeLock();
    },
  };
}
