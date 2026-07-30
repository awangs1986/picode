---
status: superseded by ADR-0025
---

# Make the project harness an executable contract

Treat a user-confirmed, project-owned Harness Profile as Picode's source of truth for build, test, check, generation, and completion behavior, with Task Runs retaining baseline-aware evidence for every claimed result. This favors reviewable project knowledge and reproducible proof over guessed commands, model judgment, or a Picode-specific replacement workflow, while keeping execution authorization separate from trust in the profile.
