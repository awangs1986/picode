# Capability Source Review

Every non-core capability must pass this review before implementation. Review sources in this order: Pi ecosystem, the smallest relevant Oh My Pi mechanism, comparable open-source agents, then a clean-room Picode implementation.

## Required record

- Capability and backlog item
- Candidate source URL, exact version or commit, license, and notice obligations
- Behavior and interface being studied
- Code copied, adapted, or clean-room implemented
- Security and permission boundary
- Startup, idle-memory, process, output, and context-budget impact
- Pi compatibility and failure isolation
- Maintenance signal and rejected alternatives
- Decision, owner, and review date

Unlicensed or proprietary source may inform observed behavior only. Its code must not be copied. A capability is not implementation-ready when the version, license, or permission expansion is unknown.
