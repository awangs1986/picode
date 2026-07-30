# Picode implementation roadmap

Status: product direction accepted; implementation not yet authorized by this document

Source specification: [`docs/specs/task-execution.md`](docs/specs/task-execution.md)

Issue-ready execution backlog: [`docs/P0-P5-BACKLOG.md`](docs/P0-P5-BACKLOG.md)

## Delivery rule

P0 through P5 are dependency levels, not release dates. A level is complete only when its exit gates pass on the supported platforms relevant to that level. UI presence, mock data, or a hidden feature flag does not count as completion.

Every implementation slice must preserve upstream Pi behavior, custom OpenAI-compatible and Anthropic-compatible providers, existing Picode/Picot data, and the ability to review future Upstream Picot changes.

Every missing capability must follow the Capability Source Ladder before implementation: search compatible Pi extensions first, then inspect the smallest equivalent Oh My Pi mechanism, then inspect comparable open-source agents, and use a Picode-specific design only when those sources are unsuitable. The issue or implementation document must retain a Capability Source Review with provenance, license, security, maintenance, compatibility, and resource-cost findings.

## Current baseline

The repository already contains useful foundations that must be tested and migrated rather than rewritten blindly:

- Tauri desktop shell and embedded Pi RPC lifecycle;
- multiple Pi processes and background chat sessions;
- a basic instance registry exposing port, process ID, session file, workspace, and start time, plus session-level token/cost views;
- manual Codex, Claude, and Cursor account import and an encrypted Account Vault;
- explicit per-chat `continue` enforcement in `account_binding.rs`;
- custom provider configuration and model selection;
- versioned English and Simplified Chinese XML language packs;
- selective external-chat import, Workspace Binding, chat backup, and context compression modules;
- an existing Super Agent task UI and JSON state that can be treated as legacy migration input.

The following core capabilities do not yet have a normative implementation:

- explicit Simple and Harness Task creation, Scratch Space, and Task Kind transitions;
- project-owned Harness Profiles and overlays;
- Task Run and Execution Epoch schemas;
- baseline-aware Evidence Ledgers and Evidence Artifacts;
- Git Write Leases and Safe Worktree coordination;
- Secret References for recurring non-provider access;
- Capability Catalog, `search_tools`, and task `TOOLS.md` bindings;
- lazy LSP lifecycle and diagnostics tied to edits.
- Agent Run lineage, resource sampling, explicit wait states, and stall assessment beyond the current live-process check.

## P0 — Task kinds and non-breakable execution foundation

Goal: make identity, persistence, permissions, writes, and recovery reliable before adding more agent intelligence.

### Deliverables

- New-task UI with two explicit choices: **Simple Task** and **Harness Task**.
- Simple Task starts immediately without a workspace picker, uses app-owned Scratch Space, and exposes only upstream Pi's core conversation and tool capabilities by default.
- Simple Task startup performs no Harness discovery, Git inspection, LSP/MCP startup, or extension process loading.
- A new Simple Task receives no Global Extension shortlist or Task Extension binding unless the user explicitly opts in later.
- Harness Task requires Workspace Binding and instantiates a versioned Task Harness from Picode's built-in template.
- A Simple Task can attach a workspace while remaining Simple, or convert to a Harness Task, without losing chat, task, account epoch, or evidence state.
- Versioned schemas and transactional migrations for Chat Session metadata, Task Kind, Scratch Space, Task Harness, Task Override, Task Runs, Execution Epochs, workspace identities, optional write ownership, and evidence references.
- Migration adapter from current Super Agent task JSON; original data remains intact until conversion succeeds.
- Durable `Chat Session → Task Run → Execution Epoch` relationships with one active writer per chat.
- Account interruption that stops only related jobs, hands preserved Chat Session associations to the replacement account, and requires explicit `continue` to resume the same Task Run through a new epoch.
- Portable Workspace Identity and mandatory re-binding for workspace-bound tasks after cross-platform import or restore.
- Read-version and content-hash write preconditions for ordinary files.
- Content-version and stale-write protection for direct edits; Git baseline, diff/hunk attribution, Write Leases, and Safe Worktrees only when an effective Task Harness or explicit user instruction selects them.
- Unified allow/ask/deny authorization boundary for read, write, execute, secret use, expensive checks, and dangerous actions.
- Task-scoped Task Override state that distinguishes explicit user or Skill changes from the reusable Harness template and project Profile.
- Temporary secret lifecycle plus Secret Reference storage and just-in-time resolution.
- Recovery after process crash or application restart without pretending terminated jobs are still alive.
- Versioned Agent Run lifecycle and parent-link records for current main/background Pi sessions, ready to include Subagents later.
- Runtime Monitor v1 listing active and recent Agent Runs with chat/task, provider/account/model, foreground/background state, current or last action, start time, duration, last progress, and termination result.
- Cross-platform local process sampling for PID, CPU, memory, and uptime with explicit shared/unavailable attribution instead of fabricated per-Agent values.
- Usage normalization for provider-reported requests, input/output/cached/reasoning tokens, and cost; missing provider data remains visibly unavailable.
- Health states that distinguish running, model wait, tool wait, user/permission wait, suspected stall, unresponsive, completed, failed, and cancelled.
- Manual inspect, open-chat, cancel, and retry entry points; no automatic termination based only on a stall heuristic.
- English and Simplified Chinese strings for every new state, decision, warning, and error.

