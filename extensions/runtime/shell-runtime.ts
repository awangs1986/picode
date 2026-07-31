import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_MAX_BYTES = 50 * 1024;
const UPDATE_INTERVAL_MS = 120;

export type ShellKind = "bash" | "powershell" | "cmd";

export type ShellRequest = {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  pty?: boolean;
};

export type ShellResult = {
  output: string;
  exitCode: number;
  totalBytes: number;
  truncated: boolean;
  fullOutputPath?: string;
  shell: string;
  reusedSession: boolean;
  ptyNotice?: string;
};

type ShellDescriptor = {
  executable: string;
  args: string[];
  kind: ShellKind;
};

type RunHooks = {
  signal?: AbortSignal;
  onUpdate?: (output: string) => void;
};

function executableAvailable(executable: string): boolean {
  if (path.isAbsolute(executable)) return fs.existsSync(executable);
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(locator, [executable], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    timeout: 2_000,
  });
  return result.status === 0 && result.stdout.trim().length > 0;
}

export function resolvePersistentShell(): ShellDescriptor {
  if (process.platform === "win32") {
    const candidates = [
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe") : "",
      process.env["ProgramFiles(x86)"]
        ? path.join(process.env["ProgramFiles(x86)"] as string, "Git", "bin", "bash.exe")
        : "",
    ].filter(Boolean);
    const bash = candidates.find((candidate) => fs.existsSync(candidate));
    if (bash) return { executable: bash, args: ["--noprofile", "--norc"], kind: "bash" };
    if (executableAvailable("pwsh.exe")) {
      return {
        executable: "pwsh.exe",
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"],
        kind: "powershell",
      };
    }
    if (executableAvailable("powershell.exe")) {
      return {
        executable: "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"],
        kind: "powershell",
      };
    }
    return {
      executable: process.env.ComSpec || "cmd.exe",
      args: ["/Q", "/D", "/K"],
      kind: "cmd",
    };
  }
  if (fs.existsSync("/bin/bash")) {
    return { executable: "/bin/bash", args: ["--noprofile", "--norc"], kind: "bash" };
  }
  return { executable: "sh", args: [], kind: "bash" };
}

export function backgroundShellInvocation(command: string, descriptor = resolvePersistentShell()) {
  if (descriptor.kind === "powershell") {
    return {
      executable: descriptor.executable,
      arguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    };
  }
  if (descriptor.kind === "cmd") {
    return { executable: descriptor.executable, arguments: ["/D", "/S", "/C", command] };
  }
  return { executable: descriptor.executable, arguments: ["-lc", command] };
}

