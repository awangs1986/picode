---
status: accepted
---

# Introduce an encrypted account vault

Store multiple normalized Codex, Claude, and Cursor credentials in a Picot-managed account vault protected by the operating system's user-bound secret protection, and project only the selected credential into Pi's `auth.json`. Imported source JSON is discarded after parsing. If protected credential storage is unavailable, never fall back to plaintext persistence: the user may use an Ephemeral Credential for the current run or enable the platform credential service. Ordinary Settings Exports exclude all credentials; portable password-encrypted account backups are outside the short-term scope. This supersedes ADR-0002 because multi-account retention and switching cannot be represented by Pi's one-credential-per-provider file alone.
