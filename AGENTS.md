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
