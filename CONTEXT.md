# Picode

Picode is a desktop interface for working with Pi agents. It preserves Picot's interaction model while making localization, external account access, and responsive desktop use first-class product concerns.

## Language

**Language Pack**:
A selectable collection of all user-facing Picode text for one language. English and Simplified Chinese are built in, and additional user-installed packs may be selected without rebuilding the application.
_Avoid_: Translation file, skin

**Language Fallback**:
The use of built-in English for a text key missing from the selected Language Pack. An invalid pack is rejected as a whole, leaving the last valid language active.
_Avoid_: Blank text, partial pack activation

**Interface Language**:
The selected Language Pack applied live to Picode's own controls, menus, statuses, and built-in notices across every open window. It does not translate conversation content, model responses, tool output, or files.
_Avoid_: Conversation language, response translation

**Effects Mode**:
The user's choice between Picot's full visual effects and a reduced-effects presentation that removes measured sources of rendering delay without changing layout or interaction.
_Avoid_: Low-quality mode, different theme

**Imported Agent Configuration**:
A user-approved copy of provider access settings discovered from a local Codex, Claude, or Cursor installation. Pi uses the imported access independently; Picode does not control the source application's process or active conversations.
_Avoid_: Agent takeover, session injection

**Credential Import File**:
A JSON document manually selected by the user to import one or more Codex, Claude, or Cursor login credentials. It enters the same preview-and-confirm flow as locally discovered credentials and is never loaded automatically.
_Avoid_: Automatic credential scan, configuration backup

**Credential Transfer**:
The one-time import of an official OAuth credential into the Account Vault. It does not remain synchronized with the source application and may cause the source login to expire when the provider rotates a shared refresh token.
_Avoid_: Shared login, credential synchronization

**Import Review**:
The confirmation step that identifies credentials found in a selected file or local application, shows the accounts and authentication types, and lets the user choose which ones to activate.
_Avoid_: Silent import, automatic activation

**Account Vault**:
Picode's protected collection of normalized Codex, Claude, and Cursor accounts. It retains multiple credentials without retaining the source JSON documents from which they were imported.
_Avoid_: JSON archive, Pi auth file

**Ephemeral Credential**:
A credential available only for the current application run when the operating system's protected credential storage is unavailable. It disappears when Picode closes and is never written to disk as plain text.
_Avoid_: Unencrypted saved account, temporary file

**Settings Export**:
A portable copy of language, interface, provider address, model, and other non-secret preferences. It never contains Account Vault credentials, OAuth tokens, or API keys.
_Avoid_: Account backup, credential export

**Chat Backup**:
A portable, lossless archive of selected Picode conversations, branches, task state, organization metadata, source provenance, workspace identities, and non-secret model metadata. It excludes credentials and all files contained in the associated workspaces.
_Avoid_: Project backup, Account Vault backup, external-chat conversion

**Backup Manifest**:
The versioned public inventory of a Chat Backup's chats, metadata, attachments, workspace identities, and integrity values. Supported older versions migrate as a whole; damaged or unsupported future versions never produce a partial restoration.
_Avoid_: Unversioned archive index, best-effort partial restore

**Chat Attachment**:
An image, document, or other file stored as part of a Chat Session rather than merely referenced from its workspace. Full Chat Backups include available Chat Attachments; missing external attachments remain visible as missing references, while Compressed Context Packages retain only descriptions or extracted results.
_Avoid_: Workspace file, project artifact

**Encrypted Chat Backup**:
A Chat Backup protected by a user-supplied password in a format decryptable on Windows, Linux, and macOS. It is the default backup choice; the password is not retained by Picode and cannot be recovered if lost, while an unencrypted backup requires an explicit choice and warning.
_Avoid_: Account Vault encryption, device-bound backup

**Restore Conflict**:
The condition in which a Chat Backup contains the same session identity as an existing chat but different content. Restoration preserves the existing chat and creates a clearly labeled copy with a new identity; identical content is skipped.
_Avoid_: Silent overwrite, duplicate identical chat

