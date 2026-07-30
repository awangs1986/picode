---
status: accepted
---

# Separate chat backups from workspace files

Make Chat Backups lossless for Picot Next conversation data and organization metadata, including branches, task state, titles, archived and favorite state, source provenance, workspace identity, non-secret model metadata, and available Chat Attachments. Exclude Account Vault secrets and every project or workspace file; a workspace-file reference remains metadata rather than causing that file to be copied. Missing external attachments remain represented without failing the containing chat import, while Compressed Context Packages retain only attachment descriptions or extracted results. Users migrate projects separately and restore execution capability through Workspace Binding, preventing chat backup from silently collecting source trees, large artifacts, or unrelated private files. Allow the user to create either an Encrypted Chat Backup with a user-supplied, cross-platform password or an explicitly unencrypted backup. Encryption is selected by default; choosing plaintext requires an explicit warning, and Picot Next never stores or recovers the password. Restoration is idempotent for identical sessions; a Restore Conflict never overwrites existing content and instead creates a labeled copy with a new session identity, followed by an added/skipped/conflicted report.
