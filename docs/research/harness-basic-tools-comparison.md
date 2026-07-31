# Claude Code, OpenCode, and Oh My Pi: basic harness tools

Checked: 2026-07-31

This comparison uses the model-facing harness as the unit of analysis. A slash
command, settings panel, or session picker is not counted as a tool unless the
model can invoke the corresponding operation. Likewise, a bundled but gated
tool is separated from an always-available core tool, and an MCP/plugin tool is
separated from the built-in registry.

## Executive comparison

| Harness layer | Claude Code | OpenCode | Oh My Pi |
| --- | --- | --- | --- |
| Read and discover files | `Read`, `Glob`, `Grep` | `read`, `glob`, `grep` | `read`, `find`, `search` |
| Modify files | `Edit`, `Write`, `NotebookEdit` | `edit` + `write`, or model-selected `apply_patch` | `edit` (Hashline), `write`, plus structural `ast_edit` |
| Execute | `Bash`; conditional native `PowerShell` | `bash`/shell | `bash`, persistent `eval`, configured-host `ssh` |
| Code intelligence | `LSP`, inactive until a code-intelligence plugin/server is available | `lsp`, experimental feature flag | lazy `lsp`; `ast_grep`; `debug` over DAP |
| User interaction and task state | `AskUserQuestion`; durable task CRUD tools | `question`; `todowrite` | `ask`; phased `todo` |
| Delegation | `Agent`; background agents; optional worktree isolation; experimental teams/workflows | `task`; configurable subagent types; background subagent mode is experimental | `task`; typed results; parallel fan-out; optional worktree/FUSE/ProjFS filesystem isolation; `hub` supervision |
| Web and UI automation | `WebFetch`, `WebSearch`; these are not a browser | `webfetch`; gated `websearch`; neither is a browser | `web_search`; a distinct `browser` tool; optional native `computer` tool |
| Extension surface | Skills, MCP, hooks, plugins, subagents, deferred `ToolSearch` | Skills, MCP, plugins, global/project JS/TS custom tools | Pi/OMP extensions, custom tools, skills, MCP, internal URI devices |
| Safety boundary | Tool/path/command permissions plus optional OS filesystem/network sandbox; checkpoints for direct edit tools | allow/ask/deny rules, including external-directory boundaries | per-tool and Bash-pattern approval rules; critical-command guard; subagent filesystem isolation is optional and subagents run in-process |
| Context control | automatic compaction, targeted rewind/summarize, file-edit checkpoints, resumable sessions | sessions, bounded/truncated tool results, task contexts | aggressive tool-result pruning, multiple compaction strategies, checkpoint/rewind and optional durable memory tools |

## Claude Code

### Everyday core

- Files: `Read`, `Glob`, `Grep`, `Edit`, and `Write`.
- Runtime: `Bash`; `PowerShell` is a conditional native tool depending on
  platform and configuration.
- Coordination: `Agent`, `AskUserQuestion`, and task-list tools
  (`TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`, `TaskStop`).
- Network: `WebFetch` and `WebSearch`.
- Extension discovery: `Skill`, MCP resource tools, and `ToolSearch` for
  deferred tools.

### Important conditional capabilities

- `LSP` is a built-in tool name, but it remains inactive until a code
  intelligence plugin and its language-server binary are installed.
- `Monitor` turns a command or WebSocket stream into a live background event
  source; normal Bash commands and subagents can also run in the background.
- `EnterWorktree`/`ExitWorktree` and subagent `isolation: worktree` provide Git
  isolation. Worktree isolation separates files; it is not the same as OS
  process sandboxing.
- `NotebookEdit`, scheduled-task tools, `Workflow`, agent-team messaging, and
  remote-control tools exist only on the relevant version, plan, platform, or
  feature surface.

### Harness character

Claude Code's differentiator is not an unusually rich code-editing toolbox. It
is the control plane around a conventional core: fine-grained permission
patterns, hooks before and after lifecycle events, an optional OS-level Bash
sandbox, file-edit checkpoints, background task handles, and mature subagent
and worktree workflows.

Primary sources:

