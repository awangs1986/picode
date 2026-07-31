# Picode P0–P5 execution backlog

Status: P0–P4 baseline gate and the final capability/Gate-validity additions pass on `feature/p0-p4-complete`; P5 remains planning-only.

Sources: [`ROADMAP.md`](../ROADMAP.md), [`task-execution.md`](specs/task-execution.md), [`CONTEXT.md`](../CONTEXT.md)

## How to use this backlog

P0–P5 are dependency levels, not calendar releases. Each numbered item is intended to become one GitHub Issue with one independently verifiable outcome. `Depends` identifies hard ordering; tasks without a mutual dependency may proceed in parallel. `Task Kind` states whether shipped behavior affects Simple Tasks, Harness Tasks, or both.

`CSR required` means the issue must complete a Capability Source Review before implementation: Pi ecosystem first, then the smallest relevant Oh My Pi mechanism, then comparable open-source agents, and only then greenfield work. Every issue must also follow [`docs/agents/issue-tracker.md`](agents/issue-tracker.md).

| Level | Issue-ready tasks | Completion meaning |
|---|---:|---|
| P0 | 20 | Durable task kinds, account/workspace safety, Runtime Monitor v1, and compatibility gate (implemented) |
| P1 | 15 | Optional Harness contract, verification, evidence, and truthful completion (implemented) |
| P2 | 13 | Lazy capabilities, safe editing, local intelligence, and scoped LSP (implemented) |
| P3 | 16 | Durable long work, Git isolation, qualified Subagents, and model routing (implemented) |
| P4 | 10 | Isolated professional extensions and regression measurement (baseline; adapters partial) |
| P5 | 10 | Threat-modeled remote, engine, external-orchestrator, and experimental capabilities |
| **Total** | **84** | The baseline gate is repeatable; end-to-end Harness claims remain capability-specific and P5 is not started |

The implementation gate and the exact commands used for this branch are recorded in
[`docs/verification/P0-P4-ACCEPTANCE.md`](verification/P0-P4-ACCEPTANCE.md). The gate is
repeatable; provider-reported token/cost fields remain explicitly unavailable when a
local test does not exercise a real provider.

## P0 — Task kinds and non-breakable execution foundation

### P0-01 — Freeze the current compatibility and performance baseline

- **Task Kind:** Both
- **Depends:** None
- **Outcome:** Record reproducible behavior for Pi RPC, multi-session execution, accounts, custom providers, localization, chat import/backup, startup, idle memory, streaming latency, and long-chat rendering before structural changes.
- **Acceptance:** Baseline commands and artifacts run on Windows; existing failures are named separately; no optimization claim is accepted without before/after evidence.

### P0-02 — Define the durable execution schema v1

- **Task Kind:** Both
- **Depends:** P0-01
- **Outcome:** Version Chat Session, Task Run, Task Kind, Execution Epoch, Agent Run, Workspace Identity, Scratch Space, Task Harness reference, Task Override, job, evidence reference, and lifecycle records.
- **Acceptance:** Schema fixtures cover Simple and Harness tasks, account replacement, suspension, continuation, process restart, and unknown future fields; invalid state transitions are rejected.

### P0-03 — Add transactional migrations and legacy Super Agent import

- **Task Kind:** Both
- **Depends:** P0-02
- **Outcome:** Migrate current metadata and Super Agent JSON into schema v1 without changing or deleting the source until conversion commits successfully.
- **Acceptance:** Success, rollback, interrupted migration, repeat migration, downgrade-read warning, and corrupt-input tests preserve original data and produce deterministic results.

### P0-04 — Implement portable Workspace Identity and rebinding

- **Task Kind:** Both
- **Depends:** P0-02
- **Outcome:** Separate portable project identity from machine paths and require a validated local binding for every workspace-bound task after import or cross-platform restore.
- **Acceptance:** Windows-to-Linux and Linux-to-Windows fixtures cannot execute stale source paths; grouped imported chats rebind once per original workspace; archived state remains unchanged.

### P0-05 — Implement app-owned Scratch Space

- **Task Kind:** Simple
- **Depends:** P0-02
- **Outcome:** Give every workspace-free Simple Task a neutral application-owned working directory without representing it as a user project.
- **Acceptance:** Creation, restart, cleanup, collision, disk-full, and backup/restore tests behave predictably; a Scratch Space path is never exported as a portable Workspace Identity.

### P0-06 — Create the minimal Harness Task shell

- **Task Kind:** Harness
- **Depends:** P0-02, P0-04
- **Outcome:** Create a workspace-bound Harness Task with a versioned built-in Task Harness placeholder, without implementing P1 discovery or verification semantics yet.
- **Acceptance:** Workspace execution is blocked until binding succeeds; the effective template version is visible; creating a Harness Task does not change project files.

### P0-07 — Add the two-choice New Task flow

- **Task Kind:** Both
- **Depends:** P0-05, P0-06
- **Outcome:** Present explicit `Simple Task` and `Harness Task` choices; Simple begins immediately while Harness opens Workspace Binding.
- **Acceptance:** Keyboard, mouse, cancellation, restart, Chinese, and English flows pass; Simple startup performs no workspace discovery, Git inspection, LSP/MCP startup, extension suggestion, or extension process launch.

### P0-08 — Support workspace attachment and Simple-to-Harness conversion

- **Task Kind:** Both
- **Depends:** P0-04, P0-05, P0-06, P0-07
- **Outcome:** Let a Simple Task attach a workspace while remaining Simple or explicitly convert to Harness without replacing its durable identity.
- **Acceptance:** Chat, plan, tasks, account epochs, evidence, and usage survive both paths; conversion appends a Task Kind revision and never rewrites earlier history.

