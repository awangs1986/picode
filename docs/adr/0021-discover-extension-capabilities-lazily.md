---
status: accepted
---

# Discover extension capabilities lazily

Keep only a minimal core tool set resident and represent user-global and task-bound extensions as lightweight entries in a local Capability Catalog. Agents discover them through `search_tools` or a compact task digest, and Picode loads full schemas and starts implementations only after selection, preserving extensibility without giving installed tools permanent memory, process, or prompt cost.
