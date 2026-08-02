# P0–P4: Unified GUI/TUI Workflow, Conversation Control, and Herdr

Status: accepted for implementation on 2026-08-02.

This document is the implementation compass for the work agreed with the user. Every phase must reread this file before it is declared complete. A phase is complete only when its stated observable outcome and red/green checks pass; implementation shape alone is not completion.

## Product outcome

Picode GUI, the managed `picode-tui` client, and future authenticated remote clients use the same Picode Core state and workflow. They share accounts, providers, model choices, Pi packages, managed extensions, Tasks, Harness state, Work, runtime observations, and Chat Sessions. A raw `pi` process started outside Picode remains an unmanaged Pi workflow and is not promised this parity.

Herdr is an optional, user-approved TUI host. It owns terminal layout, panes, detach/reattach, and terminal process persistence; it never becomes an account, extension, Task, Work, runtime-lifecycle, or transcript authority.

## Non-negotiable invariants

1. Picode Core modules remain the sole authorities for their current facts: Account Vault, Extension Manager, Task Experience, Work Manager, Runtime Lifecycle, and Session Kernel. Client adapters hold projections only.
2. Pi JSONL remains the canonical full conversation body. Picode Session Kernel stores bounded semantic events and ownership facts, not a duplicate transcript.
3. One Chat Session has at most one Conversation Controller generation with write authority. Any number of Observer Clients may read and follow events.
4. Every mutation carries a stable client identity, a unique request ID, and—when scoped to a chat—the current fencing generation. Stale generations and duplicate request IDs cannot produce a second write.
5. A healthy controller cannot be displaced. An unresponsive controller can be displaced only when its Agent Run is idle, waiting for user input, terminal, or a surfaced Suspected Stall. Meaningful background progress prevents takeover.
6. Losing control never cancels a live Agent Run automatically. Account continuation and Task continuation retain their existing explicit-user semantics.
7. Enabled is not Running; Trusted does not expand declared permissions. Herdr and all optional extensions preserve the Extension Four-State Lifecycle.
8. Disabled or declined Herdr has zero process, zero port, zero network, and zero model visibility.
9. Secrets remain inside Account Vault or Pi's protected provider materialization. Clients receive summaries and opaque identities, never plaintext credentials.
10. Cross-platform paths are data, not identity. Chat, Task, and workspace identity continue to use existing portable identities and confirmed bindings.

## Confirmed test seams

The user has confirmed the behavior and these test seams:

- **Client Gateway interface**: connect/register, obtain a bounded shared snapshot, submit a command, and consume ordered events. Desktop, TUI, and test adapters use the same interface.
- **Conversation Control interface**: observe, claim, renew/probe, release, and authorize a mutation. Its result is observable without querying its storage implementation.
- **Managed TUI interface**: initialize from Client Gateway, render shared state, select a Chat Session, and submit only after Conversation Control grants authority.
- **Herdr Installer interface**: inspect, decide, install-and-trust, decline, health-check, launch lazily, and remove/rollback. Tests inject download and process adapters.

Tests must be vertical red → green slices through these interfaces. They must not assert private maps, raw SQLite rows, or helper calls.

## Capability Source Reviews

### Shared GUI/TUI workflow

- **Pi ecosystem**: Pi 0.83 already owns the Agent loop, native JSONL, packages, Skills, and TUI/RPC modes. It does not own Picode Account Vault, Task/Harness, Work, managed-extension, or cross-client state. Reuse Pi runtime and formats; do not fork its Agent implementation.
- **Oh My Pi**: OMP demonstrates a broad integrated terminal runtime, but adopting its runtime or TUI would replace Pi behavior, duplicate Picode modules, and violate the lightweight target. No OMP code is copied.
- **Comparable agent**: grok-build's ACP/headless design demonstrates multiple clients over one session/runtime interface. Picode already has ACP, Broker, Task Experience, and Runtime Lifecycle, so the smallest path is to deepen those existing modules rather than create another runtime.
- **Decision**: clean-room Picode Client Gateway plus a thin managed Rust TUI adapter.

### Single-writer Conversation Control