### P0-09 — Separate account handoff from execution continuation

- **Task Kind:** Both
- **Depends:** P0-02
- **Outcome:** Stop only Agent Runs belonging to account A, hand preserved chat/task associations to active account B, and create B's Execution Epoch only after the user types localized `continue` in that chat.
- **Acceptance:** Multi-provider tests prove unrelated work continues; handoff emits no model/tool request; context, plan, todo list, workspace, and evidence survive; incompatible B reports a bounded blocker.

### P0-10 — Unify tool and action authorization

- **Task Kind:** Both
- **Depends:** P0-02
- **Outcome:** Apply one allow/ask/deny decision surface to read, write, execute, secret use, expensive checks, and destructive actions across Pi, Picode, and later extensions.
- **Acceptance:** Decision provenance and scope are visible; denied actions do not partially run; session grants expire correctly; Task Overrides cannot claim permissions the underlying tool/API did not grant.

### P0-11 — Enforce stale-write preconditions

- **Task Kind:** Both
- **Depends:** P0-10
- **Outcome:** Add read-version or content-hash preconditions to Picode-managed edits without making Git mandatory for Simple or direct workflows.
- **Acceptance:** Concurrent modification rejects the stale write and requests a reread; untouched user content survives; atomic replacement failures leave either the old or complete new file, never a partial file.

### P0-12 — Implement temporary secrets and Secret References

- **Task Kind:** Both
- **Depends:** P0-02, P0-10
- **Outcome:** Support task-temporary secret values and durable references to OS credentials, environment variables, or user-selected files, resolving values only at execution time.
- **Acceptance:** Secret values never appear in chat, model context, logs, exports, fixtures, project config, or the Picode database; task-owned temporary copies are destroyed; user-owned source files are never deleted.

### P0-13 — Persist visible Task Overrides

- **Task Kind:** Harness
- **Depends:** P0-02, P0-06, P0-10
- **Outcome:** Record explicit user- or Skill-directed changes to a Task Harness separately from the reusable template and project Profile.
- **Acceptance:** Source, scope, changed actions/Git strategy/gates, start/end, and completion-label effect are visible; restart restores the override; unrelated tasks and project files remain unchanged.

### P0-14 — Build the Agent Run registry

- **Task Kind:** Both
- **Depends:** P0-02
- **Outcome:** Replace PID-only liveness as the product model with durable main/background Agent Runs linked to chat, task, epoch, process, provider, account, model, and parent Agent Run.
- **Acceptance:** Start, running, waiting, completed, failed, cancelled, and terminated transitions are deterministic; dead processes are reconciled after restart; stale instance files do not create live Agent Runs.

### P0-15 — Collect bounded runtime resources and model usage

- **Task Kind:** Both
- **Depends:** P0-14
- **CSR required:** Cross-platform process sampling and provider usage normalization
- **Outcome:** Collect adaptive PID CPU, memory, uptime, request, token, and cost samples while explicitly marking shared, estimated, provider-reported, or unavailable attribution.
- **Acceptance:** Windows metrics match owned processes within defined tolerance; unsupported provider fields remain unavailable; sampling has a measured bounded CPU/memory cost and retention never grows without limit.

### P0-16 — Implement runtime health and stall assessment

- **Task Kind:** Both
- **Depends:** P0-14, P0-15
- **Outcome:** Derive running, model-wait, tool-wait, user/permission-wait, suspected-stall, unresponsive, and terminal states from liveness, control probes, and meaningful progress.
- **Acceptance:** Low CPU, long model calls, declared long tools, and permission waits do not create false stalls; failed probes produce unresponsive within a defined window; suspected stall never auto-terminates work.

### P0-17 — Ship Runtime Monitor v1

- **Task Kind:** Both
- **Depends:** P0-14, P0-15, P0-16
- **Outcome:** Add a local UI listing active and recent Agent Runs with identity, chat/task, provider/account/model, state, action, duration, last progress, resources, usage, and termination result.
- **Acceptance:** Counts match the Agent Run registry; uncertainty labels are visible; inspect, open-chat, cancel, and retry target the selected run; one Agent's action cannot affect another by port ambiguity.

### P0-18 — Recover durable tasks after application or process failure

- **Task Kind:** Both
- **Depends:** P0-03, P0-09, P0-14, P0-16
- **Outcome:** Reconcile durable Task Runs, Execution Epochs, Agent Runs, and background jobs after crash or restart without fabricating live work or silently resuming execution.
- **Acceptance:** Recovery fixtures cover app crash, Pi crash, machine restart, account loss, partial ledger write, and workspace drift; every run ends in a truthful resumable, terminated, blocked, or completed state.

### P0-19 — Complete bilingual task/runtime UI coverage

- **Task Kind:** Both
- **Depends:** P0-07, P0-09, P0-13, P0-17, P0-18
- **Outcome:** Add versioned English and Simplified Chinese XML strings for all new choices, states, warnings, actions, errors, and completion labels using the normalized typography system.
- **Acceptance:** Extraction reports no missing or orphaned keys; runtime language switching updates the new UI; layout tests cover long Chinese and English labels without fallback strings.

### P0-20 — Pass the P0 compatibility and recovery gate