**Compressed Context Package**:
A deliberately lossy, portable representation of selected chats created by a user-selected Pi model. It retains structured goals, decisions, constraints, tasks, significant results, relationships, and recent context using the Memory Journal importance and briefing approach, but cannot restore the full original conversation.
_Avoid_: Chat Backup, lossless archive, file compression

**Compression Review**:
The required confirmation showing which chats will be sent to which provider and model, the estimated input size, and the cross-provider privacy warning before a Compressed Context Package is generated. Known credential and account metadata are removed first, but chat-body secrecy cannot be guaranteed automatically.
_Avoid_: Background compression, implicit data transfer

**Active Credential Projection**:
The single Account Vault credential currently made available to Pi for one provider. Multiple providers may have projections concurrently, but a provider never has more than one.
_Avoid_: Account backup, imported JSON

**Provider Account**:
An authenticated Codex, Claude, Cursor, or API-provider identity that may be shared by multiple Chat Sessions. Exactly one Provider Account may be active for each provider at a time.
_Avoid_: Chat account, global account

**Custom API Provider**:
A manually configured OpenAI-compatible or Anthropic-compatible service, such as DeepSeek or a private gateway, that supplies models to Pi without importing credentials from a local desktop application.
_Avoid_: Imported Agent Configuration, Codex Channel

**Chat Session**:
The durable conversation container of one Pi agent. It may contain sequential Task Runs and survives provider, account, channel, and model changes.
_Avoid_: Account session, model connection

**Imported Chat**:
A Chat Session selectively copied from Codex, Claude, Cursor, or a Picode backup. Its conversation may be viewed immediately, but it cannot execute until its workspace has been bound on the current computer.
_Avoid_: Imported account, automatically resumed task

**Chat Import Review**:
The manually opened view that scans local Codex, Claude, and Cursor histories only on request, groups and filters them by source, workspace, date, and archived state, and begins with no chats selected. Only explicitly selected chats proceed to Workspace Binding and import.
_Avoid_: Startup scan, background indexing, import all by default

**External Chat Snapshot**:
The immutable, best-effort representation of messages and tool results parsed from an imported Codex, Claude, or Cursor conversation. It preserves source provenance without claiming to contain inaccessible provider state.
_Avoid_: Native Pi session, editable imported history

**Continuation Branch**:
A new Pi Chat Session created from an External Chat Snapshot after Workspace Binding. It may continue the visible context while leaving the imported source record unchanged.
_Avoid_: In-place external session conversion, hidden-state restoration

**Workspace Binding**:
The user's confirmed association between an Imported Chat's original workspace identity and an existing directory on the current computer. Every newly imported chat must complete this association once before it may run tools or continue a task.
_Avoid_: Path text replacement, guessed working directory

**Workspace Binding Group**:
The set of selected Imported Chats that share one original workspace identity and therefore receive one Workspace Binding together. A single confirmed directory binds the whole group, with every resulting chat-to-directory association shown for review.
_Avoid_: Per-chat duplicate binding, global binding for unrelated workspaces

**Unbound Workspace**:
The safe state of an Imported Chat whose workspace has not yet been confirmed on the current computer. The chat is readable, but task continuation, tool execution, and file writes are blocked.
_Avoid_: Missing directory fallback, automatically created workspace

**Archived Chat**:
A Chat Session intentionally placed in Picot's archived collection without deleting its conversation. Selective import and backup restoration preserve this state by default.
_Avoid_: Deleted chat, inactive account

**Account Binding**:
The active Provider Account associated with a Chat Session. Provider Account Replacement may hand this association to the replacement account, but that handoff does not resume a Suspended Task Run.
_Avoid_: Stored account, new chat

**Provider Account Replacement**:
The change from one active account to another for the same provider. It stops the old account's connections and related Task Runs, preserves their state, and hands their Chat Session associations to the replacement account without starting execution.
_Avoid_: New login alongside the old account, new chat

**Account Deactivation**:
The act of stopping a Provider Account's connections and associated running tasks while retaining its credential in the Account Vault for later use. It does not alter the source desktop application's login.
_Avoid_: Account deletion, source-app logout

**Account Deletion**:
The confirmed removal of a credential from the Account Vault after deactivating it. Related Chat Sessions and task history remain, and the source desktop application's login is not altered.
_Avoid_: Chat deletion, source-app account removal

