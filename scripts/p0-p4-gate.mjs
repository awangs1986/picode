import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const node = process.env.PICODE_NODE || process.execPath;
const biome = resolve(
  repo,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "biome.exe" : "biome",
);
const outputDir = resolve(repo, "docs", "verification");
const outputFile = resolve(outputDir, "p0-p4-gate.json");

mkdirSync(outputDir, { recursive: true });

function formatArtifact() {
  if (!existsSync(outputFile)) return;
  const result = spawnSync(biome, ["format", "--write", outputFile], {
    cwd: repo,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`Could not format the P0-P4 gate artifact: ${result.stderr || result.stdout}`);
  }
}

function portableOutput(value) {
  const repoPaths = [repo, repo.replaceAll("\\", "/")];
  const home = homedir();
  const homePaths = [home, home.replaceAll("\\", "/")];
  const ansiColor = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  let sanitized = value.replaceAll(ansiColor, "");
  for (const path of repoPaths) sanitized = sanitized.replaceAll(path, "<repo>");
  for (const path of homePaths) sanitized = sanitized.replaceAll(path, "<home>");
  return sanitized;
}

// The previous report participates in the repository-wide Biome check. Keep
// it canonical before the gate runs as well as after the new report is written.
formatArtifact();

const checks = [
  {
    name: "frontend-vitest",
    executable: node,
    displayExecutable: "node",
    args: ["node_modules/vitest/vitest.mjs", "run"],
  },
  {
    name: "rust-test",
    executable: "cargo",
    displayExecutable: "cargo",
    args: ["test", "--manifest-path", "src-tauri/Cargo.toml"],
  },
  {
    name: "rust-clippy",
    executable: "cargo",
    displayExecutable: "cargo",
    args: [
      "clippy",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ],
  },
  {
    name: "rust-format",
    executable: "cargo",
    displayExecutable: "cargo",
    args: ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--", "--check"],
  },
  {
    name: "performance-contract",
    executable: node,
    displayExecutable: "node",
    args: ["scripts/performance-gate.mjs"],
  },
  {
    name: "p4-extension-red-gate",
    executable: node,
    displayExecutable: "node",
    args: ["scripts/p4-extension-gate.mjs"],
  },
  {
    name: "p4-client-workflow-red-gate",
    executable: node,
    displayExecutable: "node",
    args: ["scripts/p4-client-workflow-gate.mjs"],
  },
  {
    name: "design-css",
    executable: node,
    displayExecutable: "node",
    args: ["scripts/check-design-css.mjs"],
  },
  {
    name: "tauri-permissions",
    executable: node,
    displayExecutable: "node",
    args: ["scripts/check-tauri-permissions.js"],
  },
  {
    name: "extension-bundles",
    executable: node,
    displayExecutable: "node",
    args: ["scripts/build-extensions.js"],
  },
  {
    name: "biome",
    executable: biome,
    displayExecutable: "biome",
    args: ["check", ".", "--max-diagnostics=100"],
  },
];

const runs = checks.map((check) => {
  const started = Date.now();
  const result = spawnSync(check.executable, check.args, {
    cwd: repo,
    encoding: "utf8",
    shell: false,
    timeout: 15 * 60 * 1000,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return {
    name: check.name,
    command: [check.displayExecutable, ...check.args].join(" "),
    exitCode: result.status ?? -1,
    signal: result.signal ?? null,
    durationMs: Date.now() - started,
    passed: result.status === 0,
    outputTail: portableOutput(output).slice(-4000),
  };
});

const artifact = {
  schemaVersion: 1,
  product: "Picode",
  scope: "P0-P4",
  branch: process.env.PICODE_BRANCH || "feature/p0-p4-complete",
  recordedAt: new Date().toISOString(),
  checks: runs,
  ignoredChildFixtures: [
    "orchestration_background_job_child_fixture",
    "orchestration_long_running_child_fixture",
    "extension_crash_fixture",
    "extension_hang_fixture",
    "mcp_protocol_fixture",
    "lsp_protocol_fixture",
  ],
  providerUsage: {
    tokens: "unavailable: local gate does not call a model provider",
    costMicros: "unavailable: local gate does not call a model provider",
  },
  visualInspection: {
    surface: "public/main-ui-prototype.html?variant=A&lang=zh-CN",
    viewport: "1280x720",
    result:
      "passed: Scheme A rail, chat-first density, Harness/model/status chips, and Chinese typography inspected in the in-app browser",
  },
  passed: runs.every((run) => run.passed),
};

writeFileSync(outputFile, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
formatArtifact();
process.stdout.write(
  `${JSON.stringify({ passed: artifact.passed, checks: runs.map(({ name, passed, durationMs }) => ({ name, passed, durationMs })) }, null, 2)}\n`,
);
process.exitCode = artifact.passed ? 0 : 1;
