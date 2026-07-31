# ADR-0028: Unify extension state and process adapters

## Status

Accepted — 2026-08-01

## Context

Skills, Hooks, MCP, LSP, DAP, Firstmate, native helpers, and optional capability entries had accumulated separate configuration and lifecycle projections. Hook state was persisted separately, MCP and DAP started jobs through the orchestration layer directly, LSP processes were visible only inside Pi tool execution, and the Professional Extensions UI assembled several snapshots. Consequently “enabled”, “trusted”, “running”, process ownership, and model visibility could disagree.

## Decision

`ExtensionManager` is the sole authoritative extension inventory and lifecycle source. Every managed component uses the ordered four-state projection `Discovered → Enabled → Trusted → Running`.

- Enabling changes discovery and model visibility only; it starts no process.
- Trust records a source review only; it grants no undeclared permission.
- Manifest v2 records source and pin/hash, package version, license, platforms, components, permissions, optional health check, and resource limits.
- A source-pin, content-SHA, or permission expansion invalidates prior review until explicitly approved. Executable SHA drift revokes trust before process creation.
- `WorkManager` is the sole process Adapter for native extensions, Hooks, stdio MCP, LSP, and DAP. The Pi bridge never spawns those component processes itself. WorkManager preserves component identity and work kind through protocol exchange, wait, cancellation, timeout, crash, and terminal refresh.
- `HookManager` remains only as a compatibility façade and owns no durable state. Legacy Hook state is imported once and the old state file is removed.
- CapabilityService is a lightweight discovery projection for LSP, DAP, and Firstmate; ExtensionManager projects its authoritative enabled state into that catalog.
- The Professional Extensions panel renders ExtensionManager's unified snapshot. Runtime discovery adapters may synchronize Skills into it but do not provide a second lifecycle state.

## Consequences

Disabled modules create no extension process and cannot prepare MCP network access or appear as model-discoverable. Untrusted Hooks, MCP, LSP, DAP, and Firstmate cannot run. Process monitoring and recent errors use one component identity. The resident cost is limited to bounded maps and schemas; executable components remain lazy.

Third-party native programs are still operating-system processes. Manifest permissions gate Picode actions and configuration; they are not a claim of an OS sandbox. Stronger per-process network/filesystem isolation remains platform-specific and must not be implied by the trust flag.

## Rejected alternatives

- Keep one lifecycle database per component type: preserves drift and makes the GUI an unreliable merger.
- Treat enablement as startup: violates lazy residency and makes Disabled/Enabled impossible to reason about.
- Treat trust as blanket permission: hides permission expansion and defeats manifest review.
- Let each adapter start its own child process: loses uniform cancellation, timeout, crash, resource, and task ownership semantics.