**Suspended Task Run**:
A Task Run whose execution has stopped while its goal, plan, context, pending work, and evidence remain durable. It resumes only through explicit continuation.
_Avoid_: Failed task, deleted task, queued retry, interrupted task

**Execution Epoch**:
A continuous portion of a Task Run executed with one fixed Provider Account, channel, and model. Explicit continuation through another account starts a new epoch without creating a new Task Run.
_Avoid_: Live model switching, task restart, task execution snapshot

**Reverse-Proxy Configuration**:
An imported Codex configuration that accesses a compatible proxy through a custom service address, credentials, and model mapping. Import preserves that proxy rather than substituting the official OpenAI service.
_Avoid_: Official OpenAI configuration

**Codex Channel**:
The active route through which Picot accesses Codex models: either official Codex OAuth or a saved reverse-proxy configuration. All Codex-bound Chat Sessions share the active channel, and changing it does not delete the inactive route.
_Avoid_: Codex account, model provider

**Remote Control Extension**:
An optional add-on that lets a phone observe and control a chat running on the computer while agent execution remains local to that computer.
_Avoid_: Mobile agent, cloud agent

**Chat Control Interface**:
The common boundary through which every Picot client lists Chat Sessions, observes their events, sends messages, and stops or continues tasks. The desktop interface and future Remote Control Extension are both clients of this boundary.
_Avoid_: Desktop-only chat path, remote agent API

**Upstream Picot**:
The original Picot project whose ongoing fixes and features Picode intends to incorporate while keeping its own product behavior distinct.
_Avoid_: One-time source snapshot, disposable dependency

**Official Cursor SDK Channel**:
The only executable Picode Cursor route, pinned to `pi-cursor-sdk@0.1.61` and backed by the official Cursor `@cursor/sdk` local Agent. It uses a manually supplied Cursor SDK API key, isolates Cursor state by Pi Chat Session, accepts resume state only on an exact session/workspace/model/tool/store/compaction match, and bootstraps a fresh Cursor Agent from the current Pi transcript when strict resume fails.
_Avoid_: Cursor Desktop OAuth, reverse-engineered Cursor protocol

**Cursor OAuth Backup Record**:
A manually imported Cursor Desktop/CLI OAuth credential retained in the encrypted Account Vault for backup or export. It is never projected into Picode's Pi auth store, cannot be activated for chat, and does not install executable provider code.
_Avoid_: Cursor chat channel, active Cursor account

**Pi Runtime Profile**:
Picode's application-owned Pi configuration, package, authentication, and provider directory. It is separate from standalone Pi's `~/.pi/agent` directory, while its session directory explicitly points to the existing Pi transcript tree so GUI and TUI preserve the same chats without sharing executable package state.
_Avoid_: Standalone Pi configuration, copied chat database

**Picode Compatibility Identifier**:
An internal Picot-era identifier deliberately retained so renaming the product does not move existing sessions, settings, backups, or protected account data.
_Avoid_: Product name, stale branding

### Harness and execution

**Task Run**:
A versioned unit of work inside a Chat Session with its own goal, acceptance conditions, plan, state, and evidence history. One Chat Session has at most one write-capable Task Run active at a time.
_Avoid_: Chat, message, background process

**Task Kind**:
The user-selected execution shape of a new Task Run: Simple Task or Harness Task. It determines the initial workspace, capability, and assurance policy without changing the underlying Pi runtime.
_Avoid_: Model mode, provider type

**Simple Task**:
A Task Run that starts immediately without a user Workspace Binding or Harness Profile and exposes only Pi's core experience through an internal Scratch Space.
_Avoid_: Unconfigured Harness Task, unsafe task

**Simple Development Delivery**:
A user-directed, non-Harness development path for a small work or personal project. It may use an attached workspace, ordinary project tools, Git operations, and independent delivery when explicitly requested, but it does not claim the verification, evidence, isolation, or review guarantees of a Harness Task.
_Avoid_: Unverified code by definition, mandatory engineering process, Harness-lite