- **Pi ecosystem**: Pi guarantees one active session per Pi process but does not arbitrate multiple Picode GUI/TUI/mobile writers targeting the same session.
- **Oh My Pi**: process/session ownership does not provide Picode's user-approved health-based takeover semantics or Account/Task continuation rules.
- **Comparable agents/protocols**: ACP request identity helps retries but does not define this local-controller policy. Standard lease generations, fencing tokens, monotonic deadlines, and idempotency supply the required concurrency primitive without importing another agent runtime.
- **Decision**: implement a Picode-specific deep Conversation Control module and keep transport-specific liveness probes in adapters.

### Herdr TUI host

- **Pi ecosystem**: Herdr provides an official Pi integration and persistent agent-aware terminal panes. During implementation the upstream project had moved to `herdrdev/herdr` and relicensed to Apache-2.0. Linux/macOS use pinned stable `v0.7.5` assets and tag Commit `ef4c23f5775bb8cfec05f05d0844226ff959a07a`; native Windows remains preview-only and uses pinned Build `2026-07-29-44b3adb12552`, Commit `44b3adb125524ea9a55739eee3776f922f2115ad`, and the SHA-256 published in the official preview manifest.
- **Oh My Pi**: OMP is an agent runtime, not a terminal-multiplexer substitute. It is not used for this capability.
- **Comparable tools**: tmux supplies persistence but lacks the agent lifecycle/session integration required for the intended workflow.
- **Decision**: integrate the official Herdr executable as an optional external Manifest v2 component. Do not copy or statically link Herdr code. Pin release metadata and integrity, install per-user after explicit approval, and use a Picode lifecycle adapter for `picode-tui` panes.

## P0 — Shared Core contract

Outcome: every surface can describe itself to the existing Broker composition and retrieve one bounded, secret-free snapshot from the authoritative modules.

- Add durable client identity and surface (`gui`, `tui`, `headless`, `remote`) to control envelopes.
- Deepen the existing Broker/Task Experience composition into the Client Gateway interface instead of creating another state store.
- Add a shared-state snapshot containing protocol version, accounts summaries, Tasks, extensions, Work, and runtime summaries.
- Add extension surface compatibility metadata with safe legacy defaults.
- Preserve local-only authorization for sensitive native mutations.
- Document domain terms and the architectural decision.

P0 Gate:

- GUI and TUI test adapters receive the same authoritative snapshot.
- Snapshot serialization contains no credentials or secret values.
- Unknown surface/protocol versions fail explicitly.
- No optional extension process starts while producing a snapshot.

## P1 — Managed TUI workflow parity

Outcome: `picode-tui` is a thin client of Client Gateway and can continue a Picode workflow without a second state machine.

- Add a Rust `picode-tui` binary that connects to the Broker using an explicit port or the published local locator. When no healthy Core exists, the managed TUI starts the sibling Picode executable in background-only mode, waits for Core and Pi readiness, and coordinates concurrent launchers through one app-data startup lock; a later GUI launch reuses that Core.
- Provide chat/session selection, account/model/Task/extension/Work views, prompt submission, cancel/continue, archive/fork, and a typed control-command palette.
- Keep full tool/runtime behavior in embedded Pi and existing Picode modules.
- Expose the same Client Gateway commands to frontend `WsTransport` and TUI.
- Display unsupported GUI-only presentation explicitly while preserving its underlying runtime capability.

P1 Gate:

- A GUI-created Chat/Task appears in TUI with the same identity and bounded state.
- Account, provider, model, extension, and Work summaries match.
- TUI never reads Account Vault files and receives no plaintext secret.
- Raw unmanaged `pi` remains usable and is clearly outside the parity guarantee.

## P2 — Conversation Controller and safe takeover

Outcome: one writer, many observers, deterministic health-based takeover across all clients.

States: `Unowned`, `OwnedIdle`, `OwnedActive`, `Suspect`, `OrphanedActive`, and `TakeoverAvailable`.

- Selecting an unowned chat claims it. Selecting an owned chat observes it.
- Focusing/typing attempts a claim; unsent text remains a local draft until granted.
- Healthy or meaningfully active controllers cannot be displaced.
- Explicit disconnect releases idle control immediately. Ambiguous loss enters Suspect and requires a failed challenge/deadline.
- If the controller disappears during meaningful Agent progress, observers wait. Idle, waiting-user, terminal, or surfaced-stall state permits takeover.
- Switching away releases an idle chat; an active background run retains its controller until terminal/blocked and then releases if no longer selected.
- Every successful claim increments a fencing generation. Recovered stale clients become observers.
- All prompt, continue, cancel, rewind, account/model changes, rename, archive, and delete mutations require authorization. Read, copy, backup, and fork-to-a-new-chat remain non-mutating to the original.
- Request IDs are durable enough to reject duplicate mutation delivery across reconnect/retry.

