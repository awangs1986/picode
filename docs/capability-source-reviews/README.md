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

Unlicensed or proprietary source may inform observed behavior only. Its code must not be copied. A capability is not implementation-ready when the version, license, or permission expansion is unknown. The review is a **pre-implementation gate**: a generic project inventory (such as the P0–P4 baseline) cannot substitute for a capability-specific record. User-invoked Skills may change task workflow, but they do not waive this source, license, secret, or permission gate.