**Optional Harness Adoption**:
The user's choice to apply the Engineering Development Loop and a Task Harness to a Task Run. Harness adoption maximizes repeatability and evidence for medium-sized work but is never inferred merely from a workspace, repository, language, or project type.
_Avoid_: Automatic project classification, universal gate, forced ceremony

**Harness Task**:
A workspace-bound Task Run created from a Task Harness for structured project work, with optional Git, evidence, and verification policies that may be overridden at task scope by explicit user strategy.
_Avoid_: Every coding task, mandatory project mode

**Scratch Space**:
The application-owned neutral working area used by a Simple Task when Pi requires a current directory. It is not a user project or portable Workspace Identity.
_Avoid_: Workspace Binding, hidden project folder

**Harness Profile**:
An optional, user-confirmed, project-owned template that names how Harness Tasks for a workspace may build, test, check, generate, and prove completion across supported platforms.
_Avoid_: Universal task requirement, guessed command list, CI copy

**Engineering Development Loop**:
The complete software-development Harness for a medium-sized software or game project: understand the request, inspect the workspace and repository, plan, implement, build, test, debug, review changes, preserve evidence, and prepare a truthful delivery result. It uses external engines, compilers, IDEs, SDKs, and art tools through declared project capabilities rather than replacing them.
_Avoid_: Research workflow, writing workflow, art-production suite, isolated code-generation demo

**Development-only Product Boundary**:
The product scope that keeps Picode centered on software engineering. Research agents, general writing, artistic content creation, built-in CI, autonomous production release, full IDE/engine replacement, default cloud agent pools, and durable personal memory are outside the core even when optional integrations may expose their engineering results.
_Avoid_: General-purpose assistant, creative suite, research platform, CI service

**Task Harness**:
The built-in Harness template instantiated for one Harness Task, optionally refined by a project Harness Profile, together with its task-local overrides and active assurance policy.
_Avoid_: Global profile mutation, Simple Task workflow

**Task Override**:
An explicit user command or Skill-directed change to one Task Harness's workflow, actions, or gates that leaves the project Harness Profile unchanged and remains visible in task history.
_Avoid_: Silent bypass, global profile edit

**Profile Overlay**:
A module, package, or subproject refinement of a workspace's base Harness Profile that activates only for work within its declared scope.
_Avoid_: Duplicate project profile, chat-specific profile

**Harness Action**:
A stable, parameterized operation declared by a Harness Profile with explicit applicability, authorization, success, evidence, and platform semantics.
_Avoid_: Shell snippet, guessed command

**Completion Gate**:
A Harness Action or structured condition active in a Task Harness that must pass before that Harness Task may receive its corresponding verified label.
_Avoid_: Agent confidence, optional check

**Red-capable Gate**:
A Completion Gate whose predicate and execution path have demonstrated that they can detect and report a relevant invalid, regressed, or incomplete state. A green run proves only the current candidate; it never proves Gate validity by itself.
_Avoid_: Green means valid, command ran, nonzero-only check

**Gate Validity Check**:
The separate review or controlled negative test that proves a Completion Gate is Red-capable. It is required when a Gate is introduced or materially changed and is retained as Gate evidence, distinct from ordinary candidate verification.
_Avoid_: Ordinary test run, success result, CI approval

**Gate Cross-Validation**:
An explicitly enabled, model-assisted adversarial review that tests a Gate's green path and controlled red path in an isolated validation context. The selected model may design negative fixtures, observe structured results, and report bypasses or false claims, but the deterministic Gate Runner remains authoritative and the model cannot silently change the Gate or certify it alone.
_Avoid_: Model confidence, automatic Gate approval, mutation of the user workspace

**Developer Agent Role**:
The Picode role responsible for understanding and implementing a change in a developer workspace, designing and running change-appropriate local gates, preserving evidence, and preparing a reviewable delivery candidate. It does not replace the dedicated CI server, main-branch reviewer, or authorized committer.
_Avoid_: CI executor, merge authority, release publisher

**Developer-local Gate**:
A change-scoped build, test, diagnostic, packaging, or smoke check designed and run by the Developer Agent before handoff. It proves the developer's evidence baseline and does not imply CI approval, main-branch review, merge authorization, or release readiness.
_Avoid_: CI result, project-wide certification, reviewer approval

