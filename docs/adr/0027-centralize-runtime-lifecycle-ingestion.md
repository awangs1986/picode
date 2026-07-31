# ADR-0027: Centralize Runtime Lifecycle ingestion

## Status

Accepted — 2026-07-31

## Context

Picode receives runtime observations from Pi today and will also expose ACP, headless, extension, CI, and remote-control entry points. The former Pi observer interpreted the same raw event independently for Task Control, Runtime Spine, Session Kernel, Work Manager, Context Engine, Completion Coordinator, and extension cleanup. This made event ordering, terminal semantics, replay, and failure handling depend on one application-composition function.

`agent_end` is especially ambiguous: it ends one Agent turn but does not prove that a Harness Task has passed its Completion Gates. High-frequency token and output deltas also have very different durability and performance requirements from semantic lifecycle transitions.

## Decision

Picode will use one Runtime Lifecycle authority per Runtime Instance.

- Source adapters owned by the module translate Pi, ACP, and future raw protocols into bounded Lifecycle Events.
- A Runtime Instance carries one Agent Run. Continuation, reconnection, or account replacement creates a new Agent Run and Runtime Instance linked to the preceding run while preserving the Chat Session and Task Run.
- Semantic events are durably committed before required idempotent projections run. Projection checkpoints support replay; an incomplete required projection places the Runtime Instance in `Reconciling` and prevents a terminal claim.
- Each Runtime Instance has an independent bounded serial mailbox. Critical events are never silently dropped; coalescible progress retains only the latest observation for a Work identity.
- Streaming text, reasoning, terminal chunks, and raw tool output do not enter the lifecycle journal. Their governed streaming or artifact stores remain authoritative.
- `agent_end` transitions to completion evaluation. The built-in Simple Task policy settles the Runtime Instance while leaving the conversational Task Run ready for another explicit turn; only a successful Harness Completion Gate automatically completes a Harness Task Run.
- Extensions may observe committed Lifecycle Events and submit validated Runtime Intents. They cannot directly forge authoritative transitions or raise permissions.
- `main.rs` remains the composition root and only wires the raw observer to Runtime Lifecycle.

## Consequences

Event interpretation, ordering, and terminal semantics become local to one deep module and can be tested without the desktop composition root. Specialized modules retain their existing data ownership and can be replaced independently through projection adapters. Runtime event storage remains bounded and privacy-safe.

The lifecycle journal and projection checkpoints add small durable writes for semantic events. This cost is intentionally avoided for streaming deltas. Projection implementations must be idempotent, and new runtime sources must provide a source adapter rather than adding protocol branches to application entry points.

## Rejected alternatives

- Let every downstream module interpret raw events independently: preserves current coupling and divergent terminal semantics.
- Persist every RPC frame: increases memory, disk, lock contention, and privacy exposure without improving lifecycle recovery.
- Run old and new side effects in parallel during migration: risks duplicate Gates, messages, work records, and cleanup.
- Allow trusted extensions to write Lifecycle Events directly: makes core identity and completion invariants removable with an extension.
