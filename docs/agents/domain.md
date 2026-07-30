# Domain documentation

Picode uses one product context:

- canonical terms live in [`../../CONTEXT.md`](../../CONTEXT.md);
- hard-to-reverse architectural decisions live in [`../adr/`](../adr/);
- normative product behavior lives in [`../specs/`](../specs/);
- delivery order and exit gates live in [`../../ROADMAP.md`](../../ROADMAP.md).
- issue-ready implementation tasks and hard dependencies live in [`../P0-P5-BACKLOG.md`](../P0-P5-BACKLOG.md).

Use the exact terms from `CONTEXT.md` in code, tests, UI copy, issues, and new documentation. Change the glossary when domain meaning changes, but keep implementation formats and algorithms in specifications or ADRs. Add an ADR only for a hard-to-reverse, non-obvious trade-off; do not create ADRs for routine implementation choices.

When documents disagree, an accepted newer ADR supersedes an older ADR, and the current accepted specification defines the required behavior. Surface unresolved contradictions rather than silently choosing one.