**Developer Runtime Diagnostics**:
The on-demand debugging and runtime-observation capability used by a Developer Agent: target launch or attach, breakpoints, stacks, threads, variables, exceptions, structured logs, crash dumps, and external profiler traces through DAP or project-specific adapters.
_Avoid_: Built-in IDE replacement, source-only inspection, CI certification

**Developer Preflight**:
The fast, local environment and Gate checks performed by a Developer Agent before handoff. It provides feedback and evidence for the current workspace but cannot certify the project independently of CI.
_Avoid_: Local CI, final certification, authoritative build

**CI Authority**:
The controlled CI environment and policy that independently executes the project's authoritative Gates, with pinned toolchains, clean or declared state, platform variants, and retained results/artifacts. A CI result may certify project Gates according to project policy, not according to Picode's local confidence.
_Avoid_: Picode local run, developer approval, main-branch review

**CI Handoff**:
The developer's submission of a change reference, Gate definitions, environment expectations, and local evidence to a configured CI Authority, followed by retrieval of the CI run, logs, artifacts, and Gate verdicts.
_Avoid_: Automatic merge, local test replay, CI server implementation

**Developer Handoff Package**:
The versioned, reviewable delivery record for a Harness Task: goal and acceptance conditions, owned diff and branch/worktree, Gate definitions and green results, Red-capable evidence, Developer Preflight, CI Handoff results, environment fingerprint, known failures, risks, unresolved items, and Artifact references. It is evidence for review, not review approval or merge authorization.
_Avoid_: Chat summary, CI replacement, automatic merge request approval

**Issue Binding**:
The explicit association between a Task Run and an external requirement or issue record. It preserves the imported requirement version and identity, while updates back to the external tracker require user-authorized Issue capability actions.
_Avoid_: Chat title as requirement, silent issue mutation, mandatory project-management service

**Engineering Documentation and Contract**:
The code-adjacent project facts Picode may maintain and validate: API/configuration/data schemas, interface contracts, migration notes, architecture decisions, change notes, and command/version documentation. It is part of software development evidence and is not a general writing workflow.
_Avoid_: Creative writing, marketing copy, documentation aesthetics, independent prose task

**Platform Validation Matrix**:
The declared set of target operating systems, architectures, build configurations, device classes, and minimum versions for a project, with independent Gate and Artifact status for each target. An unexercised target is not implicitly passed by another target's result.
_Avoid_: Current developer machine, universal build claim, path translation guess

**Module Resource Budget**:
The declared resident and active resource expectations, dependencies, permissions, concurrency, background behavior, and release policy for a capability module, together with observed Runtime Monitor measurements. A budget limits new work or prompts the user when exceeded; it does not silently terminate an active task.
_Avoid_: Startup memory promise, hidden auto-kill, exact resource guarantee

**Game Content Pipeline Validation**:
The optional, third-tier engine adapter capability that validates code-to-content relationships and engine resource processing—references, GUIDs, serialization, import settings, scenes, Prefabs/Blueprints, generated data, Cook/package output, and runtime loading—without authoring or judging artistic content.
_Avoid_: Art tool, asset authoring suite, aesthetic review, built-in game engine

**Security and Supply-chain Validation Module**:
The optional, third-tier analysis capability for secret scanning, dependency vulnerability and provenance checks, license/NOTICE policy, SAST, compiler security diagnostics, SBOM generation, and structured security reports. It does not replace the always-enforced Secret Reference, redaction, permission, or credential boundaries.
_Avoid_: Optional secret protection, CI server, automatic external upload

**Verification Baseline**:
A comparable pre-change result tied to a code state, Harness Profile fingerprint, platform, and environment. It distinguishes existing failures from regressions.
_Avoid_: Old log, assumed project health

**Known Failure**:
A user-confirmed or baseline-proven failure that predates the current Task Run and has not worsened.
_Avoid_: Failure dismissed by model judgment, ignored regression

**Evidence Ledger**:
The append-only record linking a Task Run's changes, Harness Actions, attempts, outcomes, baselines, and retained artifacts.
_Avoid_: Chat summary, success claim

