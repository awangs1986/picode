# Capability Source Review: `kunchenguid/firstmate`

Date: 2026-07-31  
Decision: accept as a Tier-3 optional external component candidate; do not bundle or load it by default.

## Pinned source

| Source | Pin | License | What was reviewed |
|---|---|---|---|
| [firstmate](https://github.com/kunchenguid/firstmate) | `f0d7cbe91a4734f189a5d85b27d02d3ef58a7d23` (`main`, fetched 2026-07-31) | MIT (repository license link) | README and repository layout: captain/crew orchestration, visible session backends, disposable Git worktrees, ship/scout task shapes, project modes, `FM_HOME`, restart/reconciliation, Pi extension entry points |

## Identity and boundary

The project explicitly describes itself as an **agent distro**, not a model, harness, skill, MCP server, or CLI. It is a portable directory of instructions, skills, tooling, policies, and state conventions that turns a supported coding harness into a first mate. Its normal operation launches other agent sessions in visible backends and isolated worktrees.

That makes it materially different from a Picode tool and unsuitable for the Resident Core. Picode will expose a disabled-by-default Settings entry named `Firstmate Crew Orchestrator`. Enabling it registers only a bounded manifest. Invocation must launch an external, user-authorized firstmate process with an isolated `FM_HOME` and explicit project/worktree boundary; Picode receives a scout report, patch/worktree reference, or PR metadata as unverified evidence.

## Source-ladder result

- **Pi extension search:** firstmate is not a Pi extension or Pi runtime package. Picode already uses Pi as its only conversation runtime and `pi-subagents` for Pi-native subagent orchestration. Those remain the first choice for in-process subagents.
- **Oh My Pi:** OMP provides behavioral references for lazy tools, background jobs, and bounded orchestration, but it does not provide firstmate's visible multi-harness crew/session backend. Embedding OMP would duplicate the runtime and violate Picode's lightweight boundary.
- **Comparable open source:** firstmate is the strongest direct reference for visible crew supervision, worktree isolation, ship/scout contracts, and restart-proof external orchestration. Claude Code/OpenCode are references for harness invocation and permission boundaries, not sources to embed.
- **Picode implementation:** only a thin adapter/manifest is justified. Do not copy firstmate's shell scripts, instruction distro, project hooks, or `.pi` files into Picode. Preserve its MIT notice only if source code is later bundled; this review currently bundles no firstmate source. The current GUI bridge stores or discovers a user-selected Firstmate root, validates `AGENTS.md`, and opens a dedicated Pi GUI workspace at that root. This keeps Firstmate's supported Pi/TUI semantics in the external repository while giving Picode a native GUI entry point; it does not embed the TUI or claim to replace Firstmate's crew backend.

## Security, resource, and compatibility contract

- No automatic clone, dependency installation, `gh auth`, backend startup, PR creation, merge, push, or main-branch mutation. Each is a separate user-authorized action.
- The adapter must pass an explicit project path, `FM_HOME`, backend, worker limit, timeout, memory/CPU/disk budget, and merge authority. Secret values remain references.
- Worktrees must be outside the active Picode workspace unless the user explicitly selects an in-place mode. Returned changes are not Harness-verified until Picode or CI runs the declared gates.
- Required host capabilities are Git plus a user-selected supported harness/backend. Missing dependencies are an environment-blocked result, not an implicit installer flow.
- A crash, hang, or orphaned child process must be visible to Runtime Monitor and must not corrupt the Chat Session. Disable removes the manifest from the Agent catalog and starts no firstmate process.

## Follow-up implementation issue

The GUI bridge is intentionally the first slice. A later full Tier-3 adapter issue must cover enable/disable persistence, isolated invocation, process/resource ownership, cancellation/reconciliation, report/worktree import, and explicit “unverified until Picode/CI gate” status. A UI checkbox or a copied README does not satisfy that larger review.
