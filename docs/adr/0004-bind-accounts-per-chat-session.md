---
status: superseded by ADR-0005
---

# Bind accounts per chat session

Each Chat Session has its own Account Binding, and concurrent sessions may use different accounts from the Account Vault. Changing an account or Codex channel must preserve the session's conversation context and task state, so credential selection cannot be implemented as a single global `auth.json` replacement; Pi runtimes need isolated credential projections or an equivalent shared credential broker.