**Evidence Artifact**:
The content-addressed full output or generated evidence retained outside the bounded chat preview and referenced by the Evidence Ledger.
_Avoid_: Workspace file, chat attachment, inline log

### Workspace safety

**Workspace Identity**:
A portable identity for one project that is resolved to a user-confirmed directory on each computer rather than equated with an operating-system path.
_Avoid_: Absolute path, current directory

**Write Lease**:
The exclusive right of one Harness Task using managed concurrency to modify one physical working directory. It is not imposed on Simple Tasks or direct workflows unless the user enables that policy.
_Avoid_: Workspace ownership, account lock

**Safe Worktree**:
A Git Worktree and branch dedicated to one concurrent Harness Task when its active Task Harness selects Git-managed isolation.
_Avoid_: Shared checkout, automatic main-branch merge

### Agent routing and observability

**Agent Run**:
One live or historical execution of a main Agent or Subagent within a Task Run, identified separately from its operating-system process and carrying its own model, lifecycle, usage, and parent relationship.
_Avoid_: Process, Chat Session, Task Run

**Runtime Instance**:
The concrete runtime identity that carries one Agent Run's ordered lifecycle events. Reconnection, process replacement, or explicit continuation through another account creates a new Runtime Instance linked to the preceding Agent Run while preserving the Task Run and Chat Session.
_Avoid_: Chat Session, operating-system process, reused account session

**Runtime Lifecycle**:
The single authority that normalizes source-specific runtime events, persists their order, applies lifecycle transitions, and coordinates idempotent projections for one Runtime Instance. It does not own conversation content, task definitions, tool implementations, or extension code.
_Avoid_: Global event bus, transcript store, main.rs observer

**Lifecycle Event**:
A bounded semantic fact that can change Runtime Instance state, such as Agent start, Tool start or finish, completion evaluation, compaction, cancellation, or disconnect. Token deltas, reasoning deltas, and raw terminal chunks are streaming data rather than Lifecycle Events.
_Avoid_: Every RPC frame, full tool output, chat message body

**Runtime Projection**:
An idempotent application of a committed Lifecycle Event to a specialized module such as Task Control, Work Manager, Context Engine, or Completion Coordinator. Projection checkpoints make incomplete application replayable without treating the specialized module as a second lifecycle authority.
_Avoid_: Duplicate event interpretation, untracked callback, extension side effect

**Reconciling Runtime**:
A Runtime Instance whose Lifecycle Event was durably accepted but whose required projections have not all completed. It cannot claim terminal completion until replay finishes or the unresolved failure is explicitly surfaced.
_Avoid_: Completed with warning, silently dropped event, failed Task Run

**Runtime Intent**:
A validated request submitted to Runtime Lifecycle by a client or extension, such as cancel, continue, or report external work completion. Extensions observe Lifecycle Events but cannot directly forge authoritative transitions.
_Avoid_: Writable event subscription, raw extension event, permission bypass

**Subagent Model Policy**:
The user's configuration of which models are eligible for qualified Subagent work and what happens when a selected model is unavailable. It provides candidates after delegation is justified; it does not cause delegation by itself.
_Avoid_: Automatic downgrade, cheapest-model switch

**Delegation Eligibility**:
The recorded determination that a proposed unit of work is sufficiently simple, bounded, independent, low-risk, and verifiable for Subagent delegation under its configured model policy.
_Avoid_: Model price, task title, Agent confidence

**Runtime Monitor**:
The local operational view of active and recent Agent Runs, their relationships, lifecycle and waiting states, resource and model usage, and health assessment.
_Avoid_: Chat list, cost dashboard, process list

**Suspected Stall**:
A reversible Agent Run health assessment indicating that expected progress signals are overdue and no known wait state explains the delay. It is not proof of failure and does not itself authorize termination.
_Avoid_: Low CPU, long-running task, failed task

### Secrets and capabilities

**Secret Reference**:
A durable locator for a user-owned secret source, such as an operating-system credential entry, environment variable, or selected file. Picode retains the locator but not the resolved secret value.
_Avoid_: Saved plaintext, chat credential, copied password file

**Capability Catalog**:
The lightweight local index through which an Agent discovers non-core tools without loading their complete schemas or implementations.
_Avoid_: Always-loaded tool list, extension process registry

