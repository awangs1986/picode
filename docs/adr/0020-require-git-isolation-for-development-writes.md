---
status: superseded by ADR-0025
---

# Require Git isolation for development writes

Require development workspaces to bind to a local Git repository, use Git diffs and hunks for ownership and evidence, and retain content-version checks for stale-write rejection. One physical working directory grants one Task Run a Write Lease; concurrent writers use separately authorized branches and Worktrees, and Picode never stages, commits, merges, resets, cleans, or removes them without explicit user authority.
