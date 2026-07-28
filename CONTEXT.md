# Picot Next

Picot Next is a desktop interface for working with Pi agents. It preserves Picot's interaction model while making localization, external account access, and responsive desktop use first-class product concerns.

## Language

**Language Pack**:
A selectable collection of all user-facing Picot text for one language. English and Simplified Chinese are built in, and additional user-installed packs may be selected without rebuilding the application.
_Avoid_: Translation file, skin

**Language Fallback**:
The use of built-in English for a text key missing from the selected Language Pack. An invalid pack is rejected as a whole, leaving the last valid language active.
_Avoid_: Blank text, partial pack activation

**Interface Language**:
The selected Language Pack applied live to Picot's own controls, menus, statuses, and built-in notices across every open window. It does not translate conversation content, model responses, tool output, or files.
_Avoid_: Conversation language, response translation

**Effects Mode**:
The user's choice between Picot's full visual effects and a reduced-effects presentation that removes measured sources of rendering delay without changing layout or interaction.
_Avoid_: Low-quality mode, different theme

**Imported Agent Configuration**:
A user-approved copy of provider access settings discovered from a local Codex, Claude, or Cursor installation. Pi uses the imported access independently; Picot Next does not control the source application's process or active conversations.
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
Picot Next's protected collection of normalized Codex, Claude, and Cursor accounts. It retains multiple credentials without retaining the source JSON documents from which they were imported.
_Avoid_: JSON archive, Pi auth file

**Ephemeral Credential**:
A credential available only for the current application run when the operating system's protected credential storage is unavailable. It disappears when Picot Next closes and is never written to disk as plain text.
_Avoid_: Unencrypted saved account, temporary file

**Settings Export**:
A portable copy of language, interface, provider address, model, and other non-secret preferences. It never contains Account Vault credentials, OAuth tokens, or API keys.
_Avoid_: Account backup, credential export

**Chat Backup**:
A portable, lossless archive of selected Picot Next conversations, branches, task state, organization metadata, source provenance, workspace identities, and non-secret model metadata. It excludes credentials and all files contained in the associated workspaces.
_Avoid_: Project backup, Account Vault backup, external-chat conversion

**Backup Manifest**:
The versioned public inventory of a Chat Backup's chats, metadata, attachments, workspace identities, and integrity values. Supported older versions migrate as a whole; damaged or unsupported future versions never produce a partial restoration.
_Avoid_: Unversioned archive index, best-effort partial restore

**Chat Attachment**:
An image, document, or other file stored as part of a Chat Session rather than merely referenced from its workspace. Full Chat Backups include available Chat Attachments; missing external attachments remain visible as missing references, while Compressed Context Packages retain only descriptions or extracted results.
_Avoid_: Workspace file, project artifact

**Encrypted Chat Backup**:
A Chat Backup protected by a user-supplied password in a format decryptable on Windows, Linux, and macOS. It is the default backup choice; the password is not retained by Picot Next and cannot be recovered if lost, while an unencrypted backup requires an explicit choice and warning.
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
The durable conversation context and task state of one Pi agent. A Chat Session is independent of the account used to make model requests and survives account or channel changes.
_Avoid_: Account session, model connection

**Imported Chat**:
A Chat Session selectively copied from Codex, Claude, Cursor, or a Picot Next backup. Its conversation may be viewed immediately, but it cannot execute until its workspace has been bound on the current computer.
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
The active Provider Account a Chat Session uses for model requests. Multiple Chat Sessions may share a binding, while sessions using other providers continue independently.
_Avoid_: Stored account, new chat

**Provider Account Replacement**:
The change from one active account to another for the same provider. It stops the old account's connections and running tasks, preserves every affected Chat Session, and automatically rebinds those sessions to the replacement account.
_Avoid_: New login alongside the old account, new chat

**Account Deactivation**:
The act of stopping a Provider Account's connections and associated running tasks while retaining its credential in the Account Vault for later use. It does not alter the source desktop application's login.
_Avoid_: Account deletion, source-app logout

**Account Deletion**:
The confirmed removal of a credential from the Account Vault after deactivating it. Related Chat Sessions and task history remain, and the source desktop application's login is not altered.
_Avoid_: Chat deletion, source-app account removal

**Interrupted Task**:
A task stopped by account change, application shutdown, crash, or computer restart but retained in its Chat Session. It does not retry automatically; the user resumes only the most recent interrupted task in the current session by entering the localized continuation command or using its equivalent action.
_Avoid_: Failed task, deleted task, queued retry

**Task Execution Snapshot**:
The Provider Account, channel, and model fixed when a task begins. Later selector changes affect only the next user request and never alter a task already running.
_Avoid_: Live model switching, mutable running task

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
The original Picot project whose ongoing fixes and features Picot Next intends to incorporate while keeping its own product behavior distinct.
_Avoid_: One-time source snapshot, disposable dependency