**Complete Capability, Lazy Residency**:
The product principle that Picode must provide the development capabilities required by its target workflow while loading tool schemas, implementations, worker processes, kernels, browsers, and other runtime resources only when the active task enables or uses them.
_Avoid_: Tool count minimization, permanently resident tool suite

**Developer Core Capability Set**:
The lightweight, always-discoverable capabilities shared by development tasks: file enumeration/search/read, version-aware edit/patch/write, persistent and cancellable Shell with managed jobs, Git status/diff/history/baseline inspection, durable plan and todo state, bounded output with full artifacts, and Agent/job monitoring and stop control. Individual implementations may still load lazily.
_Avoid_: Every installed development extension, permanently running tool processes

**Resident Core**:
The first capability tier: lightweight core schemas and control-plane behavior that every applicable task can use without enabling an extension. Resident Core does not imply that heavyweight implementations or child processes remain running.
_Avoid_: All tools loaded at startup, all development modules

**Discoverable Lazy Capability**:
The second capability tier: a user-enabled capability represented to the Agent by a lightweight manifest and searchable schema, with its complete implementation, dependencies, and runtime resources loaded only when invoked.
_Avoid_: Resident extension, hidden capability, automatic process startup

**Disabled User Module**:
The third capability tier: an installed or available module that appears in settings but is absent from the Agent's capability catalog until the user explicitly enables it. Enabling moves it to Discoverable Lazy Capability; it still does not load the implementation until invocation.
_Avoid_: Missing feature, model-visible by default, enabled means resident

**Global Extension**:
A user-enabled capability available for discovery by Harness Tasks and by Simple Tasks that explicitly opt into extension discovery, while its implementation remains unloaded until selected.
_Avoid_: Core tool, always-running plugin

**Task Extension**:
A capability explicitly bound to one Task Run and restored with that task's durable state while its implementation remains unloaded until selected.
_Avoid_: Global extension, embedded task code

**Capability Source Ladder**:
The required search order for filling a missing Picode capability: compatible Pi ecosystem extension, equivalent Oh My Pi mechanism, comparable open-source agent implementation, and only then a Picode-specific implementation.
_Avoid_: Greenfield first, vendor copying

**Capability Source Review**:
The durable record of which Source Ladder candidates were examined and why one was reused, adapted, referenced, or rejected.
_Avoid_: Informal search notes, undocumented code borrowing

**Firstmate Crew Orchestrator**:
The optional third-tier external component based on `kunchenguid/firstmate` that can supervise visible agent crews in isolated Git worktrees. It is invoked through an explicit Picode adapter with its own `FM_HOME`, resource budget, backend, and merge authority; it is not a Pi conversation runtime, a Resident Core service, or an automatic merge/push mechanism.
_Avoid_: Bundled firstmate distro, automatic installation, hidden worker pool, unverified PR treated as Harness completion

**Per-capability Source Gate**:
The implementation-readiness check requiring a capability-specific Source Review before coding: record the Pi extension search, the OMP comparison, the comparable open-source agent search, and the reason a clean-room Picode implementation is necessary if earlier rungs do not fit.
_Avoid_: Generic source list, post-hoc attribution, greenfield-first implementation

**Explicit Skill Invocation**:
The user's deliberate selection of an imported Skill for a particular Task Run. Merely installing, importing, discovering, or suggesting a Skill is not an invocation.
_Avoid_: Automatic skill match, installed skill

**Skill Workflow Override**:
The task-scoped precedence given to an Explicit Skill Invocation over Picode's default work method and, for a Harness Task, over its Task Harness. It remains bounded only by the capabilities and enforcement of the underlying APIs and explicitly accepted user permissions.
_Avoid_: Global policy replacement, silent profile mutation

**Task Experience**:
The single public task/session interface shared by Picode desktop and headless clients. It coordinates Task Control mutations with bounded canonical Session Events while leaving full conversation bodies in Pi.
_Avoid_: Second agent runtime, duplicated transcript database, UI-only task API