- [Tools reference](https://code.claude.com/docs/en/tools-reference)
- [Permissions](https://code.claude.com/docs/en/permissions)
- [Sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Subagents](https://code.claude.com/docs/en/sub-agents)
- [Parallel agents](https://code.claude.com/docs/en/agents)
- [Worktrees](https://code.claude.com/docs/en/worktrees)
- [Checkpointing](https://code.claude.com/docs/en/checkpointing)
- [Extension overview](https://code.claude.com/docs/en/features-overview)

## OpenCode

### Default registry

The current `dev` registry constructs shell, read, glob, grep, edit, write,
task, web fetch, todo, web search, skill, patch, question, LSP, and plan tool
definitions. It then filters the visible set by client, model, provider,
feature flags, and permissions.

The practical default surface is:

- `bash`, `read`, `glob`, `grep`;
- a mutation surface selected for the model: GPT-5-family models receive
  `apply_patch`, while other models receive `edit` and `write`;
- `task`, `todowrite`, `webfetch`, and `skill`;
- `question` in app/CLI/desktop clients.

### Conditional capabilities

- `websearch` is exposed only for the OpenCode provider or when an enabled
  search backend flag is present.
- `lsp` is experimental and requires the experimental LSP flag.
- plan tools and Code Mode's `execute` dispatcher are experimental.
- background subagents exist behind an experimental flag; normal subagent
  depth defaults to one and is checked by the task tool.

### Harness character

OpenCode keeps the resident tool surface small and uniform. Its strongest
architectural lesson is the registry boundary: built-ins, plugin tools, custom
tools, and MCP tools pass through one permission and description pipeline. It
does not try to make AST rewriting, DAP debugging, or browser control part of
the default coding core.

Primary sources:

- [Tools documentation](https://opencode.ai/docs/tools/)
- [Agents and permission keys](https://opencode.ai/docs/agents/)
- [Custom tools](https://opencode.ai/docs/custom-tools/)
- [Tool registry source](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/registry.ts)
- [Task tool source](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/task.ts)
- [Tool source directory](https://github.com/anomalyco/opencode/tree/dev/packages/opencode/src/tool)

## Oh My Pi

### Published tool surface

Oh My Pi advertises 32 built-in tools, but its README intentionally presents
the public capabilities by family rather than claiming every registered helper
is always visible.

- Files and search: `read`, `write`, Hashline `edit`, `ast_edit`, `ast_grep`,
  `search`, and `find`.
- Runtime: persistent-session `bash`, persistent Python/JavaScript `eval` with
  tool re-entry, and configured-host `ssh`.
- Code intelligence: `lsp` for diagnostics/navigation/refactors and `debug`
  for DAP sessions.
- Coordination: `task`, `hub`, phased `todo`, and `ask`.
- External capabilities: `browser`, `web_search`, `github`, image generation
  and inspection, and TTS.
- Context and memory: `checkpoint`, `rewind`, `retain`, `recall`, and `reflect`.
- Previewed structural mutations are finalized through `resolve`.

The source registry also contains conditional or internal-facing tools such as
native `computer`, skill management, security scanning, `yield`, and tool
discovery/device plumbing. These should not all be described as default model
tools.

### Default versus gated

The README explicitly marks `github`, `inspect_image`, `tts`, `checkpoint`,
`rewind`, `retain`, `recall`, and `reflect` as setting-gated and off by default.
Native `computer` is also disabled by default. Other factories can disappear
when their runtime dependency is unavailable. The active built-in set can be
pinned, while rarely used capabilities remain discoverable rather than
occupying the prompt permanently.

### Harness character

Oh My Pi invests most heavily in the data plane: reliable content-anchored
edits, structural queries/rewrites, lazy LSP diagnostics, a real debugger,
persistent evaluation kernels, rich reads, and supervised parallel agents.
Its subagents have separate agent/tool contexts and optional isolated
filesystems, but currently execute in-process; filesystem isolation must not be
misreported as process or OS security isolation.

Primary sources:

- [Repository README and tool families](https://github.com/can1357/oh-my-pi#whatever-the-task-needs-its-already-in-the-box)
- [Tool registry source](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/tools/index.ts)
- [Tool source directory](https://github.com/can1357/oh-my-pi/tree/main/packages/coding-agent/src/tools)
- [Settings and approval behavior](https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md)
- [Subagent execution and isolation](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/DEVELOPMENT.md#task-tool-agent-delegation-selection-and-parallel-execution)
- [Compaction pipeline](https://github.com/can1357/oh-my-pi/blob/main/docs/compaction.md)
- [Advisor tool isolation](https://github.com/can1357/oh-my-pi/blob/main/docs/advisor-watchdog.md#tools-and-isolation)

## Common minimum and the real dividing line

All three reduce to the same minimum viable coding harness:

1. bounded file read;
2. path discovery and content search;
3. stale-safe file mutation;
4. shell execution with cancellation and bounded output;
5. structured user clarification;
6. durable task state;
7. an extension seam.

Beyond that minimum:

- Claude Code is strongest in permissions, sandboxing, hooks, recovery, and
  multi-agent workflow governance.
- OpenCode is strongest as a compact, legible, extensible registry whose tools
  can be swapped or filtered by model and environment.
- Oh My Pi is strongest in local code manipulation and inspection: Hashline,
  AST, LSP, DAP, persistent eval, and rich supervised subagents.

## Implication for Picode

Picode should not copy the union of every tool into every prompt. The best fit
for its lightweight goal is:

- resident core: read, search/find, stale-safe edit/write, shell, ask, and
  compact task state;
- lazy project capabilities: LSP, AST search/edit, debugger, and test/build
  harness actions;
- task-activated services: background jobs, subagents, worktrees, and remote
  hosts;
- explicit extensions: browser/computer control, GitHub, MCP, media, and
  durable memory backends;
- one permission and lifecycle pipeline for built-in, global-extension, and
  task-extension tools.

The first tool-level gap worth closing is not “more tools.” It is a reliable
resident edit/search/shell core plus lazy LSP and a background-job handle. AST
and DAP should follow as project-activated capabilities, not startup-resident
services.