- **Task Kind:** Both
- **Depends:** P0-03 through P0-19
- **Outcome:** Prove the P0 foundation preserves existing account import, Codex reverse proxy, Cursor/Claude channels, custom OpenAI/Anthropic providers, localization, chat import, backup/restore, compaction, and Picot compatibility identifiers.
- **Acceptance:** Focused suites plus `bun run test`, `bun run check`, and `bun run check:rust` pass when their owned code changed; Windows performance is compared with P0-01; remaining failures are classified rather than hidden.

## P1 — Optional Harness Task verification loop

**Entry gate:** P0-20 is complete.

### P1-01 — Define and validate Harness Profile JSONC v1

- **Task Kind:** Harness
- **Depends:** P0 complete
- **Outcome:** Publish a strict, versioned JSONC schema for `.picode/harness.jsonc` containing only portable project definitions.
- **Acceptance:** Valid examples round-trip with comments; invalid versions, unknown required semantics, absolute paths, credentials, and malformed actions reject the entire document with actionable errors.

### P1-02 — Version the built-in Harness Task template

- **Task Kind:** Harness
- **Depends:** P1-01
- **Outcome:** Replace the P0 placeholder with a reviewable built-in template that can compose with an optional project Profile and task-local Task Overrides.
- **Acceptance:** The effective Task Harness has a deterministic fingerprint; updating Picode does not silently rewrite a running task's template; the unmodified and overridden forms are distinguishable.

### P1-03 — Discover candidate Harness Actions deterministically

- **Task Kind:** Harness
- **Depends:** P1-01
- **CSR required:** Pi extensions and comparable agent command-discovery mechanisms
- **Outcome:** Inspect project rules, package/build scripts, CI definitions, and declared sources to produce candidates with provenance, never executable trusted actions.
- **Acceptance:** Fixtures cover conflicting sources, monorepos, missing tools, platform-specific commands, and malicious text; discovery never executes project code or converts a Simple Task.

### P1-04 — Build the Profile draft review UI

- **Task Kind:** Harness
- **Depends:** P1-03
- **Outcome:** Let users compare candidate sources and differences, choose canonical actions, keep alternatives disabled, and reject unsuitable discoveries.
- **Acceptance:** Nothing becomes trusted without confirmation; conflicts are not silently resolved by source priority; cancel leaves project and Task Harness unchanged; English/Chinese accessibility paths pass.

### P1-05 — Separate portable Profile data from local slots

- **Task Kind:** Harness
- **Depends:** P1-01, P0-04, P0-12
- **Outcome:** Store portable action semantics in the project Profile and resolve machine paths, environment values, tools, and secrets through named local slots.
- **Acceptance:** The same Profile binds on Windows, Linux, and macOS fixtures without path translation; unresolved required slots block only affected actions and never expose secret values.

### P1-06 — Compose root Profiles, overlays, and Task Overrides

- **Task Kind:** Harness
- **Depends:** P1-02, P1-05, P0-13
- **Outcome:** Resolve the effective Task Harness from the built-in template, root Profile, scoped module/package overlays, and visible task-local overrides.
- **Acceptance:** Activation follows actual target and changed paths rather than chat window; precedence and provenance are deterministic; ambiguous overlapping overlays stop for review.

### P1-07 — Execute typed Harness Actions

- **Task Kind:** Harness
- **Depends:** P1-05, P1-06, P0-10
- **CSR required:** Pi-native structured execution and OMP/comparable action runners
- **Outcome:** Execute stable action IDs with typed parameters, explicit cwd, timeout, risk, dependencies, platform variants, executable-plus-argument form, and explicitly typed shell fallback.
- **Acceptance:** Undeclared parameters, arbitrary appended arguments, missing platform variants, invalid dependency graphs, and unapproved risk escalation are rejected before process start.

### P1-08 — Implement trust confirmation and drift review

- **Task Kind:** Harness
- **Depends:** P1-03, P1-04, P1-07
- **Outcome:** Fingerprint each discovery source, retain confirmation for unchanged actions, and request focused review only for affected definitions.
- **Acceptance:** Unchanged actions stay trusted; changed/disappeared sources become drifted; a trusted definition still passes per-invocation authorization; drift never silently falls back to guessed commands.

### P1-09 — Map change scope to Completion Gates

- **Task Kind:** Harness
- **Depends:** P1-06, P1-07
- **Outcome:** Select applicable Harness Actions from explicit path/target/change-type mappings, then supplement with local dependency, symbol, and actual change evidence when available.
- **Acceptance:** Selection rationale is visible; uncertainty broadens checks or asks rather than narrowing silently; a Task Override produces a separately fingerprinted effective gate set.

### P1-10 — Capture comparable verification baselines

- **Task Kind:** Harness
- **Depends:** P1-07, P1-09
- **CSR required:** Baseline and known-failure approaches in Pi/OMP/comparable agents
- **Outcome:** Capture low-cost relevant pre-write results and reuse historical baselines only when code, Profile, platform, and material environment match.
- **Acceptance:** Dirty user state is recorded; non-comparable results cannot dismiss a failure; confirmed Known Failures remain separate from new or worsened regressions.

### P1-11 — Evaluate structured success, retries, and flakiness

- **Task Kind:** Harness
- **Depends:** P1-07, P1-10
- **CSR required:** Structured test/report adapters and retry semantics
- **Outcome:** Evaluate exit codes, artifacts, machine-readable reports, and bounded patterns; retain every declared retry and mark pass-after-failure as flaky. Every Completion Gate may also declare a controlled red-probe action whose failure proves the Gate is capable of rejecting a bad candidate.
- **Acceptance:** Exit code zero cannot override a failed predicate; an undeclared retry cannot run automatically; missing expected reports fail clearly; model prose cannot manufacture success; a Gate without a red probe is visibly incomplete rather than Harness verified; a passing red probe does not count as validity evidence.

