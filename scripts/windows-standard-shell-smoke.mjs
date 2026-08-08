#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "win32") {
  console.log("Windows Standard shell smoke skipped on non-Windows host");
  process.exit(0);
}

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const scratch = mkdtempSync(join(tmpdir(), "picode-windows-shell-smoke-"));
const child = spawn(
  process.execPath,
  [join(root, "bin", "picode.mjs"), "--mode", "rpc", "--offline", "--no-session"],
  {
    cwd: root,
    env: { ...process.env, PICODE_DIR: join(scratch, "data") },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  },
);

let stdout = "";
let stderr = "";
let settled = false;

function finish(error) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  child.stdin.end();
  child.kill();
  rmSync(scratch, { recursive: true, force: true });
  if (error === undefined) {
    console.log("Windows Standard Harness PowerShell sandbox smoke OK");
  } else {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function inspect() {
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value.type !== "response") continue;
    if (value.id === "mode" && value.success === true) {
      child.stdin.write(`${JSON.stringify({
        id: "shell",
        type: "bash",
        command: "Get-ChildItem -LiteralPath './prompts','./src/extension' | Select-Object -First 4 -ExpandProperty Name",
      })}\n`);
    }
    if (value.id !== "shell") continue;
    const execution = value.data;
    if (value.success !== true || execution?.exitCode !== 0) {
      finish(new Error(`Windows sandbox shell failed: ${JSON.stringify(execution ?? value)}`));
      return;
    }
    if (/LAUNCH_FAILED|os error 203|EISDIR/i.test(String(execution.output ?? ""))) {
      finish(new Error(`Windows sandbox shell returned a launch failure: ${execution.output}`));
      return;
    }
    if (!/harness-core\.md|approval-ui\.ts/i.test(String(execution.output ?? ""))) {
      finish(new Error(`Windows sandbox shell could not traverse workspace children: ${execution.output}`));
      return;
    }
    finish();
  }
}

child.stdout.on("data", (chunk) => {
  stdout += String(chunk);
  inspect();
});
child.stderr.on("data", (chunk) => { stderr += String(chunk); });
child.on("error", (error) => finish(error));
child.on("exit", (code) => {
  if (!settled) finish(new Error(`Pi RPC exited before shell smoke completed (${code})\n${stderr}`));
});
const timer = setTimeout(
  () => finish(new Error(`Windows shell smoke timed out\n${stderr}`)),
  25_000,
);

child.stdin.write(`${JSON.stringify({ id: "mode", type: "prompt", message: "/harness standard" })}\n`);