**Guidance Policy**:
The small deterministic policy that chooses Lean, Structured, or Guided assistance from user choice, task signals, and evaluated model reliability. It never changes Assurance or authorization requirements.
_Avoid_: Mandatory prompt harness, model capability guess, Gate bypass

**Rewind Preview**:
A fresh, exact-confirmation description of the effective session events or Git-backed workspace changes that a rewind would hide or restore. Application appends a compensating event and preserves the audit journal.
_Avoid_: Destructive history truncation, implicit file rollback, Git history rewrite

**Delegation Contract**:
The bounded child-work envelope containing objective, scope, required output, acceptance checks, stop conditions, effective tools, permissions, isolation, and mandatory parent review.
_Avoid_: Free-form child prompt, inherited unlimited authority, child self-acceptance

**Effective Capability Report**:
A read-only task diagnostic showing the actual Resident Core, catalog visibility, task bindings, loaded state, prompt visibility, and rule/Skill/override provenance without loading tools.
_Avoid_: Settings wish list, capability activation, resident inventory only

**Extension Manager**:
The sole authoritative inventory and lifecycle source for Skills, Hooks, MCP, LSP, DAP, Firstmate, and native extension components. Discovery adapters may publish facts into it, while other catalogs and the GUI are read-only projections.
_Avoid_: Per-component lifecycle database, GUI-merged state, process owner

**Extension Four-State Lifecycle**:
The ordered component projection Discovered, Enabled, Trusted, and Running. Enabled makes a component discoverable without starting it; Trusted records reviewed provenance without adding permissions; Running requires an owned Work Handle.
_Avoid_: Enabled means resident, trust means unrestricted, configured means running

**Extension Manifest v2**:
The reviewed component record containing source and immutable pin/hash, version, license, platforms, component types, declared permissions, health check, and resource limits.
_Avoid_: Executable path only, floating remote branch, trust flag as permission

**Extension Process Adapter**:
The Work Manager boundary through which Hook, MCP, LSP, DAP, and native extension work receives one component identity, owner, status, cancellation, timeout, crash result, and bounded output.
_Avoid_: Adapter-owned process table, raw child process in the GUI, unowned background worker

### Client surfaces and conversation control

**Managed Client**:
A Picode GUI, TUI, headless, or authenticated remote participant that uses the shared Picode Core interfaces and never owns a private copy of authoritative account, extension, Task, Work, runtime, or chat-control state.
_Avoid_: Separate frontend backend, independent agent app, synced client database

**Unmanaged Pi Client**:
A raw Pi process started outside Picode's managed client workflow. It retains ordinary Pi behavior but is not promised Picode account-vault, extension-lifecycle, Task, Work, or Conversation Control parity.
_Avoid_: Picode TUI, fallback Picode client

**Conversation Controller**:
The sole Managed Client generation currently authorized to mutate one Chat Session. Control is a user-input authority and does not make the client the owner of the Agent Run or transcript.
_Avoid_: Chat owner, process owner, active window

**Observer Client**:
A Managed Client following one Chat Session without mutation authority. It receives ordered state and output and may request control when the Conversation Control policy permits.
_Avoid_: Disconnected client, stale controller, read replica

**Conversation Control Lease**:
The revocable, generation-fenced authority granted to one Conversation Controller. A healthy or meaningfully active controller cannot be displaced; an unresponsive controller becomes replaceable only at a safe runtime state.
_Avoid_: Workspace Write Lease, account lock, permanent chat ownership

**Meaningful Background Activity**:
Observable Agent, tool, or managed Work progress that retains Conversation Control after its client surface is no longer foreground. Process existence alone is not activity, and waiting for user input is a takeover-safe blocked state.
_Avoid_: Any running process, open window, elapsed time

**Managed TUI**:
The terminal Client Adapter that uses Picode Core interfaces and therefore shares Chat, account, extension, Task, Work, runtime, and Conversation Control state with the GUI.
_Avoid_: Raw Pi TUI, headless JSON client, terminal emulator

**TUI Host**:
Optional terminal infrastructure that arranges, persists, detaches, and reattaches Managed TUI processes without owning Picode workflow state. Herdr is the default reviewed TUI Host when explicitly installed and trusted.
_Avoid_: Agent runtime, session authority, Picode Core
