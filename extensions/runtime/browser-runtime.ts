import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { WebSocket } from "ws";

type BrowserApp = {
  path?: string;
  cdp_url?: string;
  args?: string[];
  auto_install?: boolean;
};

export type BrowserRequest = {
  action: "open" | "run" | "close";
  name?: string;
  url?: string;
  code?: string;
  timeout?: number;
  headless?: boolean;
  app?: BrowserApp;
  all?: boolean;
  kill?: boolean;
};

export type BrowserScreenshot = {
  data: string;
  mimeType: "image/png";
  bytes: number;
};

export type BrowserResult = {
  text: string;
  action: BrowserRequest["action"];
  name: string;
  url?: string;
  title?: string;
  screenshots?: BrowserScreenshot[];
  value?: unknown;
};

type CdpResponse = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string; data?: string };
};

type PendingCdp = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export function browserExecutableCandidates(platform = process.platform): string[] {
  if (platform === "win32") {
    return [
      process.env.PICODE_BROWSER_PATH,
      process.env.ProgramFiles
        ? path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe")
        : undefined,
      process.env["ProgramFiles(x86)"]
        ? path.join(
            process.env["ProgramFiles(x86)"] as string,
            "Google",
            "Chrome",
            "Application",
            "chrome.exe",
          )
        : undefined,
      process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
        : undefined,
      process.env.ProgramFiles
        ? path.join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe")
        : undefined,
      process.env["ProgramFiles(x86)"]
        ? path.join(
            process.env["ProgramFiles(x86)"] as string,
            "Microsoft",
            "Edge",
            "Application",
            "msedge.exe",
          )
        : undefined,
    ].filter((value): value is string => Boolean(value));
  }
  if (platform === "darwin") {
    return [
      process.env.PICODE_BROWSER_PATH,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ].filter((value): value is string => Boolean(value));
  }
  return [
    process.env.PICODE_BROWSER_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ].filter((value): value is string => Boolean(value));
}

export function resolveBrowserExecutable(explicit?: string): string | null {
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!fs.existsSync(resolved)) throw new Error(`Browser executable does not exist: ${resolved}`);
    return resolved;
  }
  return browserExecutableCandidates().find((candidate) => fs.existsSync(candidate)) || null;
}

export function browserDownloadPlatform(
  platform = process.platform,
  architecture = process.arch,
): "win64" | "mac-x64" | "mac-arm64" | "linux64" | null {
  if (platform === "win32" && architecture === "x64") return "win64";
  if (platform === "linux" && architecture === "x64") return "linux64";
  if (platform === "darwin" && architecture === "x64") return "mac-x64";
  if (platform === "darwin" && architecture === "arm64") return "mac-arm64";
  return null;
}

export function isRecoverableBrowserError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/Timed out waiting for selector/u.test(message)) return false;
  return /Browser code timed out|CDP connection|CDP endpoint|connection is not open|connection closed|Target closed|Execution context was destroyed|browser process exited/iu.test(
    message,
  );
}

const CHROME_FOR_TESTING_MANIFEST =
  "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";
const CHROME_FOR_TESTING_HOST = "storage.googleapis.com";
const MAX_BROWSER_ARCHIVE_BYTES = 512 * 1024 * 1024;
let chromiumInstallPromise: Promise<string> | undefined;

function managedBrowserRoot(): string {
  return (
    process.env.PICODE_BROWSER_CACHE?.trim() ||
    path.join(os.homedir(), ".pi", "agent", "picode-browser")
  );
}

function findManagedChromium(root: string): string | null {
  const executableNames = new Set(
    process.platform === "win32"
      ? ["chrome.exe"]
      : process.platform === "darwin"
        ? ["Google Chrome for Testing", "chrome"]
        : ["chrome"],
  );
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth > 6) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(current.directory, entry.name);
      if (entry.isFile() && executableNames.has(entry.name)) return candidate;
      if (entry.isDirectory()) queue.push({ directory: candidate, depth: current.depth + 1 });
    }
  }
  return null;
}

