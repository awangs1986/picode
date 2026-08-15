# Account, Chat Import, and Cursor Continuity

> Status: P0–P3 implemented on Windows (2026-08-09); P4 deferred.
> Authority rule: imported credentials belong to Account Vault, imported chat facts belong to Store/Pi sessions, and live Cursor continuity belongs to `pi-cursor-sdk`. The Web Wizard owns no durable state.

Vault logout is intentionally separate from upstream Pi `/logout`: `/pico-logout`
and `picode account logout --account <id>` clear the Vault credential and retire the
account while preserving imported chats and Cursor continuity metadata. If the account
was active, the Adapter Extension unregisters its live Pi Provider immediately.

## Delivery slices

| Slice | Delivered contract | Evidence |
|---|---|---|
| P0 | `/pico-import` starts an authenticated, temporary loopback Web Wizard while Pi `/import` remains entirely native. The Wizard can scan local Codex/Claude/Cursor account material, preview uploaded JSON, import several accounts atomically, preserve incompatible accounts as backup-only, and explicitly activate at most one compatible account per provider. | `account-source-scanner.test.ts`, `account-import-wizard.test.ts`, `pi-bridge.test.ts`, `picode-launch.test.js`, package smoke |
| P1 | The same Wizard scans user-selected chat files/directories by reading only bounded head/tail metadata, shows title/last dialog/time/size/archive state, filters archive state, sorts by time/size, removes exact duplicates, and requires a current local workspace binding per original workspace group before selective import. Reasoning import is opt-in and remains folded. | `chat-import-catalog.test.ts`, `web-chat-import.test.ts` |
| P2 | Picode pins and loads `pi-cursor-sdk@0.1.61`. Its official `@cursor/sdk` local Agent owns Cursor agent IDs, a per-Pi-session state directory, store identity, branch/compaction lineage, and the resume ledger. Picode does not create a competing Cursor ledger. | `cursor-resume-contract.test.js`, launcher/package smoke |
| P3 | Cursor sends bootstrap from the current Pi transcript on first use, on process resume, after bounded incremental sends, or when context identity diverges. A matching SDK checkpoint is resumed; a missing/stale/failed checkpoint creates a new Cursor Agent, emits an honest continuity notice, and bootstraps again from the current Pi transcript. Imported foreign chats are materialized as Pi sessions with a task binding and immutable import metadata. | `cursor-resume-contract.test.js`, `pi-bridge.test.ts`, interrupted Agent Loop test |
| P4 | Compression interaction, cross-client live recovery, and long-session pressure/load measurement. | **Not started by this change.** No release claim may infer these results from P0–P3 unit tests. |

## Deliberate boundaries

- Cursor Desktop/CLI OAuth discovered on disk is importable for backup, but is not marked chat-compatible. Live Cursor chat requires the Cursor SDK credential path.
- Chat import auto-discovers the current user's supported Codex/Cursor/Claude JSONL roots and pre-fills an editable path. Product-owned Picode/Pi login stores are excluded from external account discovery.
- Import never silently replaces an active account. Activation is a separate explicit radio selection; importing a new official Codex identity can preserve an existing reverse-proxy account disabled rather than delete it.
- Chat scanning does not parse an entire large transcript. Full parsing occurs only for the conversations selected for import.
- Tool logs, environment records, and reasoning do not become titles or snippets. Reasoning is omitted by default and folded when explicitly imported.
- Workspace paths from another operating system are descriptive only. A selected chat cannot become executable work until the user binds its workspace group to an existing local directory.
- The temporary loopback token is one-use, credentials are never placed in a URL, responses disable caching, and the server closes on success, cancellation, or timeout.

## Remaining acceptance work

P4 must exercise a real Cursor account and long transcript. It must verify compaction boundaries, process interruption, branch/fork identity, recovery after a deliberately invalid SDK checkpoint, bounded memory/state growth, and that two Pi sessions never share a Cursor store directory. Those results must be reported separately as live evidence, not as an automated seam pass.
