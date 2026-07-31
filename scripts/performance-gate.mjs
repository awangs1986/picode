import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

function run(name, executable, commandArgs) {
  const started = Date.now();
  const result = spawnSync(executable, commandArgs, {
    cwd: repo,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 5 * 60 * 1000,
  });
  return {
    name,
    passed: result.status === 0,
    durationMs: Date.now() - started,
    outputTail: `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-2000),
  };
}

function readMeasurement(path) {
  const value = JSON.parse(readFileSync(resolve(path), "utf8"));
  const required = [
    "startupReadyMs",
    "idleWorkingSetBytes",
    "firstTokenMs",
    "longSessionP95FrameMs",
    "optionalResidentProcesses",
  ];
  for (const key of required) {
    if (!Number.isFinite(value[key]) || value[key] < 0) {
      throw new Error(`Performance measurement ${path} has no valid ${key}`);
    }
  }
  return value;
}

function compare(baselinePath, currentPath) {
  const baseline = readMeasurement(baselinePath);
  const current = readMeasurement(currentPath);
  const ratios = baseline.allowedRegressionRatio ?? {};
  const metrics = [
    ["startupReadyMs", ratios.startupReadyMs ?? 1.15],
    ["idleWorkingSetBytes", ratios.idleWorkingSetBytes ?? 1.1],
    ["firstTokenMs", ratios.firstTokenMs ?? 1.2],
    ["longSessionP95FrameMs", ratios.longSessionP95FrameMs ?? 1.2],
  ].map(([name, ratio]) => ({
    name,
    baseline: baseline[name],
    current: current[name],
    limit: baseline[name] * ratio,
    passed: current[name] <= baseline[name] * ratio,
  }));
  metrics.push({
    name: "optionalResidentProcesses",
    baseline: baseline.optionalResidentProcesses,
    current: current.optionalResidentProcesses,
    limit: 0,
    passed: current.optionalResidentProcesses === 0,
  });
  return metrics;
}

const checks = [
  run("long-session-bounds", "cargo", [
    "test",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "runtime_spine::tests::retained_events_and_deduplication_ids_are_bounded_and_log_can_checkpoint",
  ]),
  run("zero-resident-extensions", "cargo", [
    "test",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "extension_service::tests::disabled_heavy_extensions_are_nonresident_and_real_runs_are_isolated",
  ]),
  run("streaming-first-event-contract", "cargo", [
    "test",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--bin",
    "picode-headless",
    "tests::cli_accepts_streaming_json_lines_without_waiting_for_a_batch",
  ]),
];

let metrics = [];
const baselinePath = args.get("--baseline");
const currentPath = args.get("--current");
if (baselinePath || currentPath) {
  if (!baselinePath || !currentPath) {
    throw new Error("--baseline and --current must be supplied together");
  }
  metrics = compare(baselinePath, currentPath);
}

const artifact = {
  schemaVersion: 1,
  checks,
  metrics,
  metricGate: metrics.length === 0 ? "not_requested" : "evaluated",
  passed: checks.every((check) => check.passed) && metrics.every((metric) => metric.passed),
};
process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
process.exitCode = artifact.passed ? 0 : 1;