### P1-12 — Implement the Evidence Ledger and Artifact store

- **Task Kind:** Harness
- **Depends:** P0-02, P1-07, P1-11
- **CSR required:** Pi/OMP/comparable bounded-output and artifact retention mechanisms
- **Outcome:** Store append-only evidence metadata and bounded previews in task history while retaining full content-addressed outputs outside model context.
- **Acceptance:** Artifact hashes verify; attempts and cleanup events remain traceable; large output does not flood chat or prompt context; a missing artifact is reported rather than silently ignored.

### P1-13 — Add evidence redaction, encryption, and retention

- **Task Kind:** Harness
- **Depends:** P1-12, P0-12
- **Outcome:** Redact before UI, ledger, model, or export; apply project retention/capacity policy and optional local encryption to sensitive artifacts.
- **Acceptance:** Seeded secrets are absent from all surfaces; cleanup preserves summary/hash/audit; capacity limits cannot delete active-task evidence without a visible policy event.

### P1-14 — Ship truthful completion labels

- **Task Kind:** Both
- **Depends:** P1-06, P1-09, P1-11, P1-12
- **Outcome:** Distinguish Simple completed, Harness verified, Harness verified with overrides, incomplete Harness verification, suspended, environment blocked, and failed.
- **Acceptance:** Simple never claims Harness verification; every effective gate must pass and have red-capable validity evidence for its verified label; skipped/replaced template gates and flaky passes stay visible.

### P1-15 — Pass the P1 Harness contract gate

- **Task Kind:** Harness
- **Depends:** P1-01 through P1-14
- **Outcome:** Demonstrate one small project and one multi-module project through discovery, confirmation, execution, baseline comparison, evidence retention, override, and completion.
- **Acceptance:** Windows passes end to end; Linux/macOS variants are exercised in CI or documented test environments; Simple startup and behavior remain unchanged from P0.

## P2 — Low-cost code intelligence and tool discovery

**Entry gate:** P1-15 is complete.

### P2-01 — Operationalize Capability Source Reviews

- **Task Kind:** Both
- **Depends:** P1-15
- **Outcome:** Provide a reusable review template and issue check for source candidates, pinned versions, licenses/notices, security, maintenance, Pi compatibility, runtime cost, and rejection reasons.
- **Acceptance:** A new non-core capability cannot be marked implementation-ready without the review; proprietary or unlicensed sources are clearly limited to independent behavioral reference.

### P2-02 — Enforce the resident core capability boundary

- **Task Kind:** Both
- **Depends:** P2-01
- **Outcome:** Inventory and enforce the smallest resident search/read/edit/execute surface while keeping optional implementations and full schemas unloaded.
- **Acceptance:** A new Simple Task exposes only the agreed Pi core surface; startup tests detect accidental optional imports, processes, schemas, or suggestions.

### P2-03 — Define extension manifests and the Capability Catalog

- **Task Kind:** Both
- **Depends:** P2-01, P2-02
- **CSR required:** Pi package/extension metadata and OMP/comparable lazy capability catalogs
- **Outcome:** Register Global and Task Extensions through lightweight, versioned manifests containing identity, summary, permissions, availability, source, and lazy-load locator.
- **Acceptance:** Invalid or incompatible manifests are isolated; one hundred inert registrations stay bounded; catalog records survive restart without starting extension processes.

### P2-04 — Add deterministic `search_tools`

- **Task Kind:** Both
- **Depends:** P2-03
- **CSR required:** Pi/OMP tool-search implementations
- **Outcome:** Search the local Capability Catalog without loading full schemas or making another model call.
- **Acceptance:** Stable queries return ranked bounded results with source and permission hints; no matching extension remains unloaded; Simple Tasks cannot search until the user opts in.

### P2-05 — Implement on-demand extension loading and unloading

- **Task Kind:** Both
- **Depends:** P2-03, P2-04, P0-10
- **CSR required:** Pi extension lifecycle and comparable process isolation patterns
- **Outcome:** Load the selected full schema and implementation only when invoked, then release idle task-owned resources while retaining discoverability.
- **Acceptance:** Disabled/inert extensions consume no process budget; cancellation and failed startup clean up; one extension cannot impersonate another capability or expand permissions silently.

### P2-06 — Parse Task Extension `TOOLS.md` declarations

- **Task Kind:** Both
- **Depends:** P2-03
- **Outcome:** Bind human-readable task capability declarations to Task Runs and inject a compact deterministic digest at task start, restore, and account continuation.
- **Acceptance:** Missing, malformed, changed, and conflicting declarations produce visible state; bindings never become global; a new Simple Task has none unless explicitly added.

### P2-07 — Surface Skill provenance and Task Overrides

- **Task Kind:** Both
- **Depends:** P2-03, P2-06, P0-13
- **Outcome:** Distinguish installed, discovered, suggested, explicitly invoked, active, expired, and conflicting Skills in the capability/task UI.
- **Acceptance:** Only Explicit Skill Invocation gains workflow precedence; source and scope survive restart; conflicts between invoked Skills require user direction rather than implicit ordering.

### P2-08 — Add bounded Global Extension relevance hints

