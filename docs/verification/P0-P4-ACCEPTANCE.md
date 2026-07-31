# Picode P0–P4 acceptance record

Date: 2026-07-31
Branch: `feature/p0-p4-complete`
Scope: P0–P4 only; P5 remains a future planning track.

## Gate

The reproducible gate is `node scripts/p0-p4-gate.mjs`. It runs the frontend
Vitest suite, Rust tests, strict Clippy, Rust formatting, CSS/design checks,
Tauri permission checks, extension bundling, and Biome. The machine-readable
result is `docs/verification/p0-p4-gate.json`.

The gate deliberately uses direct executable-plus-argument invocations. It does
not invoke a shell, does not start a model provider, and does not write project
files. A failed check leaves the previous JSON artifact intact only until the
script completes its next run; the new artifact always includes each command's
exit code, duration, signal, and bounded output tail.

## Implemented outcomes

- P0: durable Simple/Harness task kinds, portable workspace binding, account
  handoff with explicit localized `continue`, task and Agent Run lifecycle,
  resource/stall monitor, recovery state, XML English/Chinese UI, and the
  compatibility boundary around the existing Pi runtime.
- P1: versioned Harness discovery and review, trust/drift fingerprints,
  explicit action authorization, typed execution, bounded verification,
  structured test result classification, explicit Gate Validity red probes,
  Evidence Ledger/artifacts, redaction/encryption/retention, and truthful
  completion labels.
- P2: three-tier lazy capability catalog with persisted Disabled modules,
  explicit user/task capability scopes,
  safe stale-write checks, deterministic local search, one-shot LSP mappings,
  and the `TOOLS.md` task contract.
- P3: durable background jobs with restart/cancel/timeout, checkpointed task
  graph, Git snapshots and safe worktrees, qualified read-only subagent routing,
  user-selected model policy, and live resource attribution.
- P4: non-resident extensions, manual selective JSON/rules/skills/commands
  import, permission migrations, isolated MCP stdio/Streamable HTTP, real
  DAP adapter process lifecycle with bounded events, project-adapter registries,
  deduplicated diagnostics, advisory subagents, task-scoped cancellation, crash/hang cleanup, and content-addressed
  regression records with deterministic comparison.

## Safety and scope notes

- Installed extensions are catalog metadata until a user explicitly enables a
  task-scoped run. A closed monitor panel does not disable resource enforcement.
- Imported Cursor/Codex/Claude/OpenCode material is copied selectively into a
  versioned Picode store. Unsupported entries are reported; symlinks and path
  escapes are rejected. MCP JSON stores references and names, never secret
  values; secret resolution is JIT and process-scoped.
- Advisory output is an unverified candidate, not Evidence Ledger proof. Only
  the main agent can accept or reject it through the normal verification path.
- Local tests do not contact providers. Token and cost attribution is therefore
  explicitly `unavailable` in the gate artifact unless provider telemetry is
  supplied by a real run.

## Commands and observed result

The final run is expected to have zero failed checks. Rust child-process fixtures
are intentionally marked `#[ignore]` in the parent process and are listed in the
JSON artifact; they are launched only by their dedicated fixture tests so a test
process cannot orphan them.

The machine-readable artifact records the exact Rust/frontend counts for the
run. The P0-P4 implementation now exposes `harness_validate_gate` for explicit
controlled red probes and `capability_set_tier` for persisted capability
residency. A project profile without a red probe remains visibly incomplete;
the passing repository Gate itself does not manufacture red-capability proof.
CI authority and project-specific engine/content adapters remain external or
P5 concerns, as documented in the development-harness audit.
