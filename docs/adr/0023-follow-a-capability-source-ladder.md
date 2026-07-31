---
status: accepted
---

# Follow a capability source ladder before writing new implementations

For every missing capability, search for a compatible Pi extension first, then adapt the smallest suitable Oh My Pi mechanism, then study comparable open-source agents (Claude Code, OpenCode, or another maintained project), and only then design a Picode-specific implementation. This is an implementation gate, not a documentation slogan: an issue cannot move to implementation until its per-capability Source Review records the candidates searched, why each earlier rung was rejected or adopted, and the final choice.

Each review records the exact URL and commit/version, license and notice obligations, behavior/interface relied upon, copied/adapted/clean-room status, security and permissions, startup/idle/process/output/context cost, compatibility and maintenance risk, rejected alternatives, owner, and review date. The generic P0–P4 review is a baseline inventory only; it does not satisfy the per-capability gate for a new feature.

Code may be copied only under a compatible license with required notices. Proprietary, unlicensed, or reverse-engineered sources remain behavioral references for independent implementation. A user-invoked Skill or task-local override may change the workflow order for that task, but it does not waive license, secret, permission, or process-isolation requirements.