- **Task Kind:** Both
- **Depends:** P2-03, P2-04
- **Outcome:** Produce a small deterministic shortlist for opted-in tasks without injecting the entire catalog or issuing a model request.
- **Acceptance:** Ranking is reproducible and capped; Simple opt-in is explicit and reversible; irrelevant or disabled capabilities are not injected.

### P2-09 — Standardize stale-safe patching and optional content anchors

- **Task Kind:** Both
- **Depends:** P0-11, P2-01
- **CSR required:** Pi editing extensions, OMP Hashline, and comparable anchor-based editors
- **Outcome:** Offer one standard patch surface backed by stale-content rejection, with optional model-specific content anchors rather than a mandatory custom syntax.
- **Acceptance:** Concurrent edits fail safely; reread-and-retry succeeds; line drift is detected; adapters cannot bypass the underlying version precondition.

### P2-10 — Build a bounded local code index

- **Task Kind:** Harness
- **Depends:** P2-01, P0-04
- **CSR required:** Pi/OMP/comparable local symbol and project indexes
- **Outcome:** Index text, files, symbols, modules, targets, and test mappings incrementally without a remote vector database or full-workspace prompt injection.
- **Acceptance:** Index size and refresh work are bounded; changed/deleted files reconcile; secrets and excluded paths are absent; querying does not start unrelated language services.

### P2-11 — Add lazy scoped LSP lifecycle

- **Task Kind:** Both
- **Depends:** P2-01, P2-10
- **CSR required:** Existing Pi LSP extensions first, then OMP/comparable implementations
- **Outcome:** Start language servers only for task-selected languages/modules, expose navigation/type/reference data and post-write diagnostics, and stop after idle timeout.
- **Acceptance:** Simple starts no LSP automatically; unrelated languages are not scanned; crash/restart and cancellation clean up; diagnostics are tied to the file version that produced them.

### P2-12 — Bound model-facing files, logs, and tool results

- **Task Kind:** Both
- **Depends:** P1-12, P2-03
- **Outcome:** Give the model bounded previews and structured summaries while retaining full content outside prompt context with explicit fetch-on-demand.
- **Acceptance:** Large-file/log fixtures stay under configured limits; truncation is visible; full content remains addressable; no silent tail/head loss is presented as complete evidence.

### P2-13 — Pass the P2 lazy-capability and code-intelligence gate

- **Task Kind:** Both
- **Depends:** P2-01 through P2-12
- **Outcome:** Prove useful code navigation and capability discovery without turning startup, idle memory, or Simple Tasks into a heavyweight IDE.
- **Acceptance:** One hundred inert extensions, multiple languages, stale writes, restart, task continuation, and Simple opt-in scenarios pass; measured startup/idle regressions stay within the accepted budget.

## P3 — Durable long work, isolated concurrency, and qualified Subagents

**Entry gate:** P2-13 is complete.

### P3-01 — Implement the durable task graph

- **Task Kind:** Harness
- **Depends:** P2-13
- **Outcome:** Represent stages, dependencies, owner, blockers, acceptance evidence, current state, and continuation checkpoint without replacing Task Run history.
- **Acceptance:** Cycles and missing dependencies reject; partial completion and replanning append revisions; restart restores the same ready/blocked set deterministically.

### P3-02 — Build the background process manager

- **Task Kind:** Both
- **Depends:** P0-14, P0-18, P1-12
- **CSR required:** Pi background tools, OMP jobs, and comparable agent job managers
- **Outcome:** Own long-running tool processes with bounded live tail, full artifact, timeout, cancellation, exit confirmation, task attribution, and restart reconciliation.
- **Acceptance:** Output pressure cannot block the child; cancel targets the correct process tree; dead jobs are not restored as live; terminal status and complete output remain inspectable.

### P3-03 — Add deterministic checkpoint and handoff packages

- **Task Kind:** Both
- **Depends:** P0-02, P0-09, P1-12, P3-01
- **Outcome:** Persist compact goal, constraints, plan, state, decisions, pending work, workspace facts, tool bindings, and evidence references before compaction, account/model change, or suspension.
- **Acceptance:** A replacement account/model resumes without repeated user explanation; no secret value enters the package; deterministic state is preferred over model-generated summary.

### P3-04 — Define optional Git-managed protection policy

- **Task Kind:** Harness
- **Depends:** P0-11, P1-06
- **Outcome:** Let the effective Task Harness or explicit user instruction enable repository baseline, change attribution, Write Leases, and Safe Worktrees without imposing Git on Simple/direct workflows.
- **Acceptance:** Enabling is visible and versioned; non-Git tasks remain usable; existing branch/index/dirty/untracked state is recorded before managed writes.

### P3-05 — Enforce Write Leases

- **Task Kind:** Harness
- **Depends:** P3-04, P0-14
- **CSR required:** Comparable local workspace lease and concurrency mechanisms
- **Outcome:** Grant at most one managed writer to a physical working directory while allowing unrelated directories and read-only work to proceed.
- **Acceptance:** Aliases, symlinks, case differences, and cross-platform path forms resolve to the same physical target; stale leases reconcile after crashes; port or chat ambiguity cannot steal a lease.

### P3-06 — Manage Safe Worktree lifecycle

- **Task Kind:** Harness
- **Depends:** P3-04, P3-05
- **CSR required:** Git worktree workflows in Claude Code, OMP, and comparable agents
- **Outcome:** Create authorized task branches/Worktrees for concurrent writers and preserve them until explicit integration or removal.
- **Acceptance:** Creation never starts from an unintended ref; user dirty changes remain untouched; failures are recoverable; Picode does not auto-merge or auto-delete under the default template.