async function downloadBrowserArchive(url: string, destination: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== CHROME_FOR_TESTING_HOST) {
    throw new Error("Refusing a Chromium download from an untrusted host");
  }
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Chromium download failed: HTTP ${response.status}`);
  }
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_BROWSER_ARCHIVE_BYTES) {
    throw new Error("Chromium download exceeds Picode's 512 MiB limit");
  }
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const file = fs.createWriteStream(destination, { flags: "wx" });
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.byteLength;
      if (total > MAX_BROWSER_ARCHIVE_BYTES) {
        throw new Error("Chromium download exceeds Picode's 512 MiB limit");
      }
      if (!file.write(chunk)) await new Promise<void>((resolve) => file.once("drain", resolve));
    }
    await new Promise<void>((resolve, reject) => {
      file.end((error?: Error) => (error ? reject(error) : resolve()));
    });
  } catch (error) {
    file.destroy();
    await fs.promises.rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
}

function extractBrowserArchive(archive: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  const tar = spawnSync("tar", ["-xf", archive, "-C", destination], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  if (tar.status === 0) return;
  if (process.platform === "win32") {
    const powershell = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
        archive,
        destination,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 120_000 },
    );
    if (powershell.status === 0) return;
  }
  throw new Error(
    `Chromium archive extraction failed: ${tar.stderr || tar.error || "unknown error"}`,
  );
}

async function installChromium(): Promise<string> {
  const platform = browserDownloadPlatform();
  if (!platform) {
    throw new Error(
      `Automatic Chromium installation is unsupported on ${process.platform}/${process.arch}`,
    );
  }
  const root = managedBrowserRoot();
  const existing = findManagedChromium(root);
  if (existing) return existing;
  const manifestResponse = await fetch(CHROME_FOR_TESTING_MANIFEST);
  if (!manifestResponse.ok) {
    throw new Error(`Chromium version manifest failed: HTTP ${manifestResponse.status}`);
  }
  const manifest = (await manifestResponse.json()) as {
    channels?: {
      Stable?: {
        version?: string;
        downloads?: { chrome?: Array<{ platform: string; url: string }> };
      };
    };
  };
  const stable = manifest.channels?.Stable;
  const download = stable?.downloads?.chrome?.find((item) => item.platform === platform);
  if (!stable?.version || !download?.url)
    throw new Error("Chromium version manifest has no Stable download");
  const finalRoot = path.join(root, stable.version, platform);
  const finalExecutable = findManagedChromium(finalRoot);
  if (finalExecutable) return finalExecutable;
  const staging = `${finalRoot}.staging-${process.pid}-${Date.now()}`;
  const archive = path.join(root, `${stable.version}-${platform}.zip`);
  try {
    await fs.promises.rm(archive, { force: true });
    await downloadBrowserArchive(download.url, archive);
    extractBrowserArchive(archive, staging);
    const executable = findManagedChromium(staging);
    if (!executable) throw new Error("Chromium archive did not contain a supported executable");
    fs.mkdirSync(path.dirname(finalRoot), { recursive: true });
    fs.renameSync(staging, finalRoot);
    if (process.platform !== "win32")
      fs.chmodSync(path.join(finalRoot, path.relative(staging, executable)), 0o755);
    return findManagedChromium(finalRoot) || executable;
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    await fs.promises.rm(archive, { force: true }).catch(() => undefined);
  }
}

export async function resolveBrowserExecutableOrInstall(
  explicit?: string,
  autoInstall = true,
): Promise<string | null> {
  const local = resolveBrowserExecutable(explicit);
  if (local || !autoInstall) return local;
  chromiumInstallPromise ||= installChromium().catch((error) => {
    chromiumInstallPromise = undefined;
    throw error;
  });
  return chromiumInstallPromise;
}

class CdpClient {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCdp>();
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (raw) => this.receive(String(raw)));
    socket.on("close", () => this.failAll(new Error("Browser CDP connection closed")));
    socket.on("error", (error) => this.failAll(error));
  }

  static async connect(url: string, timeoutMs: number): Promise<CdpClient> {
    return await new Promise<CdpClient>((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error(`Timed out connecting to browser CDP after ${timeoutMs}ms`));
      }, timeoutMs);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve(new CdpClient(socket));
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Browser CDP connection is not open"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const handler = (params: unknown) => {
        clearTimeout(timer);
        this.listeners.get(method)?.delete(handler);
        resolve(params);
      };
      const timer = setTimeout(() => {
        this.listeners.get(method)?.delete(handler);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const set = this.listeners.get(method) || new Set();
      set.add(handler);
      this.listeners.set(method, set);
    });
  }

  close() {
    this.socket.close();
  }

  private receive(raw: string) {
    let message: CdpResponse;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error([message.error.message, message.error.data].filter(Boolean).join(": ")),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) {
      for (const listener of this.listeners.get(message.method) || []) listener(message.params);
    }
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

type BrowserHost = {
  baseUrl: string;
  process?: ChildProcess;
  userDataDir?: string;
  external: boolean;
  refs: number;
  launchRequest: BrowserRequest;
};

type BrowserTab = {
  sessionId: string;
  name: string;
  targetId: string;
  client: CdpClient;
  host: BrowserHost;
  context: vm.Context;
  lastUrl: string;
};

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function normalizeCdpUrl(value: string) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Browser cdp_url must be HTTP(S)");
  return url.toString().replace(/\/$/, "");
}

async function waitForJson<T>(url: string, timeoutMs: number, init?: RequestInit): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return (await response.json()) as T;
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Browser CDP endpoint unavailable: ${String(lastError || url)}`);
}

