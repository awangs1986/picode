#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
const failures = [];

if (pkg.name !== "picode") failures.push("package name must be picode");
if (pkg.bin?.picode !== "./bin/picode.mjs") failures.push("picode bin entry is missing");
if (pkg.bin?.["picode-ctl"] !== undefined) failures.push("internal debug HTTP client must not be a public bin");
if (!pkg.pi?.extensions?.includes("./src/extension/pi-entry.ts")) {
  failures.push("Pi package metadata must load the real adapter entry");
}
for (const path of [
  "bin/picode.mjs",
  "bin/picode-launch.mjs",
  "src/extension/pi-entry.ts",
  "vendor/mattpocock/manifest.json",
]) {
  if (!existsSync(resolve(root, path))) failures.push(`required artifact file is missing: ${path}`);
}
if (!pkg.files?.includes("vendor/")) failures.push("package files must include the pinned skill bundle");
for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(version))) {
    failures.push(`runtime dependency ${name} is not exactly pinned: ${version}`);
  }
  const locked = lock.packages?.[`node_modules/${name}`];
  if (locked?.version !== version) failures.push(`lock mismatch for ${name}: ${locked?.version ?? "missing"}`);
  if (typeof locked?.integrity !== "string" || locked.integrity.length < 16) {
    failures.push(`lock integrity is missing for ${name}`);
  }
}

if (failures.length > 0) {
  console.error("package metadata contract failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("package metadata contract OK (exact versions + lock integrity + real Pi entry)");
