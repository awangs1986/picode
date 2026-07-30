---
status: superseded by ADR-0025
---

# Give explicitly invoked user Skills workflow precedence

When a user explicitly invokes an imported Skill for a Task Run, prefer that Skill's capability and process over conflicting Picode workflow defaults, because the invocation is a specific user strategy choice rather than passive tool availability. The override remains task-scoped and cannot bypass authorization, secrets, workspace and Git safety, account continuation, destructive-operation approval, licensing, platform constraints, or Harness verification; installed or automatically matched Skills receive no such precedence.
