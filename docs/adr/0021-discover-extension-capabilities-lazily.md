---
status: accepted
---

# Discover extension capabilities lazily

Keep only a minimal core tool set resident and represent optional capabilities as lightweight entries in a local Capability Catalog. Picode has three distinct residency tiers:

1. **Resident Core** — the small control plane needed for chat, task lifecycle, authorization, filesystem/process primitives, secrets, Git metadata, and Runtime Monitor. It is loaded at startup.
2. **Discoverable Lazy Capability** — a user-enabled Pi extension, MCP/LSP provider, or built-in module. Its manifest is searchable, but schemas, dependencies, processes, and browser/engine runtimes start only after task selection and authorization.
3. **Disabled User Module** — installed or externally available, but disabled in Settings. It is not in the Agent catalog, cannot be searched or invoked, and must not start a process. Enabling it moves only the manifest into tier 2; invocation is still lazy.

The tier is persisted in settings and carried into the task snapshot. A task-local override may enable a tier-3 module for that task, but the override is visible, expires with the task, and cannot silently alter other tasks. Agents discover tier-2 entries through `search_tools` or a compact task digest. Picode must not make every Harness task a reason to load every optional implementation: a capability is activated only when selected, and a tier-3 module remains invisible until the user explicitly enables it.

This decision applies to first-party modules and external components such as `kunchenguid/firstmate`. Firstmate is an external crew orchestrator, not a second resident agent runtime; its integration boundary is a tier-3 wrapper that launches an isolated, user-authorized process and returns reports/worktrees through the Picode handoff surface.
