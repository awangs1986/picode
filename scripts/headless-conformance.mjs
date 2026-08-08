#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const launcher = join(root, "bin", "picode.mjs");
const scratch = mkdtempSync(join(tmpdir(), "picode-headless-"));
const env = { ...process.env, PICODE_DIR: join(scratch, "data") };
function run(args, input) { return spawnSync(process.execPath, [launcher, ...args], { cwd: scratch, env, input, encoding: "utf8", windowsHide: true }); }
function parallel(args) { return new Promise((resolveRun, reject) => { const child = spawn(process.execPath, [launcher, ...args], { cwd: scratch, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; }); child.on("error", reject); child.on("exit", (code) => code === 0 ? resolveRun() : reject(new Error(`${args.join(" ")} exited ${code}: ${stderr}`))); }); }

try {
  const help = run(["--help"]); if (help.status !== 0 || !help.stdout.includes("picode rpc") || help.stdout.includes("picode-ctl")) throw new Error("product help contract failed");
  const bad = run(["run"]); if (bad.status !== 64) throw new Error(`bad arguments must exit 64, got ${bad.status}`);
  const rpc = run(["rpc"], `${JSON.stringify({ version: 2, id: "v", method: "run.start", params: {} })}\n`);
  const message = JSON.parse(rpc.stdout.trim()); if (rpc.status !== 0 || message.error?.code !== "control/version-unsupported") throw new Error(`RPC version gate failed: ${rpc.stdout} ${rpc.stderr}`);
  await Promise.all([1, 2, 3, 4].map(() => parallel(["doctor", "tools"])));
  console.log("headless conformance OK (help + stable exits + NDJSON versioning + concurrent diagnostics)");
} finally { rmSync(scratch, { recursive: true, force: true }); }
