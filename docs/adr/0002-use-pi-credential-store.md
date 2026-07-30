---
status: deprecated
---

# Use Pi's credential store as the single source of truth

Store activated API keys and OAuth credentials only in Pi's standard `~/.pi/agent/auth.json`, with atomic writes, backups, user-only file permissions, masked UI, and secret-free logs and exports; store non-secret provider and model metadata in Pi's `models.json`. We deliberately avoid a second Picot account database or an OS-vault-backed custom credential store because Pi must persist OAuth token rotation itself and provider extensions expect its standard credential store.

This decision is deprecated and replaced by ADR-0003. Picode's multi-account requirements cannot be represented by Pi's one-credential-per-provider file alone.