P2 Gate:

- Concurrent claims elect exactly one controller.
- Stale fencing tokens and duplicate request IDs produce no write.
- Healthy/background-active control cannot be stolen.
- Failed client plus idle/blocked/stalled runtime can be taken over.
- Failed client plus progressing runtime waits and grants after the safe transition.
- Core restart invalidates volatile leases without losing conversation or Task state.

## P3 — Herdr first-run installation

Outcome: first managed TUI use offers Herdr, installs only after informed approval, and always has a single-session fallback.

- On first interactive `picode-tui` launch, inspect Herdr state.
- If absent and no decision exists, offer localized `Install and trust`, `Not now`, and `Details` choices.
- Details show source, pinned version, license, platform status, permissions, install path, and integrity method.
- Approval downloads a pinned release asset through an injected downloader, verifies SHA-256, stages atomically, registers Manifest v2, enables, trusts the reviewed hash, health-checks, and only then launches.
- Decline persists and does not prompt again; settings can reset the decision.
- Failure rolls back staging/trust and falls back to single-session TUI.
- Herdr launches lazily and hosts `picode-tui --chat <id>` panes. It never launches unmanaged chat writers.
- A version/hash/permission change revokes trust and requires a new explicit review.

P3 Gate:

- Yes installs the pinned valid asset and launches only after health passes.
- No performs no download/process/network and does not reprompt.
- Offline, malicious manifest, hash mismatch, unsupported platform, and failed health-check leave no trusted/running component.
- Disabled Herdr remains zero-resident.

## P4 — Red-light, recovery, performance, and platform Gate

Outcome: the complete workflow proves both green behavior and the ability of every critical Gate to turn red.

- Multi-GUI, GUI/TUI, and TUI/remote simultaneous mutation attempts.
- Simultaneous takeover, stale generation, duplicate request, lost acknowledgement, reconnect, and network partition.
- Healthy, background-active, waiting-user, stalled, terminal, crashed-client, crashed-Core, and partial-last-JSONL scenarios.
- GUI/TUI snapshot parity for accounts, model/provider identity, packages, extensions, Tasks, Work, and runtime state.
- Herdr decline, disabled, offline, tampered hash, permission expansion, failed health, upgrade, rollback, and uninstall.
- Windows atomic locator/path contract, Unix atomic-rename/path contract, the portable loopback Broker adapter, and portable install path tests. Native Pipe/socket transports stay replaceable adapters rather than unused parallel runtime paths.
- Bounded snapshot size, idle zero-residency, no prompt-path regression, and long-session/multi-pane performance contracts.
- Full frontend, Rust, extension smoke, permission, design, lint, formatting, performance, and P4 red-light suites.

Completion scenario:

1. GUI creates a Harness Task and starts a run.
2. TUI observes the live run without obtaining write authority.
3. GUI exits abnormally while the Agent is progressing; TUI remains observer.
4. The Agent reaches waiting-user or terminal state; TUI obtains the next generation and continues.
5. GUI reconnects as observer and sees identical Chat, Task, account, extension, Work, and Gate state.
6. Herdr detach/reattach changes no Picode authority or session identity.

## Phase review log