### Existing-feature hardening

- Verify account import, reverse-proxy import, custom providers, XML language packs, chat import, backup, and restore against the new durable identities.
- Separate account-association handoff from execution so a replacement account receives preserved chats without automatically resuming their tasks.
- Preserve all current Picot compatibility identifiers required by ADR-0017.

### Performance gate

Measure Windows cold start, warm start, idle memory, one active chat, long-chat rendering, and model streaming latency before optimization. Change only measured bottlenecks; if no material regression or practical improvement is available, close the Windows optimization item with evidence rather than adding speculative complexity.

### Exit gates

- Crash/restart and A-to-B account continuation tests retain goal, plan, pending work, workspace, and evidence.
- A Simple Task starts and chats without selecting a workspace and without launching heavyweight optional capabilities.
- A Harness Task cannot start workspace execution until Workspace Binding succeeds, and its effective Task Harness is visible.
- Attaching a workspace or converting Task Kind preserves the complete task ledger.
- Activating B may hand over A's Chat Session associations, but produces no model request or tool execution until the user explicitly continues a specific chat.
- Windows-to-Linux and Linux-to-Windows restore tests cannot execute an unbound source path.
- When Git-managed protection is enabled, concurrent writes to one physical worktree are rejected and dirty user changes survive Agent edits unchanged.
- No secret value appears in chat, logs, exports, fixtures, or project files.
- An explicitly invoked Skill or user command can replace Task Harness actions, Git strategy, and Completion Gates for that task; the underlying tool/API layer still enforces granted capabilities, permissions, and destructive-operation confirmations.
- Runtime Monitor totals match the owned live Pi processes, and shared or unavailable resource attribution is labeled.
- A slow model response, long declared tool action, or permission wait is never classified as stalled solely because CPU usage is low.
- A killed or unreachable Pi process becomes unresponsive or terminated within the defined probe window without remaining falsely active.
- Token and cost totals preserve provider uncertainty and never display an estimate as an exact reported value.
- Existing account, localization, backup, and custom-provider regression suites pass.

## P1 — Optional Harness Task verification loop

Goal: make the Harness Task template and an existing project's optional Harness Profile a reviewable, executable, evidence-producing contract without changing Simple Task behavior.

### Deliverables

