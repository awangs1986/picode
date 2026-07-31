# Picode and Oh My Pi runtime alignment

Date: 2026-07-31

## Implementation status

Picode now implements a lightweight, OMP-compatible baseline for all four
runtime areas. The model-facing names and primary lifecycle semantics match
OMP (`bash`, `eval`, `task`, and `browser`), while processes and kernels remain
lazy so an unused capability has no resident runtime cost.

| Capability | Picode status | Alignment |
| --- | --- | --- |
| Shell | Session-scoped persistent shell plus complete managed-job control surface | Implemented baseline |
| Persistent code execution | Lazy persistent Python (including top-level await) and worker-isolated JavaScript cells | Implemented baseline |
| Subagents | Picode policy routing plus managed `pi-subagents` advanced orchestration | Implemented baseline |
| Browser automation | Lazy local/downloaded Chromium or existing-CDP named tabs, common actions, and failure recovery | Implemented baseline |

The remaining intentional OMP gap is interactive PTY rendering. Picode does not
pretend redirected RPC output is a real terminal: `pty: true` currently returns
an explicit non-PTY notice. Adding a native ConPTY/Unix PTY transport and GUI
terminal host remains separate product work rather than a hidden compatibility
claim.

## Shell

Picode overrides Pi's default `bash` definition with a persistent session shell.
It retains cwd and environment changes across calls, serializes concurrent
commands per session, streams output, supports timeout and process-tree
cancellation, and spills truncated full output to a temporary artifact. The
same tool can start a managed Harness background job. `picode_jobs` exposes
list/status/logs/wait/cancel/stdin lifecycle actions and the Runtime Monitor
shows the persistent Shell runtime.

OMP additionally supports structured
`cwd`, `env`, `timeout`, `pty`, and optional asynchronous execution; reuses
session-keyed native shell instances; has interactive PTY handling, hardened
non-interactive environment defaults, command interception, managed async jobs,
and artifact-backed output handling. Picode still reports a non-PTY notice when
PTY is requested instead of opening OMP's interactive terminal overlay.

Primary sources:

- Picode Pi runtime: `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js`
- Picode tool bridge: `extensions/embedded-server.ts` (`picode_background_job`)
- Picode process service: `src-tauri/src/orchestration_service.rs`
- [OMP Bash runtime](https://github.com/can1357/oh-my-pi/blob/main/docs/bash-tool-runtime.md)

## Persistent code execution

Picode's `eval` tool accepts one or more Python or JavaScript cells. JavaScript
runs in a per-session worker and VM context; Python uses a retained JSON-lines
kernel subprocess. Both retain variables across calls, isolate different
sessions, support per-language reset, return structured values and captured
output, and are destroyed on timeout, abort, or session replacement. Python
compiles cells with `PyCF_ALLOW_TOP_LEVEL_AWAIT` and keeps one event loop per
retained kernel, so imports, variables, and awaited work survive across cells
without starting a new interpreter.

OMP's `eval` tool retains separate session-scoped Python and JavaScript
runtimes. Cells can reuse variables and imports across calls, reset one language
runtime, return structured or image output, invoke tools and subagents, run
bounded parallel helpers, and participate in cancellation and timeout cleanup.

Primary source:

- [OMP eval tool](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/eval.md)

## Subagents

Picode retains the compatible read-only `picode_delegate` tool and its OMP-style
`task` surface for inexpensive policy-routed one-shot or batch work. Harness
Tasks additionally expose the managed `pi-subagents` extension's `subagent` and
`subagent_wait` tools. That extension supplies chains and parallel groups,
fresh/forked context, background control, steering and resume, structured
output and acceptance gates, reusable workflows, isolated git worktrees, and
nested orchestration. Simple Tasks do not load these advanced tools.

OMP's `task` tool is a general subagent runtime. It supports single or batched
fan-out, discovered agent profiles, mixed blocking/background execution,
concurrency limits, effort selection, typed output schemas, lifecycle state,
saved `agent://` results, and optional filesystem/worktree isolation. Picode
keeps its GUI-configured cheap-model policy as a separate narrow path while
using `pi-subagents` for the advanced orchestration surface.

Primary sources:

- Picode tool bridge: `extensions/embedded-server.ts` (`picode_delegate` and
  `SUBAGENT_TOOL_MAP`)
- Picode orchestration: `src-tauri/src/orchestration.rs` and
  `src-tauri/src/orchestration_service.rs`
- [OMP task tool](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md)

## Browser automation

Picode's `browser` tool now supports persistent named tabs, lazy local Chrome,
Chromium, or Edge launch, existing HTTP CDP attachment, navigation, page
evaluation, observation with stable references, accessibility-tree capture,
click/fill/type/press/scroll/wait operations, text extraction, screenshots, and
explicit open/run/close lifecycle management. It uses CDP directly and keeps
the shipped application small: an installed browser is preferred, otherwise it
lazily downloads the official Stable Chrome for Testing archive into
`~/.pi/agent/picode-browser`. Downloads are HTTPS/host-pinned, size-bounded,
cached, and can be disabled with `app.auto_install: false`. A lost tab CDP
connection is recycled; when the browser process dies, every named tab owned by
that process is recreated at its last known URL so a retry can continue.

OMP's `browser` tool provides persistent named tabs, headless Chromium,
spawned-app or existing-CDP attachment, worker-isolated JavaScript execution,
accessibility snapshots and stable element references, common page actions,
screenshots, extraction, and explicit open/run/close lifecycle management.

Primary source:

- [OMP browser tool](https://github.com/can1357/oh-my-pi/blob/main/docs/tools/browser.md)

## Capability Source Review

- Source ladder level: Oh My Pi behavioral and architectural reference after no
  compatible standalone Pi extension provided the complete four-part runtime.
- Upstream: `can1357/oh-my-pi`, commit
  `cc00ab161b2721e50d8a96a0dc9552abfd258b8b`.
- License: MIT.
- Adaptation: independent Picode implementation against OMP's public tool and
  runtime documentation; no OMP source file was copied.
- Maintenance boundary: Picode owns small Node/Bun-compatible runtime modules
  under `extensions/runtime/` and avoids OMP's native crates and dependency
  graph.
- Runtime cost: registration is cheap; shells, language kernels, Subagent Pi
  processes, and browser processes start only on first use.
- Permissions: Simple Tasks retain only the basic shell surface. Eval, browser,
  managed jobs, and general Subagents activate only for Harness Tasks. Subagent
  model policy remains disabled until the user enables it.

## Adopted Picode shape

The implementation keeps only the tool definitions resident. Shell sessions,
Python/JavaScript kernels, child Pi processes, and CDP browser processes start
on demand and are disposed with their owning session. The existing Runtime
Monitor reports the shared Pi-process memory together with active Shell, Eval,
Subagent, background-job, and browser instances.
