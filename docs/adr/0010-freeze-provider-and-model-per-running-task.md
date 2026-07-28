---
status: accepted
---

# Freeze provider and model per running task

Capture a Task Execution Snapshot when each task starts and use that provider account, channel, and model until the task completes or is stopped. Changes in the chat's bottom selector apply to the next user request only. A user who wants an immediate change must stop the current task and then explicitly continue or issue a new instruction, preventing one logical task from silently changing identity or model mid-execution.