- Strict versioned JSONC schema for `.picode/harness.jsonc`.
- Versioned built-in Harness Task template and effective Task Harness composition with visible Task Overrides.
- Deterministic discovery from project rules, package/build scripts, CI definitions, and other declared sources.
- Draft review UI with source provenance, conflict comparison, canonical selection, and disabled alternatives.
- Root profile plus module/package/subproject Profile Overlays activated by real task scope.
- Source fingerprints and focused drift review.
- Typed parameters, named local slots, risk tiers, timeouts, dependencies, and explicit Windows/Linux/macOS variants.
- Structured executable-plus-argument actions and explicitly declared shell actions.
- Trust confirmation separate from per-invocation authorization.
- Change-type mappings to Completion Gates.
- Low-cost pre-write baselines and guarded reuse of matching historical baselines.
- Structured success predicates, machine-readable report adapters, Known Failure comparison, declared bounded retry, and flaky-result labeling.
- Evidence Ledger, bounded previews, content-addressed Evidence Artifacts, retention policy, cleanup audit, and redaction pipeline.
- Completion labels that distinguish Simple completed, Harness verified, Harness verified with overrides, incomplete Harness verification, suspended, environment blocked, and failed.

### Exit gates

- An unconfirmed or drifted action cannot execute as a trusted Harness Action.
- Harness discovery may recommend a profile but cannot force a Simple Task to convert.
- A missing platform variant cannot be guessed or translated.
- A successful exit code cannot override a failed structured success predicate.
- A pass after retry remains visibly flaky.
- A Task Run cannot become Harness verified until every gate in its effective Task Harness passes.
- A task with replaced or skipped template gates cannot claim unmodified template verification; its completion label and ledger expose the overrides.
- Unchanged Known Failures and new regressions are reported separately from a comparable baseline.
- Full artifacts can be cleaned by policy while hashes, summaries, and cleanup records remain verifiable.

## P2 — Low-cost code intelligence and tool discovery

Goal: raise edit success and context quality without making Picode a resident heavyweight IDE or loading every extension into the prompt.

### Deliverables

- Lazy LSP launch by language and module only when requested by the task or effective Task Harness, with idle shutdown and post-write diagnostics.
- Standard patch interface backed by stale-content rejection and reread requirements.
- Optional model-specific content anchors, including a Hashline-style adapter, without making one custom edit syntax universal.
- Local bounded index for text, symbols, modules, targets, and test mappings; no default remote vector database.
- Minimal resident core tool set.
- Versioned extension manifests and local Capability Catalog.
- Capability Source Review template and enforcement before a new non-core capability implementation begins.
- Resident `search_tools` plus on-demand schema loading and process start.
- Task-owned `TOOLS.md` parsing and compact capability digest on task start, restore, and account continuation.
- Skill provenance, invocation source, declared scope, active overrides, and conflicts visible in the task capability digest.
- Deterministic local relevance hints for Global Extensions.
- Bounded file, log, and tool-result previews with full data outside model context.

### Exit gates

- Installing or enabling one hundred inert extensions does not start their processes or inject their full schemas.
- A newly created Simple Task does not discover or receive extension suggestions until the user explicitly opts in.
- A Task Extension is rediscovered after restart and account continuation without becoming global.
- An installed or automatically suggested Skill cannot override defaults until the user explicitly invokes it.
- Simple Tasks do not start LSP automatically; selected LSP processes stop after the configured idle interval and do not scan unrelated languages by default.
- A stale write is rejected even when Git itself reports no committed change.
- Capability discovery works without an additional model call.

## P3 — Durable long work and isolated concurrency

Goal: support long-running, multi-chat work and optional isolated concurrency while preserving deterministic ownership and recovery.

### Deliverables

- Durable task graph with stages, dependencies, owner, blockers, acceptance evidence, and continuation checkpoints.
- Background process manager with bounded tail, full artifact, timeout, cancellation, exit confirmation, and restart-aware state.
- Harness policy for authorized Safe Worktree creation when Git-managed isolation is selected.
- One Write Lease per physical working directory and one branch/Worktree per concurrent writer while that policy is active.
- Git change review and explicit integration workflow; no automatic merge or cleanup.
- Optional subagent extension for independently verifiable work.
- User-configurable Subagent Model Policy with eligible model candidates and explicit `do not delegate`, `inherit main model`, or `ask` fallback.
- Deterministic hard filters for Delegation Eligibility before any model-based routing judgment.
- Initial automatic economy-routing classes limited to bounded read-only search, repository mapping, documentation lookup, log classification, and supplied-context summarization.
- Per-task routing record containing eligibility evidence, selected provider/model, expected cost/latency, fallback, tool/context envelope, and completion quality.
- Evaluation suite that establishes a capable-model baseline and enables a cheaper model for a task class only after it meets the configured quality threshold.
- Default Harness template for strict subagent delegation covering goal, scope, method, tools, permissions, and expected evidence.
- Default main-Agent review and final effective-Harness verification after subagent work, with any user/Skill override recorded task-locally.
- Deterministic checkpoint/handoff before compaction, account change, or model change; model-generated summaries only when local state cannot fit the required context.

