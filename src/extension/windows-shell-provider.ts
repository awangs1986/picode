import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, win32 } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import {
  provideLandstripShell,
  type LandstripShellProvider,
} from "pi-landstrip/api";

const WINDOWS_LAUNCHER_KEYS = [
  "PATH",
  "HOME",
  "ProgramData",
  "SystemRoot",
  "windir",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
] as const;

function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function launcherEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const key of WINDOWS_LAUNCHER_KEYS) {
    const value = env[key];
    if (value !== undefined) selected[key] = value;
  }
  return selected;
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Git Bash cannot reliably start in Windows AppContainer and pi-landstrip's
 * POSIX bootstrap omits Windows process variables. This provider keeps the
 * Landstrip policy boundary but uses the OS PowerShell host on Windows.
 *
 * The composed command environment can contain credentials, so it travels in
 * a private temporary file admitted through readPaths rather than launcherEnv.
 */
export function createWindowsPowerShellProvider(
  hostEnv: NodeJS.ProcessEnv = process.env,
  temporaryRoot = tmpdir(),
): LandstripShellProvider {
  const systemRoot = hostEnv.SystemRoot;
  if (systemRoot === undefined || systemRoot.trim() === "") {
    throw new Error("SystemRoot is required for the Windows PowerShell sandbox provider");
  }
  const executable = win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );

  return {
    id: "picode-windows-powershell",
    prepare(options) {
      if (options.signal?.aborted) throw new Error("aborted");
      const directory = mkdtempSync(join(temporaryRoot, "picode-powershell-"));
      const environmentPath = join(directory, "environment.json");
      const commandPath = join(directory, "command.ps1");
      const bootstrap = [
        "$picodeUtf8 = New-Object System.Text.UTF8Encoding($false)",
        "[Console]::InputEncoding = $picodeUtf8",
        "[Console]::OutputEncoding = $picodeUtf8",
        "$OutputEncoding = $picodeUtf8",
        "$ErrorActionPreference = 'Stop'",
        `$picodeEnvironment = Get-Content -Encoding UTF8 -Raw -LiteralPath ${quotePowerShellLiteral(environmentPath)} | ConvertFrom-Json`,
        "foreach ($picodeProperty in $picodeEnvironment.PSObject.Properties) {",
        "  [Environment]::SetEnvironmentVariable($picodeProperty.Name, [string]$picodeProperty.Value, 'Process')",
        "}",
        `Set-Location -LiteralPath ${quotePowerShellLiteral(options.cwd)}`,
        options.command,
        "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }",
        "if (-not $?) { exit 1 }",
      ].join("\r\n");
      writeFileSync(environmentPath, JSON.stringify(definedEnvironment(options.env)), {
        encoding: "utf8",
        mode: 0o600,
      });
      // Windows PowerShell 5.1 interprets BOM-less scripts using the active
      // ANSI code page. A BOM is therefore required for non-ASCII commands,
      // paths and literals. PowerShell 7 also accepts this encoding.
      writeFileSync(commandPath, `\uFEFF${bootstrap}`, { encoding: "utf8", mode: 0o600 });
      let disposed = false;
      return {
        executable,
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          commandPath,
        ],
        launcherEnv: launcherEnvironment(hostEnv),
        readPaths: [environmentPath, commandPath],
        dispose() {
          if (disposed) return;
          disposed = true;
          rmSync(directory, { recursive: true, force: true });
        },
      };
    },
  };
}

/** Register only on Windows; other platforms retain pi-landstrip's POSIX provider. */
export function registerWindowsPowerShellProvider(
  pi: ExtensionAPI,
  platform = process.platform,
): () => void {
  if (platform !== "win32") return () => undefined;
  const provider = createWindowsPowerShellProvider();
  const operations = createWindowsPowerShellOperations(provider);
  // Pi's RPC `bash` command is a user_bash lifecycle event, not a model tool
  // invocation. Registering only the tool definition therefore leaves the
  // headless/public RPC path on upstream's default shell. Keep both seams on
  // the same provider so TUI, agent tools and headless automation agree.
  pi.on("user_bash", () => ({ operations }));
  return provideLandstripShell(pi, provider);
}

/**
 * P0-P4 Windows host execution path. Guard still authorizes every tool intent,
 * while this operation replaces Landstrip's disabled-sandbox fallback (which
 * currently drops stdout) with Pi's normal bash schema and renderer.
 */
export function createWindowsPowerShellOperations(
  provider = createWindowsPowerShellProvider(),
): BashOperations {
  return {
    async exec(command, cwd, options) {
      const invocation = await provider.prepare({
        command,
        cwd,
        env: { ...process.env, ...options.env },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      try {
        return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
          const child = spawn(invocation.executable, [...invocation.args], {
            cwd,
            env: invocation.launcherEnv,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let settled = false;
          let timedOut = false;
          const timeout = options.timeout === undefined || options.timeout <= 0
            ? undefined
            : setTimeout(() => {
              timedOut = true;
              child.kill();
            }, options.timeout * 1_000);
          const finish = (error?: Error, exitCode: number | null = null): void => {
            if (settled) return;
            settled = true;
            if (timeout !== undefined) clearTimeout(timeout);
            options.signal?.removeEventListener("abort", abort);
            if (error !== undefined) reject(error);
            else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
            else resolve({ exitCode });
          };
          const abort = (): void => { child.kill(); };
          child.stdout.on("data", options.onData);
          child.stderr.on("data", options.onData);
          child.once("error", (error) => finish(error));
          child.once("close", (code) => finish(undefined, code));
          options.signal?.addEventListener("abort", abort, { once: true });
          if (options.signal?.aborted) abort();
        });
      } finally {
        await invocation.dispose?.();
      }
    },
  };
}

export function registerWindowsPowerShellTool(
  pi: ExtensionAPI,
  cwd: string,
  platform = process.platform,
): void {
  if (platform !== "win32") return;
  const tool = createBashToolDefinition(cwd, {
    operations: createWindowsPowerShellOperations(),
  });
  pi.registerTool({
    ...tool,
    description: [
      "Execute a Windows PowerShell 5.1 command in the current working directory.",
      "Use PowerShell syntax and cmdlets such as Get-ChildItem, Get-Content, Select-String, and Get-Location.",
      "Do not use POSIX shell operators or commands such as pwd, ls -la, grep, or &&.",
      "Returns UTF-8 stdout and stderr.",
    ].join(" "),
  });
}
