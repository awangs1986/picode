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
  const bundledSkills = JSON.parse(readFileSync(
    join(installed, "node_modules", "picode", "vendor", "mattpocock", "manifest.json"),
    "utf8",
  ));
  if (bundledSkills.name !== "mattpocock/skills" || bundledSkills.commit?.length !== 40) {
    throw new Error("installed artifact lost the pinned mattpocock skill bundle");
  }
  const launcher = join(installed, "node_modules", "picode", "bin", "picode.mjs");
  const help = run(process.execPath, [launcher, "--help"], { cwd: installed, env: { ...process.env, PICODE_DIR: join(scratch, "help-data") } });
  if (!help.includes("picode rpc") || !help.includes("picode tools doctor")) throw new Error("installed artifact lost Picode product help");
  const version = run(process.execPath, [launcher, "--version"], {
    cwd: installed,
    env: {
      ...process.env,
      PICODE_DIR: join(scratch, "data"),
      PATH: `${join(installed, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
    },
  });
  if (version !== manifest.version) {
    throw new Error(`installed Picode version mismatch: manifest=${manifest.version}, CLI=${version}`);
  }
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
  const rpcVersion = run(process.execPath, [launcher, "rpc"], {
    cwd: installed,
    input: `${JSON.stringify({ version: 9, id: "compat", method: "run.start", params: {} })}\n`,
    env: { ...process.env, PICODE_DIR: join(scratch, "product-rpc-data") },
  });
  if (JSON.parse(rpcVersion).error?.code !== "control/version-unsupported") throw new Error("installed product RPC version contract failed");
  await runRpcBootSmoke({
    launcher,
    cwd: installed,
    env: { ...process.env, PICODE_DIR: join(scratch, "rpc-data") },
  });
  console.log(`real package smoke OK (${filename}; Picode ${version}; CLI doctor + RPC session navigated)`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