### Exit gates

- When Write Leases are active, two chats cannot write the same physical worktree concurrently.
- Merely configuring a cheaper model never spawns a Subagent or reroutes an ineligible task.
- Automatic cheaper-model routing rejects writes, architecture, ambiguous multi-step investigation, secret use, deployment, destructive actions, and results lacking independent verification.
- If an eligible model is unavailable or incompatible, the recorded user fallback is followed without silently choosing an arbitrary model.
- The Runtime Monitor shows main-Agent/Subagent parentage, selected model, routing reason, per-run usage when available, and last meaningful progress.
- Under the default Harness template, a completed subagent result cannot bypass main-Agent review or effective Completion Gates.
- Under the default delegation template, a blocked subagent reports instead of changing strategy or authority.
- Restarted Picode marks dead background processes as terminated and never fabricates a live connection.
- Worktrees, branches, and user changes remain recoverable until the user explicitly integrates or removes them.

## P4 — Extensible professional workflows

Goal: make advanced capabilities installable and replaceable without dragging their cost into the resident core.

### Deliverables

- Out-of-process lifecycle, crash isolation, cancellation, resource limits, and cleanup for heavy extensions.
- Project and task adapters that translate existing harness semantics without introducing engine-specific assumptions into core.
- Compatible import of selected external agent rules, skills, commands, and MCP configuration with visible source, conflicts, and enablement state.
- Optional DAP, structured code review, multi-model advisory roles, and project-specific diagnostic adapters.
- Picode agent regression harness measuring task success, edit retries, verification accuracy, token use, startup time, interaction latency, and peak memory.
- Versioned extension permissions and migration behavior.

### Exit gates

- A crashing heavy extension cannot terminate or corrupt the main Chat Session.
- Disabled extensions consume no resident process budget.
- Imported external rules never silently override Picode defaults or project Profiles; explicit user invocation creates a visible Task Override.
- Performance and task-success claims are backed by repeatable benchmark artifacts.

## P5 — Remote and experimental capabilities

Goal: add optional reach and experimentation only after the local harness workflow is reliable.

Candidate extensions include:

- phone Remote Control Extension using the existing Chat Control Interface;
- browser or desktop computer use;
- collaboration and shared review;
- voice and image workflows;
- advisor models, automated research, and long-term memory services;
- larger remote worker pools.

These capabilities are disabled by default, remain outside the resident core, and require their own threat model, permission contract, performance budget, and acceptance tests before promotion.

## Cross-phase release checklist

Every release slice must include:

- schema version and migration or an explicit statement that none changed;
- focused automated tests plus any gates selected by the release workflow;
- Task Kind coverage showing that Simple behavior stays lightweight and Harness-only behavior does not leak into it;
- English and Simplified Chinese UI text;
- secret and log-redaction review;
- Windows, Linux, and macOS path/identity review proportional to the change;
- measured startup, idle-memory, and interaction impact for resident-code changes;
- Runtime Monitor overhead, state-transition, attribution, and false-stall tests for lifecycle changes;
- routing-evaluation evidence whenever a model is enabled for an automatic Subagent task class;
- updated `CONTEXT.md`, ADRs, specification, and roadmap when domain meaning changes;
- a Capability Source Review for every newly introduced capability, including pinned sources, license compatibility, retained notices, and rejection reasons;
- a report distinguishing Simple completed, Harness verified, Harness verified with overrides, implementation complete with incomplete Harness verification, environment-blocked, and pre-existing failures.