### P3-07 — Add Git review and explicit integration workflow

- **Task Kind:** Harness
- **Depends:** P3-06, P1-12
- **Outcome:** Present owned diffs/hunks, evidence, conflicts, target branch, and integration choices without treating staging/commit/merge as implicit completion.
- **Acceptance:** Unowned or overlapping changes are clearly separated; integration requires the authority defined by the effective task workflow; abort leaves branch and Worktree recoverable.

### P3-08 — Implement the optional Subagent runtime

- **Task Kind:** Harness
- **Depends:** P2 complete, P3-01, P3-02
- **CSR required:** Pi Subagent extensions first, then OMP, Claude Code, OpenCode, and comparable agents
- **Outcome:** Spawn bounded Subagent Agent Runs with explicit parent, isolated context package, allowed tools, permissions, expected evidence, foreground/background mode, cancellation, and result channel.
- **Acceptance:** Disabled means no resident cost; Subagents cannot spawn nested Subagents by default; blocked workers report to the parent rather than expanding scope or authority.

### P3-09 — Enforce the default delegation envelope

- **Task Kind:** Harness
- **Depends:** P3-08, P0-10, P3-03
- **Outcome:** Require the main Agent to declare goal, scope, method, tools, permissions, context, stop conditions, and expected result before default-template delegation.
- **Acceptance:** Missing fields block spawn; the child cannot access undeclared tools or scope; explicit user/Skill overrides remain visible and do not silently mutate the reusable template.

### P3-10 — Add user-configurable Subagent Model Policy

- **Task Kind:** Both
- **Depends:** P3-08, existing provider/model catalog
- **Outcome:** Let users choose eligible provider/model candidates and an unavailable-model fallback of `do not delegate`, `inherit main model`, or `ask`.
- **Acceptance:** Configuration alone never spawns work; removed/unhealthy accounts are rejected; policy scope and fallback are visible; no arbitrary model substitution occurs.

### P3-11 — Implement deterministic Delegation Eligibility filters

- **Task Kind:** Both
- **Depends:** P3-09, P3-10
- **Outcome:** Admit automatic cheaper-model routing only for simple, bounded, independent, low-risk, small-context, independently verifiable work.
- **Acceptance:** Writes, architecture, ambiguous multi-step investigation, secret use, deployment, destructive actions, frequent interaction, and unverifiable results reject before any model ranking.

### P3-12 — Route qualified work and record the decision

- **Task Kind:** Both
- **Depends:** P3-10, P3-11
- **Outcome:** Rank eligible candidates by capability, context, tools, provider health, measured quality, latency, then cost, and persist the reason, fallback, envelope, and result.
- **Acceptance:** Price alone cannot win; unavailable/incompatible candidates follow the configured fallback; the Runtime Monitor and task ledger show the selected model and routing reason.

### P3-13 — Build model-routing evaluations and promotion gates

- **Task Kind:** Both
- **Depends:** P3-11, P3-12
- **CSR required:** Evaluation methods from mature agent projects and provider guidance
- **Outcome:** Establish a capable-model baseline for search, repository mapping, documentation lookup, bounded log classification, and supplied-context summarization, then qualify cheaper models per class.
- **Acceptance:** Automatic routing remains off for an unevaluated model/class pair; thresholds, datasets, regressions, latency, and cost are versioned; a failing model is demoted without changing user history.

### P3-14 — Extend Runtime Monitor to full Agent hierarchies

- **Task Kind:** Both
- **Depends:** P0-17, P3-08, P3-12
- **Outcome:** Display parent/child Agent Runs, delegation envelope, model policy/selection, background status, last progress, process attribution, usage, and result flow in one hierarchy.
- **Acceptance:** Concurrent children cannot overwrite each other's metrics or controls; shared-process values are labeled; completed, failed, cancelled, suspected-stall, and unresponsive children remain diagnosable.

### P3-15 — Require main-Agent review and effective-Harness verification

- **Task Kind:** Harness
- **Depends:** P3-07, P3-08, P1-14
- **Outcome:** Return Subagent work as a candidate result for main-Agent review, integration, and the effective Task Harness gates under the default template.
- **Acceptance:** Child completion alone cannot mark the parent Harness verified; rejected results preserve evidence; overridden review or gates produce the corresponding visible Task Override and completion label.

### P3-16 — Pass the P3 recovery, concurrency, and routing gate

- **Task Kind:** Both
- **Depends:** P3-01 through P3-15
- **Outcome:** Prove long-running tasks, crashes, account/model handoff, parallel read work, isolated writes, Subagent routing, cancellation, and restart recovery as one coherent lifecycle.
- **Acceptance:** No shared-worktree write race, fabricated live process, lost checkpoint, silent model fallback, unreviewed child completion, or unrecoverable user change occurs in the adversarial suite.

## P4 — Extensible professional workflows

**Entry gate:** P3-16 is complete.

### P4-01 — Build the isolated heavy-extension host

- **Task Kind:** Both
- **Depends:** P3-16
- **CSR required:** Pi extension isolation first, then OMP/OpenCode/comparable plugin hosts
- **Outcome:** Run heavy optional capabilities out of process with explicit startup, health, cancellation, crash isolation, resource limits, and cleanup.
- **Acceptance:** A crash, hang, excessive output, or memory breach cannot terminate/corrupt the Chat Session; disabled extensions have no resident process; Runtime Monitor exposes owned resources.

### P4-02 — Version extension permissions and migrations