function quoteBash(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function quoteCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function validateEnvironment(env: Record<string, string> | undefined) {
  if (!env) return;
  for (const [name, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }
    if (value.includes("\0")) throw new Error(`Environment variable ${name} contains NUL`);
  }
}

export function buildShellFrame(
  descriptor: Pick<ShellDescriptor, "kind">,
  request: ShellRequest,
  marker: string,
): string {
  validateEnvironment(request.env);
  if (request.command.includes("\0")) throw new Error("Shell command contains NUL");
  if (descriptor.kind === "powershell") {
    const setup: string[] = [];
    if (request.cwd) setup.push(`Set-Location -LiteralPath ${quotePowerShell(request.cwd)}`);
    for (const [name, value] of Object.entries(request.env || {})) {
      setup.push(`$env:${name}=${quotePowerShell(value)}`);
    }
    const payload = Buffer.from(`${setup.join(";")}\n${request.command}`, "utf8").toString(
      "base64",
    );
    return [
      `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))`,
      "Invoke-Expression $p",
      "$s=$LASTEXITCODE",
      "if ($null -eq $s) { $s = if ($?) { 0 } else { 1 } }",
      `Write-Output ('${marker}:' + $s)`,
      "",
    ].join("\n");
  }
  if (descriptor.kind === "cmd") {
    const setup: string[] = [];
    if (request.cwd) setup.push(`cd /d ${quoteCmd(request.cwd)}`);
    for (const [name, value] of Object.entries(request.env || {})) {
      setup.push(`set "${name}=${value.replace(/"/g, '""')}"`);
    }
    return `${setup.join("\r\n")}\r\n${request.command}\r\necho ${marker}:%errorlevel%\r\n`;
  }
  const setup: string[] = [];
  if (request.cwd) setup.push(`cd -- ${quoteBash(request.cwd)}`);
  for (const [name, value] of Object.entries(request.env || {})) {
    setup.push(`export ${name}=${quoteBash(value)}`);
  }
  return `${setup.join("\n")}\n${request.command}\n__picode_status=$?\nprintf '\\n${marker}:%s\\n' "$__picode_status"\n`;
}

export class BoundedShellOutput {
  readonly maxBytes: number;
  totalBytes = 0;
  private tail = Buffer.alloc(0);

  constructor(maxBytes = DEFAULT_MAX_BYTES) {
    this.maxBytes = maxBytes;
  }

  append(value: Buffer | string) {
    const next = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.totalBytes += next.byteLength;
    const combined = Buffer.concat([this.tail, next]);
    this.tail =
      combined.byteLength > this.maxBytes
        ? combined.subarray(combined.byteLength - this.maxBytes)
        : combined;
  }

  text(): string {
    return this.tail.toString("utf8").replace(/^\uFFFD/, "");
  }

  get truncated(): boolean {
    return this.totalBytes > this.maxBytes;
  }
}

type PendingRun = {
  marker: string;
  markerTail: string;
  output: BoundedShellOutput;
  artifactPath: string;
  artifact: fs.WriteStream;
  lastUpdate: number;
  hooks: RunHooks;
  resolve: (result: ShellResult) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
  abort?: () => void;
  reusedSession: boolean;
  ptyNotice?: string;
};

class PersistentShellSession {
  readonly descriptor: ShellDescriptor;
  readonly initialCwd: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending: PendingRun | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private startedOnce = false;

  constructor(descriptor: ShellDescriptor, cwd: string) {
    this.descriptor = descriptor;
    this.initialCwd = cwd;
  }

  execute(request: ShellRequest, hooks: RunHooks): Promise<ShellResult> {
    const run = this.queue.then(() => this.executeNow(request, hooks));
    this.queue = run.catch(() => undefined);
    return run;
  }

  dispose(reason = "Shell session disposed") {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      this.finishArtifact(pending, true);
      pending.reject(new Error(reason));
    }
    const child = this.child;
    this.child = null;
    if (!child?.pid) return;
    if (process.platform === "win32") {
      spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }

  private ensureStarted(): boolean {
    if (this.child && !this.child.killed && this.child.exitCode === null) return true;
    const reused = this.startedOnce;
    this.startedOnce = true;
    const child = spawn(this.descriptor.executable, this.descriptor.args, {
      cwd: this.initialCwd,
      env: {
        ...process.env,
        PAGER: "cat",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
        NO_COLOR: "1",
      },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => this.consume(chunk, false));
    child.once("error", (error) => this.failPending(error));
    child.once("exit", (code) => {
      this.child = null;
      if (this.pending)
        this.failPending(new Error(`Shell exited before completion (${code ?? "unknown"})`));
    });
    return reused;
  }

  private async executeNow(request: ShellRequest, hooks: RunHooks): Promise<ShellResult> {
    if (!request.command.trim()) throw new Error("Shell command is required");
    if (hooks.signal?.aborted) throw new Error("Shell command aborted");
    if (request.cwd && !fs.statSync(request.cwd).isDirectory()) {
      throw new Error(`Working directory is not a directory: ${request.cwd}`);
    }
    const reusedSession = this.ensureStarted();
    const child = this.child;
    if (!child) throw new Error("Shell failed to start");
    const marker = `__PIC_${randomUUID().replace(/-/g, "")}__`;
    const artifactPath = path.join(os.tmpdir(), `picode-shell-${randomUUID()}.log`);
    const artifact = fs.createWriteStream(artifactPath, { flags: "wx" });
    return await new Promise<ShellResult>((resolve, reject) => {
      const pending: PendingRun = {
        marker,
        markerTail: "",
        output: new BoundedShellOutput(),
        artifactPath,
        artifact,
        lastUpdate: 0,
        hooks,
        resolve,
        reject,
        reusedSession,
        ptyNotice: request.pty
          ? "PTY was requested, but Picode's embedded GUI shell currently uses a streamed non-PTY session."
          : undefined,
      };
      const timeoutSeconds = request.timeout;
      if (timeoutSeconds !== undefined) {
        if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 3600) {
          artifact.end();
          reject(new Error("Shell timeout must be between 1 and 3600 seconds"));
          return;
        }
        pending.timeout = setTimeout(() => {
          this.pending = null;
          this.finishArtifact(pending, true);
          this.dispose();
          reject(new Error(`Shell command timed out after ${timeoutSeconds} seconds`));
        }, timeoutSeconds * 1000);
      }
      if (hooks.signal) {
        pending.abort = () => {
          this.pending = null;
          this.finishArtifact(pending, true);
          this.dispose();
          reject(new Error("Shell command aborted"));
        };
        hooks.signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.pending = pending;
      child.stdin.write(buildShellFrame(this.descriptor, request, marker));
    });
  }

  private consume(chunk: Buffer, markerStream: boolean) {
    const pending = this.pending;
    if (!pending) return;
    pending.artifact.write(chunk);
    pending.output.append(chunk);
    const now = Date.now();
    if (pending.hooks.onUpdate && now - pending.lastUpdate >= UPDATE_INTERVAL_MS) {
      pending.lastUpdate = now;
      pending.hooks.onUpdate(pending.output.text());
    }
    if (!markerStream) return;
    pending.markerTail = `${pending.markerTail}${chunk.toString("utf8")}`.slice(-512);
    const match = pending.markerTail.match(new RegExp(`${pending.marker}:(-?\\d+)`));
    if (!match) return;
    this.pending = null;
    if (pending.timeout) clearTimeout(pending.timeout);
    if (pending.abort && pending.hooks.signal) {
      pending.hooks.signal.removeEventListener("abort", pending.abort);
    }
    const markerPattern = new RegExp(`(?:\\r?\\n)?${pending.marker}:-?\\d+(?:\\r?\\n)?`, "g");
    const output = pending.output.text().replace(markerPattern, "").trimEnd();
    const truncated = pending.output.truncated;
    this.finishArtifact(pending, !truncated);
    pending.resolve({
      output: output || "(no output)",
      exitCode: Number.parseInt(match[1], 10),
      totalBytes: pending.output.totalBytes,
      truncated,
      fullOutputPath: truncated ? pending.artifactPath : undefined,
      shell: this.descriptor.executable,
      reusedSession: pending.reusedSession,
      ptyNotice: pending.ptyNotice,
    });
  }

  private failPending(error: Error) {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    if (pending.timeout) clearTimeout(pending.timeout);
    if (pending.abort && pending.hooks.signal) {
      pending.hooks.signal.removeEventListener("abort", pending.abort);
    }
    this.finishArtifact(pending, true);
    pending.reject(error);
  }

  private finishArtifact(pending: PendingRun, remove: boolean) {
    pending.artifact.end(() => {
      if (remove) fs.rm(pending.artifactPath, { force: true }, () => undefined);
    });
  }
}

export class PersistentShellPool {
  private readonly sessions = new Map<string, PersistentShellSession>();
  private readonly descriptor: ShellDescriptor;

  constructor(descriptor = resolvePersistentShell()) {
    this.descriptor = descriptor;
  }

  execute(sessionId: string, cwd: string, request: ShellRequest, hooks: RunHooks = {}) {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = new PersistentShellSession(this.descriptor, cwd);
      this.sessions.set(sessionId, session);
    }
    return session.execute(request, hooks);
  }

  dispose(sessionId?: string) {
    if (sessionId) {
      this.sessions.get(sessionId)?.dispose();
      this.sessions.delete(sessionId);
      return;
    }
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }

  get size() {
    return this.sessions.size;
  }
}
