# ADR-0029: Share Picode workflow and fence Conversation writers

Status: accepted — 2026-08-02

Picode GUI, managed TUI, and future authenticated remote clients will be adapters over the existing Picode Core authorities rather than independent agent applications or replicated state stores. Pi JSONL remains the full-transcript authority; Account Vault, Extension Manager, Task Experience, Work Manager, Runtime Lifecycle, and Session Kernel retain their existing ownership. One Chat Session may have many Observer Clients but only one Conversation Controller generation authorized to mutate it. Health-based takeover uses server-issued fencing generations and idempotent request identities, so a recovered stale client cannot resume writing. Herdr may host managed TUI panes after explicit pinned installation and trust, but remains an optional terminal host and never becomes a Picode state authority.

## Consequences

Directly launching raw `pi` remains an unmanaged Pi workflow. Surface adapters must not cache authoritative account, extension, Task, Work, runtime, or ownership state. A healthy or meaningfully active controller cannot be displaced; an unresponsive controller can be replaced at an idle, waiting-user, terminal, or surfaced-stall transition without asking the vanished client. Optional Herdr integration preserves the Extension Four-State Lifecycle and zero-residency guarantees.

## Rejected alternatives

- Synchronize GUI and TUI by copying settings files: creates multiple authorities and cannot coordinate live work.
- Let every client open and append the same JSONL: permits duplicate prompts and corrupt interleaving.
- Treat process existence or a heartbeat alone as activity: a hung client could retain control forever.
- Bundle or statically link Herdr: expands licensing and release coupling despite Herdr being replaceable terminal infrastructure.
