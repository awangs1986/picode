---
status: accepted
---

# Activate one account per provider

Allow one active account for each provider at a time, shared by any number of Chat Sessions, while different providers may run concurrently. Logging out or replacing a provider account terminates only the connections and running tasks associated with that provider; other providers continue, and affected Chat Sessions retain their conversation context and task lists. When a replacement account becomes active, every session formerly bound to the old account is automatically rebound to the replacement. Tasks interrupted by account changes, application shutdown, crashes, or computer restarts never retry automatically and resume only after an explicit user continuation in the affected chat. The Account Vault may retain multiple inactive accounts for later switching, but two accounts from the same provider are never active simultaneously.
