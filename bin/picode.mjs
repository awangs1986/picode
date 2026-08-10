#!/usr/bin/env node
/**
 * picode 启动器（PICODE-V3-DESIGN.md §1/§3.6）：
 * 数据目录初始化 → 套件核对 → spawn vendored pi。
 *
 * vendored pi 以依赖形式随 Picode 分发（V2 模式）；
 * PI_CODING_AGENT_DIR 指向 ~/.picode/agent，与系统 pi 完全隔离。
 * 扩展套件注入姿势待 Spike 7（settings 合并 vs 启动参数）定稿。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPiLaunch, consumeWorkspaceSwitchRequest, PI_PACKAGE, resolveCursorSdkExtension, resolveVendoredPi } from "./picode-launch.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const productManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const rawUserArgs = process.argv.slice(2);

if (rawUserArgs.length === 1 && (rawUserArgs[0] === "--version" || rawUserArgs[0] === "-V")) {
  console.log(productManifest.version);
  process.exit(0);
}

const picodeDir = process.env.PICODE_DIR ?? join(homedir(), ".picode");
const agentDir = join(picodeDir, "agent");

for (const dir of [
  picodeDir,
  agentDir,
  join(agentDir, "sessions"),
  join(picodeDir, "tasks"),
  join(picodeDir, "evidence"),
  join(picodeDir, "metrics"),
  join(picodeDir, "imports"),
]) {
  mkdirSync(dir, { recursive: true });
}

let piEntry;
try {
  // 通过公开 SDK export 定位 dist，再进入同目录的 CLI；不依赖被 exports 隐藏的子路径。
  piEntry = resolveVendoredPi({ resolve: (specifier) => import.meta.resolve(specifier) });
} catch {
  console.error(
    `[picode] vendored Pi (${PI_PACKAGE}) not found. Run \`npm install\` in the Picode package first.`,
  );
  process.exit(1);
}

if (!existsSync(piEntry)) {
  console.error(`[picode] resolved pi entry does not exist: ${piEntry}`);
  process.exit(1);
}

const controlSubjects = new Set(["run", "rpc", "session", "subagent", "slice", "capsule", "worktree", "capability", "chat", "task", "gate", "harness", "permissions", "account", "tools", "doctor", "help"]);
let userArgs = process.argv.slice(2);
if (userArgs[0] === "tui") userArgs = userArgs.slice(1);
const productHelp = userArgs.length === 1 && (userArgs[0] === "--help" || userArgs[0] === "-h");
if (productHelp || (userArgs[0] !== undefined && controlSubjects.has(userArgs[0]))) {
  try {
    const { register } = await import("tsx/esm/api");
    const unregister = register();
    const control = await import("../src/control/cli.ts");
    process.exitCode = await control.runControlCli({ argv: userArgs, packageRoot, piEntry });
    unregister();
  } catch (cause) {
    console.error(`[picode] control command failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = 70;
  }
} else {

  const piRpcMode = userArgs.some((arg, index) => arg === "--mode" && userArgs[index + 1] === "rpc");
  if (!piRpcMode && (process.stdin.isTTY !== true || process.stdout.isTTY !== true)) {
    console.error(
      "[picode] The interactive TUI needs a terminal. Over SSH, run `ssh -t <host> picode`. " +
      "For non-interactive automation, use `picode run` or `picode rpc`.",
    );
    process.exitCode = 2;
  } else {
    const launchId = randomUUID();
    let launchCwd = process.cwd();
    let launchUserArgs = userArgs;
    while (true) {
      const launch = buildPiLaunch({
        packageRoot,
        picodeDir,
        piEntry,
        cursorSdkExtension: resolveCursorSdkExtension({ resolve: (specifier) => import.meta.resolve(specifier) }),
        userArgs: launchUserArgs,
        parentEnv: { ...process.env, PICODE_LAUNCH_ID: launchId },
      });
      const outcome = await new Promise((resolve) => {
        const child = spawn(process.execPath, launch.args, {
          stdio: "inherit",
          env: launch.env,
          cwd: launchCwd,
        });
        child.once("error", (cause) => resolve({ cause }));
        child.once("exit", (code) => resolve({ code: code ?? 0 }));
      });
      if (outcome.cause !== undefined) {
        console.error(`[picode] failed to start Pi TUI: ${outcome.cause.message}`);
        process.exitCode = 1;
        break;
      }
      let target;
      try {
        target = await consumeWorkspaceSwitchRequest({
          picodeDir,
          launchId,
          fromCwd: launchCwd,
        });
      } catch (cause) {
        console.error(`[picode] rejected workspace switch request: ${cause instanceof Error ? cause.message : String(cause)}`);
        process.exitCode = 70;
        break;
      }
      if (target === undefined) {
        process.exitCode = outcome.code;
        break;
      }
      console.error(`[picode] switched workspace to ${target}; starting a fresh Pi session.`);
      launchCwd = target;
      launchUserArgs = [];
    }
  }
}
