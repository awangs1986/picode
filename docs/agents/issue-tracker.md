# Issue tracking

Use GitHub Issues for PRDs, implementation slices, defects, and release-blocking follow-up. Read existing issues before creating a new one, keep one independently verifiable outcome per issue, and link the relevant specification section, roadmap level, and ADRs.

An implementation issue must state:

- user-visible outcome;
- affected Task Kind: Simple, Harness, or both;
- in-scope and out-of-scope behavior;
- affected schema or migration, if any;
- Capability Source Review for any capability Picode does not already provide;
- Explicit Skill Invocation, Task Override scope, and unresolved conflicts when a Skill or user command controls the workflow;
- Delegation Eligibility, Subagent Model Policy, fallback, and evaluation evidence for automatic Subagent routing;
- Agent Run state transitions, resource/usage attribution, probe timing, and false-stall evidence for Runtime Monitor changes;
- effective Harness Actions and Completion Gates when the issue uses a Harness Task; write `not applicable` for a Simple-only issue;
- security, secret, workspace, and cross-platform considerations;
- evidence required to close it.

Do not close an issue from UI presence alone. Report whether the result is Simple completed, Harness verified, Harness verified with overrides, implemented with incomplete Harness verification, environment-blocked, or failed.
