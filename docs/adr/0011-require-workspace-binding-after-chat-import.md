---
status: accepted
---

# Require workspace binding after every chat import

Place every newly Imported Chat in an Unbound Workspace state until the user confirms an existing directory on the current computer. Preserve the source platform and original path only as migration metadata; never execute it directly, automatically create it, or silently translate Windows and POSIX path syntax. Chats remain readable while unbound, but continuing tasks, running tools, and writing files are blocked. Selected chats sharing one original workspace are handled as a Workspace Binding Group, so one confirmation binds the group while unrelated workspaces remain separate. This deliberately adds an import step to prevent restored conversations from executing in nonexistent or unintended directories after cross-platform migration.