async function startBrowser(request: BrowserRequest): Promise<BrowserHost> {
  if (request.app?.cdp_url) {
    const baseUrl = normalizeCdpUrl(request.app.cdp_url);
    await waitForJson(`${baseUrl}/json/version`, 5_000);
    return { baseUrl, external: true, refs: 0, launchRequest: { ...request, action: "open" } };
  }
  const executable = await resolveBrowserExecutableOrInstall(
    request.app?.path,
    request.app?.auto_install !== false,
  );
  if (!executable) {
    throw new Error(
      "No Chrome, Chromium, or Edge executable was found. Set app.path/PICODE_BROWSER_PATH or enable app.auto_install.",
    );
  }
  const port = await freePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "picode-browser-"));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-features=Translate",
    ...(request.headless === false ? [] : ["--headless=new", "--disable-gpu"]),
    ...(request.app?.args || []),
    "about:blank",
  ];
  const child = spawn(executable, args, {
    detached: process.platform !== "win32",
    stdio: "ignore",
    windowsHide: true,
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForJson(`${baseUrl}/json/version`, 30_000);
  } catch (error) {
    child.kill();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  }
  return {
    baseUrl,
    process: child,
    userDataDir,
    external: false,
    refs: 0,
    launchRequest: { ...request, action: "open" },
  };
}

async function createTab(host: BrowserHost, sessionId: string, name: string, url?: string) {
  const target = await waitForJson<{
    id: string;
    webSocketDebuggerUrl: string;
    url?: string;
  }>(`${host.baseUrl}/json/new?${encodeURIComponent(url || "about:blank")}`, 10_000, {
    method: "PUT",
  });
  const client = await CdpClient.connect(target.webSocketDebuggerUrl, 10_000);
  await Promise.all([client.send("Page.enable"), client.send("Runtime.enable")]);
  host.refs += 1;
  return {
    sessionId,
    name,
    targetId: target.id,
    client,
    host,
    context: vm.createContext({}),
    lastUrl: url || "about:blank",
  } satisfies BrowserTab;
}

function expressionForFunction(fn: unknown, args: unknown[]) {
  if (typeof fn === "function") return `(${fn.toString()})(...${JSON.stringify(args)})`;
  return String(fn);
}

