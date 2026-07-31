# Adaptive Task Experience P0–P3 Capability Source Reviews

Date: 2026-08-01  
Scope: the P0–P3 pipeline improvements accepted after the Grok Build comparison.

Each capability below follows the required Pi → Oh My Pi → comparable open-source agent → clean-room decision ladder. The shared Harness V2 reviews remain authoritative for Runtime Lifecycle, SessionKernel, Hooks, Rewind, DelegationEngine, and ExtensionManager details.

## CSR-ATE-01 Adaptive Guidance and progressive planning

- **Pi ecosystem:** Pi already lets a capable model plan and use tools without a mandatory planning layer. No reviewed Pi package supplies Picode's task-risk-aware escalation policy without replacing the Pi loop.
- **Oh My Pi:** OMP demonstrates a capable model operating with a compact tool surface. Its runtime is not embedded because Picode retains Pi as its only conversation core.
- **Comparable agent:** Grok Build `dd04f397b1d02f2272b092555669dfba1f01bc85` uses model-requested Plan Mode for genuine ambiguity and keeps direct execution for straightforward tasks. Its behavior is adopted; no source is copied.
- **Decision:** add a small, deterministic Picode Guidance Policy around Pi. `Lean` is the default, `Adaptive` escalates only from recorded signals, and `Guided` is explicit. Assurance requirements never weaken with Guidance.

## CSR-ATE-02 Unified task experience and event stream

- **Pi ecosystem:** Pi remains the live transcript and tool runtime. It does not normalize imported chats, account handoff, Gate evidence, GUI/headless control, or Picode recovery into one interface.
- **Oh My Pi:** its session/runtime behavior confirms that resumable work needs durable semantic events, but adopting its runtime would duplicate Pi.
- **Comparable agent:** Grok Build sessions retain prompts, tool calls, TODO state, compaction checkpoints, subagents, and rewind metadata behind one Session interface. ACP validates reusing one task interface across interactive and headless clients.
- **Decision:** deepen Picode's accepted Runtime Lifecycle and ExecutionStore into an append-only bounded Task Event Stream and expose it through one Task Experience interface used by desktop and headless adapters. Conversation bodies remain in Pi JSONL; the event stream stores bounded semantic facts only.

## CSR-ATE-03 Controlled rewind

- **Pi ecosystem:** Pi can fork or switch sessions, but it does not own Picode's task-state and workspace recovery contract.
- **Oh My Pi:** Git-first checkpoints support engineering recovery and reinforce avoiding ad-hoc path copies.
- **Comparable agent:** Grok Build session rewind couples conversation truncation with file snapshots and explicitly warns when Git protection is unavailable.
- **Decision:** implement preview-first rewind over Picode Task Events and registered checkpoints. Task-state rewind is always available; workspace rewind is allowed only through an explicit adapter with a verified Git/checkpoint identity. Rewind appends a compensating event rather than deleting audit history.

## CSR-ATE-04 Lifecycle Hook interface

- **Pi ecosystem:** Pi extension events are retained as observations; hooks do not gain tool authority.
- **Oh My Pi:** hook-like lifecycle automation confirms the usefulness of pre/post work seams.
- **Comparable agent:** Grok Build provides BeforeTool, AfterTool, Stop, and SubagentStop behavior, but malformed/failed hooks may fail open and Stop has a bounded continuation limit.
- **Decision:** deepen the existing Picode HookManager behind typed hook points and decisions. Hooks remain disabled/trusted separately, run through WorkManager, and cannot create Gate evidence or upgrade completion.

## CSR-ATE-05 Subagent contracts

- **Pi ecosystem:** the pinned `pi-subagents` package remains the executable orchestration implementation.
- **Oh My Pi:** its task tool validates structured inputs, outputs, isolation, and saved results.
- **Comparable agent:** Grok Build personas support input/output contracts, selected models, reasoning effort, and optional worktrees.
- **Decision:** extend only the Picode Delegation Plan with a bounded contract: objective, allowed scope, required output, acceptance checks, stop conditions, and parent review. Do not reimplement `pi-subagents`.

## CSR-ATE-06 Effective capability diagnostics

- **Pi ecosystem:** Pi exposes loaded extensions and Skills, but not Picode's combined provenance for project rules, explicit Skill overrides, task extensions, and capability tiers.
- **Oh My Pi:** tool catalogs show discoverability but do not cover Picode's three-tier policy.
- **Comparable agent:** Grok Build loads scoped project rules and Skills; its diagnostics need makes provenance visible, but Picode rejects injecting every matching rule by default.
- **Decision:** provide a read-only Effective Capability Report with source, scope, activation reason, prompt presence, residency, and conflicts. The report changes no task state and loads no implementation.

## Shared license, security, and resource decision

- All new code is clean-room Picode code under the repository's MIT license.
- No Grok Build, OMP, or proprietary code is copied.
- Resident additions are bounded schemas, small state machines, and indexes only.
- Hooks, child agents, project scanners, Git commands, LSP, MCP, and extensions remain lazy or explicitly activated.
- Assurance, authorization, workspace safety, Secret References, and deterministic Gates remain authoritative regardless of Guidance mode.

