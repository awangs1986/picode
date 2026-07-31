import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const filters = [
  "extension_manager::tests",
  "hook_manager::tests::disabled_and_untrusted_hooks_are_zero_process",
  "extension_service::tests::crashing_mcp_is_terminal",
  "extension_service::tests::mcp_protocol_requests_run_through_work_manager",
  "code_intelligence::tests::lsp_protocol_requests_run_through_work_manager",
  "extension_service::tests::disabled_http_mcp_is_model_invisible",
  "extension_service::tests::hanging_dap_times_out",
  "extension_service::tests::migrations_imports_and_conflicts",
];

const checks = filters.map((filter) => {
  const result = spawnSync(
    "cargo",
    ["test", "--manifest-path", "src-tauri/Cargo.toml", filter, "--", "--nocapture"],
    { cwd: repo, encoding: "utf8", shell: false, windowsHide: true, timeout: 120_000 },
  );
  return {
    filter,
    passed: result.status === 0,
    output: `${result.stdout || ""}${result.stderr || ""}`.slice(-2000),
  };
});

const report = {
  schemaVersion: 1,
  scope: "P4 extension red-light gate",
  assertions: [
    "malicious Manifest v2 is rejected",
    "source pin and SHA drift requires explicit review",
    "untrusted Hook creates no process",
    "crashed MCP reaches a terminal state and releases its process",
    "stdio MCP and LSP protocol requests run through WorkManager-owned adapters",
    "hung DAP times out and releases its process",
    "permission expansion is rejected without explicit review",
    "Disabled components are model-invisible, activate no transport, and create zero processes, ports, or network access",
  ],
  checks,
  passed: checks.every((check) => check.passed),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.passed ? 0 : 1;