- **Task Kind:** Both
- **Depends:** P4-01, P0-10, P2-03
- **Outcome:** Persist manifest/schema versions, granted capabilities, upgrade changes, and migration results without treating an update as renewed blanket authority.
- **Acceptance:** Permission expansion requires review; downgrade/incompatible versions fail safely; migration rollback preserves prior configuration and task bindings.

### P4-03 — Define project and task adapter contracts

- **Task Kind:** Harness
- **Depends:** P1 complete, P4-01
- **Outcome:** Let extensions translate engine/framework/project semantics into Harness Actions, diagnostics, artifacts, and local slots without moving engine-specific behavior into core.
- **Acceptance:** Two unrelated adapters coexist; disabling one leaves the core and project Profile readable; adapter provenance and active scope are visible.

### P4-04 — Import external rules, Skills, and commands selectively

- **Task Kind:** Both
- **Depends:** P2-07, P4-02
- **CSR required:** Supported Codex, Claude, Cursor, and OpenCode formats
- **Outcome:** Preview and selectively import compatible rules, Skills, and commands with source, version, conflicts, scope, and enablement state.
- **Acceptance:** Import is manual; unsupported semantics are reported rather than guessed; nothing silently overrides Picode defaults or project Profiles; explicit invocation creates a Task Override.

### P4-05 — Import and lifecycle-manage MCP configuration

- **Task Kind:** Both
- **Depends:** P2-03, P2-05, P4-02
- **CSR required:** MCP specification and mature client lifecycle implementations
- **Outcome:** Selectively import MCP servers as Global or Task Extensions with command/env/transport review, secret references, lazy start, health, and cleanup.
- **Acceptance:** Secrets are references; unselected servers never start; task-bound servers do not become global; failure or cancellation leaves no orphan process.

### P4-06 — Add optional DAP debugging

- **Task Kind:** Harness
- **Depends:** P4-01, P4-03
- **CSR required:** Existing Pi debugger extensions, DAP specification, OMP/comparable adapters
- **Outcome:** Expose debugger sessions as optional task capabilities with explicit launch/attach configuration, lifecycle, bounded events, and Harness evidence integration.
- **Acceptance:** No debugger starts at app launch; unsupported platform/configuration blocks clearly; stopping a task cleans the debugger without killing unrelated user processes.

### P4-07 — Add structured review and project diagnostics

- **Task Kind:** Harness
- **Depends:** P4-03, P1-12, P2-11
- **CSR required:** Pi review/diagnostic extensions, OMP, and comparable agents
- **Outcome:** Provide replaceable code-review and project-diagnostic adapters that emit structured findings, severity, location, provenance, and evidence.
- **Acceptance:** Findings are deduplicated and version-bound; model opinions remain distinguishable from deterministic diagnostics; adapters cannot mark Harness completion by themselves.

### P4-08 — Add optional multi-model advisory roles

- **Task Kind:** Both
- **Depends:** P3-08, P3-10, P4-01
- **CSR required:** Mature multi-agent advisory and debate patterns
- **Outcome:** Let the main Agent request bounded second opinions without handing advisers write authority or treating agreement as evidence.
- **Acceptance:** Role, model, context, cost, and output are visible; advisers cannot act outside declared tools; conflicting advice returns to the main Agent/user for a decision.

### P4-09 — Build the Picode agent regression harness

- **Task Kind:** Both
- **Depends:** P1-12, P3-13
- **CSR required:** Open agent-evaluation harnesses and coding-agent benchmark methodology
- **Outcome:** Measure task success, edit retries, verification accuracy, routing quality, token/cost, startup, interaction latency, idle/peak memory, and false-stall rate on versioned local scenarios.
- **Acceptance:** Runs are reproducible and retain artifacts; benchmark changes are reviewed; results compare versions/models without mixing incompatible environments.

### P4-10 — Pass the P4 isolation and extensibility gate

- **Task Kind:** Both
- **Depends:** P4-01 through P4-09
- **Outcome:** Demonstrate that professional extensions add capability without increasing Simple startup cost or weakening task, permission, secret, and evidence boundaries.
- **Acceptance:** Crash/resource-limit/import-conflict/permission-upgrade/disable/restart suites pass; performance and task-success claims link to P4-09 artifacts.

## P5 — Remote and experimental capabilities

P5 items begin as PRDs and threat models. Completing discovery does not authorize shipping; each capability must earn promotion through its own acceptance and resource budget.

**Entry gate:** P4-10 is complete.

### P5-01 — Specify the remote-control trust boundary

- **Task Kind:** Both
- **Depends:** P4-10, ADR-0007 Chat Control Interface
- **CSR required:** Secure local-first remote-control architectures
- **Outcome:** Define identity, pairing, transport, encryption, session scope, revocation, audit, LAN/Internet boundaries, unattended behavior, and recovery before adding a remote client.
- **Acceptance:** Threat model covers stolen phone, LAN attacker, replay, stale pairing, malicious link, secret exposure, privilege escalation, and lost host; deny-by-default behavior is testable.

### P5-02 — Ship an opt-in phone Remote Control MVP

- **Task Kind:** Both
- **Depends:** P5-01, P0-17, ADR-0007 Chat Control Interface
- **CSR required:** Existing Pi/Picot remote packages and compatible open-source clients
- **Outcome:** View chats and Runtime Monitor, send prompts, approve/deny surfaced actions, and cancel selected Agent Runs from a paired phone without a second control plane.
- **Acceptance:** Disabled means no listener; pairing/revocation works; reconnect preserves identity; phone actions target the exact chat/run and remain audited.

