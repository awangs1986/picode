---
status: accepted
---

# Version and verify chat backups before restoration

Give every Chat Backup a versioned public Backup Manifest with integrity values for each chat and attachment. Validate and decrypt the complete archive before writing any session, then migrate supported older schemas transactionally. Corruption aborts the restore without partial changes; a manifest newer than the running application may be inspected but cannot be partially restored and instead prompts the user to upgrade. This favors recoverability and cross-version safety over best-effort salvage that could silently create incomplete conversations.
