---
status: accepted
---

# Continue external chats through a Pi branch

Import selected Codex, Claude, and Cursor conversations as immutable External Chat Snapshots containing every message, tool result, and summary that can be parsed reliably, with clear source provenance. After Workspace Binding, continuing an imported conversation creates a new Pi Continuation Branch rather than mutating the snapshot or pretending to restore inaccessible provider-native state. Picot Next's own backups remain a separate lossless restoration path for native sessions.
