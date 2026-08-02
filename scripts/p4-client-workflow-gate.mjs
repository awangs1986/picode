import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const filters = [
  "conversation_control::tests",
  "client_gateway::tests",
  "core_locator::tests",
  "herdr_installer::tests",
  "session_kernel::tests::caller_recovers_a_truncated_tail_but_rejects_corruption_in_committed_history",
  "runtime_spine::tests::retained_events_and_deduplication_ids_are_bounded_and_log_can_checkpoint",
];

const checks = filters.map((filter) => {
  const result = spawnSync(
    "cargo",
    ["test", "--manifest-path", "src-tauri/Cargo.toml", filter, "--", "--nocapture"],
    {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PI_STUDIO_SKIP_BIN_CHECK: "1" },
      shell: false,
      windowsHide: true,
      timeout: 180_000,
    },
  );
  return {
    filter,
    passed: result.status === 0,
    output: `${result.stdout || ""}${result.stderr || ""}`.slice(-2000),
  };
});

const report = {
  schemaVersion: 1,
  scope: "P4 GUI/TUI workflow and recovery red-light gate",
  assertions: [
    "GUI, TUI, and remote clients share one bounded and secret-screened workflow snapshot",
    "concurrent mutation elects one writer and stale fencing generations cannot write",
    "an ambiguous disconnect requires a failed probe before safe takeover",
    "an active Agent cannot be stolen until it reaches a safe runtime transition",
    "a lost acknowledgement cannot replay a mutation after cross-surface takeover",
    "Core restart drops volatile leases without deleting durable Chat or Task state",
    "truncated final JSONL is recoverable while committed corruption is rejected",
    "Herdr decline, offline install, tampered hash, failed health, and unsupported platforms fail closed",
    "Herdr removal returns the optional host to zero running processes and zero trusted installation",
    "long-lived runtime retention and request deduplication remain bounded",
  ],
  checks,
  passed: checks.every((check) => check.passed),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.passed ? 0 : 1;
