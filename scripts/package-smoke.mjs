#!/usr/bin/env node
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runRpcBootSmoke } from "./rpc-boot-smoke.mjs";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const scratch = mkdtempSync(join(tmpdir(), "picode-package-smoke-"));
const packed = join(scratch, "packed");
const installed = join(scratch, "installed");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
mkdirSync(packed);
mkdirSync(installed);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32" && command.endsWith(".cmd"),
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed${result.error === undefined ? "" : `: ${result.error.message}`}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result.stdout.trim();
}

function runNpm(args) {
  const npmExecPath = process.env.npm_execpath;
  return npmExecPath === undefined
    ? run(npmCommand, args)
    : run(process.execPath, [npmExecPath, ...args]);
}

try {
  const packJson = JSON.parse(runNpm(["pack", "--json", "--pack-destination", packed]));
  const filename = packJson[0]?.filename;
  if (typeof filename !== "string") throw new Error("npm pack did not return an artifact filename");
  const tarball = join(packed, filename);
  runNpm(["install", "--prefix", installed, "--ignore-scripts", "--no-audit", "--no-fund", tarball]);

  const manifest = JSON.parse(readFileSync(join(installed, "node_modules", "picode", "package.json"), "utf8"));
  if (manifest.pi?.extensions?.[0] !== "./src/extension/pi-entry.ts") {
    throw new Error("installed artifact lost the real Pi extension entry");
  }
  const launcher = join(installed, "node_modules", "picode", "bin", "picode.mjs");
  const version = run(process.execPath, [launcher, "--version"], {
    cwd: installed,
    env: {
      ...process.env,
      PICODE_DIR: join(scratch, "data"),
      PATH: `${join(installed, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
    },
  });
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`vendored Pi did not boot: ${version}`);
  const doctor = JSON.parse(run(process.execPath, [launcher, "doctor", "--json"], {
    cwd: installed,
    env: {
      ...process.env,
      PICODE_DIR: join(scratch, "control-data"),
      PATH: `${join(installed, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
    },
  }));
  if (doctor.version !== 1 || doctor.kind !== "doctor.result" || doctor.payload?.healthy !== true) {
    throw new Error(`installed Control Interface doctor failed: ${JSON.stringify(doctor)}`);
  }
  await runRpcBootSmoke({
    launcher,
    cwd: installed,
    env: { ...process.env, PICODE_DIR: join(scratch, "rpc-data") },
  });
  console.log(`real package smoke OK (${filename}; vendored Pi ${version}; CLI doctor + RPC session navigated)`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
