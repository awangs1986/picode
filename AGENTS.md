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

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.
- Study how established products solve the problem before designing a solution. Adopt their proven patterns and conventions rather than inventing an approach from scratch.

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
