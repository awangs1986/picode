# Picode V3 development guide

## Authority

- `PICODE-V3-DESIGN.md` owns product scope and P0–P5 sequencing.
- `CONTEXT.md` owns domain language.
- `docs/design/MODULES.md` owns Module and Interface placement.
- ADRs own accepted architectural decisions.

## Architecture

Picode is Extension-first and TypeScript-first. Keep the upstream Pi Agent Loop,
TUI, session semantics, and native tools intact. New behavior belongs behind the
Store, Engine, Guard, or Devloop Interfaces and is composed by the Adapter
Extension. Do not introduce a second Runtime, Task, Session, Account, or Evidence
authority.

`serve/` is a transport adapter, not a fifth domain module. Standalone
`picode serve` may own a foreground headless Pi Runtime; TUI `/server` must bind
to the already-running Pi session and must not spawn a second writer. Remote
`command.execute` is read-only. Chat mutation uses dedicated Control methods and
the Writer Lease, while workspace, permission, capability, account, and model
availability remain Host-authoritative.

## Engineering principles

- Build the smallest end-to-end slice that leaves Picode working. Finish it before adding another capability; do not trade a working path for speculative or half-finished infrastructure.
- Choose the simplest implementation that fully satisfies the current contract. Avoid unrelated cleanup, configuration, indirection, and abstractions for hypothetical future needs.
- Preserve Store / Engine / Guard / Devloop ownership and keep each fact under one authority. Adapters compose modules; they do not own parallel state or a second lifecycle.
- Inspect the code and dependencies already present before adding code or packages, including their documentation and types. For consequential or unfamiliar design, follow the capability-source ladder below, time-box the comparison, and adopt only patterns that reduce total complexity.
- Remove obsolete internal paths instead of leaving parallel legacy shims. Persisted user data, public APIs, CLI behavior, extension contracts, imported sessions, and pinned Pi compatibility are external contracts: preserve or deliberately migrate them unless the user authorizes a breaking change.
- Invest in durable design at hard-to-reverse seams. For reversible implementation details, prefer the smallest complete choice.

## Verification

- Work test-first at the documented Interface seam.
- Run `npm run check` after TypeScript or JavaScript changes.
- A Gate with zero matched tests is a failure.
- `skipped` and `not_run` are never equivalent to `passed`.
- Every completion-critical Gate must include a controlled red probe.

## Git and compatibility

- Never commit, merge, push, or publish without explicit user approval.
- Preserve compatibility with the pinned Pi version and pi-subagents.
- Prefer existing Pi extensions, then Oh My Pi/Grok Build behavior, then other
  compatible open-source agents, before writing a capability from scratch.
- Old V2 Rust/Tauri code is migration evidence and fixture material, not a Runtime
  dependency.
