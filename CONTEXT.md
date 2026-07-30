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
The Picode Cursor route backed by the official Cursor `@cursor/sdk` through the `pi-cursor-sdk` Pi provider. It uses a manually supplied Cursor SDK API key and keeps Cursor's local agent loop, model catalog, and tool behavior inside Pi.
_Avoid_: Cursor Desktop OAuth, reverse-engineered Cursor protocol

**Experimental Cursor OAuth Channel**:
A separately activated, manually imported Cursor Desktop/CLI OAuth route that depends on an unofficial Pi extension and reverse-engineered protocol details. It is mutually exclusive with the Official Cursor SDK Channel for the `cursor` provider.
_Avoid_: Automatic Cursor login reuse, official Cursor SDK authentication

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

**Harness Task**:
A workspace-bound Task Run created from a Task Harness for structured project work, with optional Git, evidence, and verification policies that may be overridden at task scope by explicit user strategy.
_Avoid_: Every coding task, mandatory project mode

**Scratch Space**:
The application-owned neutral working area used by a Simple Task when Pi requires a current directory. It is not a user project or portable Workspace Identity.
_Avoid_: Workspace Binding, hidden project folder

**Harness Profile**:
An optional, user-confirmed, project-owned template that names how Harness Tasks for a workspace may build, test, check, generate, and prove completion across supported platforms.
_Avoid_: Universal task requirement, guessed command list, CI copy

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

**Explicit Skill Invocation**:
The user's deliberate selection of an imported Skill for a particular Task Run. Merely installing, importing, discovering, or suggesting a Skill is not an invocation.
_Avoid_: Automatic skill match, installed skill

**Skill Workflow Override**:
The task-scoped precedence given to an Explicit Skill Invocation over Picode's default work method and, for a Harness Task, over its Task Harness. It remains bounded only by the capabilities and enforcement of the underlying APIs and explicitly accepted user permissions.
_Avoid_: Global policy replacement, silent profile mutation