function remoteValue(response: unknown) {
  const result = (
    response as { result?: { value?: unknown; description?: string }; exceptionDetails?: unknown }
  )?.result;
  if ((response as { exceptionDetails?: unknown })?.exceptionDetails) {
    throw new Error(
      `Browser evaluation failed: ${JSON.stringify((response as { exceptionDetails: unknown }).exceptionDetails)}`,
    );
  }
  return result?.value ?? result?.description;
}

async function evaluate(tab: BrowserTab, expression: string) {
  const response = await tab.client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  return remoteValue(response);
}

async function closeHost(host: BrowserHost, kill: boolean) {
  if (host.external) return;
  if (host.process && (kill || host.refs <= 0)) host.process.kill();
  if (host.userDataDir && (kill || host.refs <= 0)) {
    fs.rm(host.userDataDir, { recursive: true, force: true }, () => undefined);
  }
}

export class BrowserAutomationRuntime {
  private readonly tabs = new Map<string, BrowserTab>();
  private readonly hosts = new Map<string, BrowserHost>();

  private async recycleTab(key: string, tab: BrowserTab): Promise<void> {
    const oldHost = tab.host;
    const launchRequest = oldHost.launchRequest;
    const hostKeys = [...this.hosts.entries()]
      .filter(([, candidate]) => candidate === oldHost)
      .map(([hostKey]) => hostKey);
    try {
      await waitForJson(`${oldHost.baseUrl}/json/version`, 2_000);
    } catch {
      const affectedTabs = [...this.tabs.entries()].filter(
        ([, candidate]) => candidate.host === oldHost,
      );
      for (const [tabKey, candidate] of affectedTabs) {
        try {
          candidate.client.close();
        } catch {}
        this.tabs.delete(tabKey);
      }
      oldHost.refs = 0;
      await closeHost(oldHost, true);
      for (const [hostKey, candidate] of this.hosts) {
        if (candidate === oldHost) this.hosts.delete(hostKey);
      }
      const host = await startBrowser(launchRequest);
      for (const hostKey of hostKeys) this.hosts.set(hostKey, host);
      for (const [tabKey, candidate] of affectedTabs) {
        const replacement = await createTab(
          host,
          candidate.sessionId,
          candidate.name,
          candidate.lastUrl,
        );
        this.tabs.set(tabKey, replacement);
      }
      return;
    }

    try {
      tab.client.close();
    } catch {}
    try {
      await fetch(`${oldHost.baseUrl}/json/close/${tab.targetId}`);
    } catch {}
    this.tabs.delete(key);
    oldHost.refs = Math.max(0, oldHost.refs - 1);
    const replacement = await createTab(oldHost, tab.sessionId, tab.name, tab.lastUrl);
    this.tabs.set(key, replacement);
  }

