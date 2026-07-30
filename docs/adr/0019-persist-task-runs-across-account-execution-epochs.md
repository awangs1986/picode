---
status: accepted
---

# Persist Task Runs across account execution epochs

Compose ADR-0005 and ADR-0010 by keeping one durable Task Run when an account disconnects and another active account takes over its Chat Session associations, while recording each provider/account/channel/model interval as a separate Execution Epoch. Account B receives the preserved chat, task, and evidence state, but the Task Run remains suspended and no model request or tool execution starts until the user explicitly continues that specific chat; continuation then begins B's new epoch without losing provenance.