### P5-03 — Evaluate browser and desktop computer-use extension

- **Task Kind:** Both
- **Depends:** P4-01, P5-01
- **CSR required:** Pi extensions and mature browser/computer-use agents
- **Outcome:** Produce a PRD, prototype boundary, permission model, visual evidence format, latency/resource budget, and go/no-go result for optional computer use.
- **Acceptance:** Prototype cannot access unapproved apps/sites; sensitive visual data handling is explicit; failure cannot take over the main Agent or silently broaden authority.

### P5-04 — Evaluate collaboration and shared review

- **Task Kind:** Harness
- **Depends:** P5-01, P3-16
- **CSR required:** Local-first collaborative agent and review systems
- **Outcome:** Define participant identity, read/write/review roles, conflict handling, audit, workspace ownership, and account isolation for optional collaboration.
- **Acceptance:** Single-user behavior remains default; remote participants cannot inherit local credentials; every externally initiated action is attributable and revocable.

### P5-05 — Add optional voice and image workflows

- **Task Kind:** Both
- **Depends:** P4-01
- **CSR required:** Pi multimodal extensions and provider-native media APIs
- **Outcome:** Add replaceable capture, transcription, image input, and response rendering capabilities with explicit provider/model support and resource limits.
- **Acceptance:** Unsupported models fail before upload; local media lifecycle and privacy are visible; disabled media components consume no resident process budget.

### P5-06 — Evaluate automated research and long-term memory

- **Task Kind:** Both
- **Depends:** P2-12, P4-01, P5-01 when remote
- **CSR required:** Pi memory/research extensions, memory-journal lineage, and comparable agents
- **Outcome:** Separate bounded task checkpoints from optional durable memory/research services and define provenance, consent, retention, deletion, retrieval, and cost controls.
- **Acceptance:** Memory is off by default; users can inspect/delete/export it; retrieved claims retain source/time; no secret or entire workspace is stored implicitly.

### P5-07 — Evaluate larger remote worker pools

- **Task Kind:** Harness
- **Depends:** P3-16, P5-01
- **CSR required:** Mature distributed agent schedulers and remote execution systems
- **Outcome:** Define worker identity, capability advertisement, scheduling, isolation, artifact transfer, cancellation, failure recovery, cost budgets, and trust boundaries for more than local Subagents.
- **Acceptance:** The design prevents a worker from receiving undeclared secrets/workspace scope; partial failure is recoverable; local single-machine execution remains fully supported.

### P5-08 — Apply experimental-feature promotion gates

- **Task Kind:** Both
- **Depends:** Any P5 candidate seeking release
- **Outcome:** Decide whether an experiment remains external, ships disabled, graduates to a lower phase, or is rejected based on security, usefulness, reliability, performance, maintenance, and Pi compatibility evidence.
- **Acceptance:** Every decision links its PRD, threat model, Capability Source Review, tests, resource measurements, and unresolved risks; no candidate is promoted from demo behavior alone.

### P5-09 — Add optional game content pipeline validation adapters

- **Task Kind:** Harness
- **Depends:** P4-01, P1-07, P1-09, P1-12
- **CSR required:** Pi engine/project extensions, Unity/Unreal/Godot validation workflows, and comparable game build pipelines
- **Outcome:** Provide disabled-by-default, third-tier adapters that validate engine resource references, GUIDs, serialization, import settings, scenes, Prefabs/Blueprints, generated data, Cook/package output, and runtime loading without authoring artistic content.
- **Acceptance:** Each adapter has an explicit enablement and environment contract; validation runs only in the selected task/CI context; controlled broken references prove Red-capable Gates; artifacts identify affected content and platform; disabling the adapter removes it from the Agent catalog and starts no engine process.

### P5-10 — Add optional Firstmate crew-orchestrator adapter

- **Task Kind:** Harness
- **Depends:** P4-01, P1-07, P1-09, P1-12, P3-06
- **Outcome:** Expose [`kunchenguid/firstmate`](capability-source-reviews/firstmate-2026-07-31.md) as a disabled-by-default Tier-3 external component. When explicitly enabled, Picode can launch a user-authorized firstmate session with an isolated `FM_HOME`, bounded worker/backend resources, and a selected Git worktree, then import a scout report, patch/worktree reference, or PR metadata as unverified evidence.
- **CSR required:** The firstmate review above is mandatory; Pi-native `pi-subagents` remains the first choice for in-process delegation, and OMP/comparable agent behavior must be reconsidered before any new wrapper code.
- **Acceptance:** Disabled means no Agent catalog entry, process, dependency install, or project access; enabling persists only the manifest; invocation requires explicit project/backend/worker/merge authority; cancellation and restart reconcile child processes; returned changes never auto-merge/push; Picode/CI must run the declared Gate and mark the result verified before Harness completion.

## Recommended first execution waves

1. **Baseline:** P0-01.
2. **Durable spine:** P0-02.
3. **Parallel foundation tracks:** P0-03, P0-04, P0-05, P0-09, and P0-14.
4. **Task creation:** P0-06, P0-07, and P0-08.
5. **Execution boundaries:** P0-10, P0-11, P0-12, and P0-13.
6. **Runtime observability:** P0-15, P0-16, and P0-17.
7. **Recovery and release gate:** P0-18, P0-19, and P0-20.

Do not start P1 merely because one P0 UI appears complete. P1 begins after P0-20 proves migration, continuation, cross-platform binding, secrets, Runtime Monitor truthfulness, and existing-feature compatibility together.