- P0: complete (2026-08-02). Re-read against this document after implementation. The existing Broker now carries a durable `clientId`, `clientSurface`, and per-socket connection ID; Client Gateway returns one bounded, recursively secret-screened snapshot assembled from Account, Task/Orchestration, Extension, Work, Runtime, and Pi package authorities. Manifest v2 declares compatible client surfaces with safe legacy defaults. A review caught and corrected a generated-per-snapshot GUI identity so requests now reuse the connection identity, and the host rejects a mismatched hello. Evidence: focused Rust Client Gateway tests 2/2, frontend Transport/WebSocket tests 70/70, and `cargo check --all-targets` green. Snapshot creation does not call WorkManager or ExtensionManager process-start paths.
- P1: complete (2026-08-02). Re-read against this document after implementation. Added the standalone Rust `picode-tui` binary and a bounded, atomically published loopback Core locator owned by the GUI process. The TUI uses only Broker controls and Client Gateway; it never opens Account Vault, extension state, Task storage, or Pi JSONL directly. Its shared view includes accounts/configured model metadata, Session Kernel descriptors, live GUI/TUI chat routes, Tasks, extensions, Work, Runtime, and Pi packages/Skills. The command palette supports selection/load, simple or Harness creation, prompt/continue, cancellation, rename, archive/unarchive, fork/clone, and arbitrary typed Picode controls. Existing live Pi chat paths map to their stable Session Kernel identities while runtime writes retain the real Pi session route. Unsupported visual editors stay GUI-only, with their underlying controls still reachable. Evidence: TUI parser/render tests 3/3, Core locator tests 2/2, Client Gateway tests 2/2, `cargo check --all-targets` green, and an optimized `picode-tui.exe` release build completed. Raw `pi` remains unchanged and explicitly unmanaged.
- P2: complete (2026-08-02). Re-read against this document after implementation. Added a transport-neutral Conversation Control module with stable client identities, monotonic lease deadlines, failed-probe challenges, per-claim fencing generations, and bounded duplicate-request rejection. Broker, ACP, chat-runtime controls, GUI, and managed TUI now pass through the same authorization seam; runtime events advance controller activity using stable Session Kernel chat IDs. A crashed client cannot be replaced while meaningful Agent progress continues, but waiting-user, terminal, surfaced-stall, and idle transitions make takeover available. Route changes release only safe idle ownership, stale generations become observers, and rejected GUI sends retain or restore the local draft. Core restart intentionally drops volatile leases while Pi JSONL, Tasks, and Session Kernel state remain authoritative and durable. A review also preserved legacy read/copy/backup/fork behavior and the existing two-confirmation delete flow. The final P4 review caught an ambiguous-socket-close path that released idle control too early; it now retains a suspect owner until the liveness challenge fails. Evidence: Conversation Control state-machine tests 8/8, focused frontend/side-bar tests 53/53, and `cargo check --all-targets` green.
- P3: complete (2026-08-02). Re-read against this document after implementation and corrected stale upstream metadata before declaring completion. The first interactive managed TUI now inspects a Core-owned Herdr Installer and offers localized install/trust, persistent decline, and details choices; nested Herdr panes and non-interactive clients never prompt. Approval alone enables the network path. The installer downloads one platform-pinned GitHub asset through an injected bounded downloader, verifies the published artifact SHA-256, safely extracts the Windows ZIP without running the upstream installer script, stages a versioned release atomically, probes the reviewed executable through WorkManager, then registers/enables/trusts its Manifest v2 executable hash. Launch remains a separate lazy action: ExtensionManager/WorkManager owns the Herdr server, a managed Herdr pane starts the same `picode-tui` against the same Broker and optional Chat ID, and only the interactive attach client inherits the terminal. Decline, tampering, failed health, or unsupported platforms leave no trusted/running component; professional settings show the discovered component and can reset the decision or remove the managed release. The final review added rollback of a server started by a failed launch transaction and fixed the catalog's rejection of the new `native-helper` kind. Evidence: Herdr installer transaction tests 5/5, managed TUI tests 3/3, focused Transport/professional-extension/XML tests 29/29, and `cargo check --all-targets` green.
- P4: complete (2026-08-02). Re-read the complete document after the optimized binaries were produced. Added a dedicated client-workflow red-light Gate for GUI/TUI/remote contention, lost acknowledgement, stale generations, ambiguous disconnect/probe, active-run protection, Core restart, bounded snapshots, truncated JSONL recovery, long-session bounds, and Herdr fail-closed/removal behavior; it is now part of the repository's full P0-P4 Gate. The review deliberately retained one portable loopback Broker transport instead of introducing unused Windows Named Pipe and Unix-domain runtime implementations; Windows uses write-through atomic locator replacement, Unix uses atomic rename, and both share the same bounded locator schema and client protocol. Herdr is zero-resident until reviewed install and lazy launch; a failed post-launch health/topology transaction cancels a server it started. Evidence: `docs/verification/p0-p4-gate.json` records 11/11 Gate groups passing, including 94 frontend files/381 tests, 219 Rust tests passing with 12 fixture tests intentionally ignored, strict Clippy and format, performance, malicious-extension, permission, design, extension-bundle, and Biome checks. Optimized `picode.exe` and `picode-tui.exe` were built successfully.