  async execute(
    sessionId: string,
    request: BrowserRequest,
    signal?: AbortSignal,
  ): Promise<BrowserResult> {
    const name = request.name?.trim() || "main";
    const key = `${sessionId}:${name}`;
    const timeoutMs = Math.min(Math.max((request.timeout ?? 30) * 1000, 1_000), 300_000);
    if (signal?.aborted) throw new Error("Browser operation aborted");
    if (request.action === "open") {
      let tab = this.tabs.get(key);
      const reused = Boolean(tab);
      if (!tab) {
        const hostKey = request.app?.cdp_url
          ? `external:${normalizeCdpUrl(request.app.cdp_url)}`
          : `${sessionId}:${request.app?.path || "default"}:${request.headless !== false}`;
        let host = this.hosts.get(hostKey);
        if (!host) {
          host = await startBrowser(request);
          this.hosts.set(hostKey, host);
        }
        tab = await createTab(host, sessionId, name, request.url);
        this.tabs.set(key, tab);
      } else if (request.url) {
        await this.goto(tab, request.url, timeoutMs);
      }
      let url: unknown;
      let title: unknown;
      try {
        [url, title] = await Promise.all([
          evaluate(tab, "location.href"),
          evaluate(tab, "document.title"),
        ]);
      } catch (error) {
        if (isRecoverableBrowserError(error)) await this.recycleTab(key, tab);
        throw error;
      }
      tab.lastUrl = String(url);
      return {
        text: `${reused ? "Reused" : "Opened"} browser tab "${name}" at ${url}`,
        action: "open",
        name,
        url: String(url),
        title: String(title),
      };
    }
    if (request.action === "close") {
      const targets = request.all
        ? [...this.tabs.entries()].filter(([, tab]) => tab.sessionId === sessionId)
        : [...this.tabs.entries()].filter(([tabKey]) => tabKey === key);
      for (const [tabKey, tab] of targets) {
        tab.client.close();
        this.tabs.delete(tabKey);
        tab.host.refs = Math.max(0, tab.host.refs - 1);
        try {
          await fetch(`${tab.host.baseUrl}/json/close/${tab.targetId}`);
        } catch {
          // CDP target may already be gone.
        }
        if (tab.host.refs === 0) await closeHost(tab.host, request.kill === true);
        if (tab.host.refs === 0) {
          for (const [hostKey, host] of this.hosts) {
            if (host === tab.host) this.hosts.delete(hostKey);
          }
        }
      }
      return {
        text:
          targets.length > 0 ? `Closed ${targets.length} browser tab(s)` : `No tab named "${name}"`,
        action: "close",
        name,
      };
    }
    const tab = this.tabs.get(key);
    if (!tab) throw new Error(`Browser tab "${name}" is not open`);
    if (!request.code?.trim()) throw new Error("Browser run requires code");
    const displays: string[] = [];
    const screenshots: BrowserScreenshot[] = [];
    try {
      const helper = this.tabHelper(tab, timeoutMs, screenshots);
      Object.assign(tab.context, {
        tab: helper,
        page: helper,
        display: (value: unknown) =>
          displays.push(typeof value === "string" ? value : JSON.stringify(value, null, 2)),
        print: (...values: unknown[]) => displays.push(values.map(String).join(" ")),
        assert: (condition: unknown, message = "Browser assertion failed") => {
          if (!condition) throw new Error(message);
        },
        wait: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
        console,
      });
      const script = new vm.Script(`(async () => {\n${request.code}\n})()`, {
        filename: `picode-browser-${name}.js`,
      });
      const promise = script.runInContext(tab.context, { timeout: timeoutMs }) as Promise<unknown>;
      const value = await this.withDeadline(Promise.resolve(promise), timeoutMs, signal);
      const [url, title] = await Promise.all([
        evaluate(tab, "location.href"),
        evaluate(tab, "document.title"),
      ]);
      tab.lastUrl = String(url);
      const valueText =
        value === undefined
          ? ""
          : typeof value === "string"
            ? value
            : JSON.stringify(value, null, 2);
      return {
        text: [...displays, valueText].filter(Boolean).join("\n") || `Ran code on tab "${name}"`,
        action: "run",
        name,
        url: String(url),
        title: String(title),
        screenshots: screenshots.length > 0 ? screenshots : undefined,
        value,
      };
    } catch (error) {
      if (isRecoverableBrowserError(error)) {
        await this.recycleTab(key, tab).catch(() => undefined);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}. Browser tab was recycled; retry the operation.`,
        );
      }
      throw error;
    }
  }

  async dispose(sessionId?: string) {
    const targets = [...this.tabs.entries()].filter(
      ([, tab]) => !sessionId || tab.sessionId === sessionId,
    );
    for (const [key, tab] of targets) {
      tab.client.close();
      this.tabs.delete(key);
      tab.host.refs = Math.max(0, tab.host.refs - 1);
      if (tab.host.refs === 0) await closeHost(tab.host, true);
    }
    if (!sessionId) this.hosts.clear();
  }

  snapshot() {
    return {
      tabs: this.tabs.size,
      browserProcesses: [...this.hosts.values()].filter((host) => !host.external).length,
    };
  }

  private tabHelper(tab: BrowserTab, timeoutMs: number, screenshots: BrowserScreenshot[]) {
    return {
      url: () => evaluate(tab, "location.href"),
      title: () => evaluate(tab, "document.title"),
      goto: (url: string) => this.goto(tab, url, timeoutMs),
      evaluate: (fn: unknown, ...args: unknown[]) => evaluate(tab, expressionForFunction(fn, args)),
      extract: () => evaluate(tab, "document.body ? document.body.innerText : ''"),
      observe: () =>
        evaluate(
          tab,
          `(() => {
            const selector = 'a,button,input,textarea,select,[role="button"],[tabindex]';
            return [...document.querySelectorAll(selector)].slice(0, 500).map((el, index) => {
              const id = 'e' + (index + 1); el.setAttribute('data-picode-ref', id);
              const rect = el.getBoundingClientRect();
              return { id, tag: el.tagName.toLowerCase(), text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 300), visible: rect.width > 0 && rect.height > 0 };
            });
          })()`,
        ),
      ariaSnapshot: async () => {
        const tree = await tab.client.send("Accessibility.getFullAXTree");
        return tree;
      },
      click: (selector: string) => this.elementAction(tab, selector, "el.click(); return true"),
      fill: (selector: string, value: string) =>
        this.elementAction(
          tab,
          selector,
          `el.focus(); el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true`,
        ),
      type: (selector: string, value: string) =>
        this.elementAction(
          tab,
          selector,
          `el.focus(); el.value=(el.value||'')+${JSON.stringify(value)}; el.dispatchEvent(new Event('input',{bubbles:true})); return true`,
        ),
      press: (key: string) =>
        tab.client
          .send("Input.dispatchKeyEvent", { type: "keyDown", key })
          .then(() => tab.client.send("Input.dispatchKeyEvent", { type: "keyUp", key })),
      waitFor: (selector: string, options?: { timeout?: number }) =>
        this.waitForSelector(tab, selector, Math.min(options?.timeout || 15_000, timeoutMs)),
      screenshot: async (options?: { fullPage?: boolean; silent?: boolean }) => {
        const response = await tab.client.send<{ data?: string }>("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: options?.fullPage === true,
        });
        if (!response.data) throw new Error("Browser returned an empty screenshot");
        const screenshot = {
          data: response.data,
          mimeType: "image/png" as const,
          bytes: Buffer.byteLength(response.data, "base64"),
        };
        if (!options?.silent) screenshots.push(screenshot);
        return screenshot;
      },
      scroll: (deltaX: number, deltaY: number) =>
        tab.client.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: 1,
          y: 1,
          deltaX,
          deltaY,
        }),
    };
  }

  private async goto(tab: BrowserTab, url: string, timeoutMs: number) {
    const loaded = tab.client.once("Page.loadEventFired", timeoutMs).catch(() => undefined);
    await tab.client.send("Page.navigate", { url });
    await loaded;
    const currentUrl = String(await evaluate(tab, "location.href"));
    tab.lastUrl = currentUrl;
    return currentUrl;
  }

  private elementAction(tab: BrowserTab, selector: string, body: string) {
    const query = selector.startsWith("e")
      ? `[data-picode-ref=${JSON.stringify(selector)}]`
      : selector;
    return evaluate(
      tab,
      `(() => { const el=document.querySelector(${JSON.stringify(query)}); if(!el) throw new Error('Element not found: ${selector.replace(/'/g, "\\'")}'); ${body}; })()`,
    );
  }

  private async waitForSelector(tab: BrowserTab, selector: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(tab, `Boolean(document.querySelector(${JSON.stringify(selector)}))`))
        return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for selector: ${selector}`);
  }

  private async withDeadline<T>(
    promise: Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Browser code timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      const abort = () => reject(new Error("Browser operation aborted"));
      signal?.addEventListener("abort", abort, { once: true });
      promise.then(resolve, reject).finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      });
    });
  }
}
