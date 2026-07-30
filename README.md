# Picode

**English** | [简体中文](./README.zh.md)

Picode is a lightweight desktop workspace for the [Pi coding agent](https://github.com/earendil-works/pi). It is a maintained fork of [Picot](https://github.com/shixin-guo/picot), extended for long-running personal development work, multiple AI providers, portable chat history, and structured agent workflows.

Picode keeps Pi as its agent runtime and uses Tauri 2 with a Rust host. The goal is to preserve Pi's small, fast core while offering a practical desktop interface on Windows, Linux, and macOS.

> Picode is under active development. Back up important conversations and review agent actions before using it on valuable projects.

## Why Picode

Many official agent applications are excellent but heavy and isolated from one another. Picode is intended to be one local, low-overhead place where a developer can:

- use Pi with Codex, Claude, Cursor, and custom compatible APIs;
- keep multiple chats and projects organized without losing task context;
- import selected local conversations instead of moving everything blindly;
- switch provider accounts while preserving chat and task state;
- choose either a minimal chat or a structured development harness;
- inspect running agents, subagents, resource use, and suspected stalls.

## Current capabilities

### Accounts and models

- Manual import of supported local Codex, Claude, and Cursor account data.
- Manual JSON credential import with a review step before activation.
- Codex official OAuth and OpenAI-compatible reverse-proxy configurations.
- Custom OpenAI-compatible and Anthropic-compatible API providers.
- Provider-aware model selection, so identical model names remain distinguishable.
- Multiple stored accounts, with at most one active account per provider.
- Explicit continuation after account replacement; chats and task state are retained.
- Experimental Cursor Desktop/CLI OAuth support remains separate from the official Cursor SDK API-key channel.

Picode does not scan or import credentials automatically. Imported secrets are stored through the protected Account Vault rather than retained as source JSON files.

### Chats, migration, and backups

- Selective local history scanning for Codex, Cursor, and Claude.
- Human-readable import review with title, recent message preview, timestamp, size, source, and archive filters.
- Deduplication of source conversations and workspace-path normalization across Windows, Linux, and macOS.
- Required workspace binding before an imported chat may execute tools.
- Optional full reasoning import; reasoning is hidden from summaries and collapsed in the full viewer by default.
- Read-only full-context viewer for imported Codex, Cursor, and Claude chats.
- Lossless chat backups with optional encryption enabled by default.
- Compressed context packages for portable long-project handoff.

Project files are not included in chat backups.

### Tasks and agent workflow

- **Simple Task**: starts without selecting a project and uses Picode's managed Scratch Space.
- **Harness Task**: binds to a real workspace and adds structured plans, evidence, verification, and optional Git isolation.
- Durable task and account-handoff state.
- User-configurable subagent model policy for qualified, bounded work.
- Runtime monitor for agents, subagents, resource consumption, wait states, and suspected stalls.
- Lazy global and task-bound extension capabilities.
- Explicitly invoked user Skills may override Picode's default workflow for that task.

Picode never uses the launcher process directory as the default workspace. A blank startup uses an application-owned Scratch Space, avoiding unsafe locations such as `C:\Windows\System32`.

### Desktop experience

- Embedded `pi --mode rpc` runtime managed by the Rust host.
- Multiple sessions and projects with isolated Pi processes.
- Streaming Markdown, tool calls, diffs, reasoning blocks, attachments, and queued messages.
- Session search, rename, favourites, tags, archive state, and cost information.
- XML language packs with built-in English and Simplified Chinese.
- Package management and Pi extension compatibility.
- LAN/mobile access inherited from Picot, with a future remote-control extension planned.

## Architecture

```text
Picode desktop
├─ Tauri 2 / Rust host
│  ├─ Pi process and session lifecycle
│  ├─ account vault and provider activation
│  ├─ task, harness, extension, and runtime services
│  └─ chat migration, backup, and workspace safety
├─ WebView interface
│  ├─ chats, settings, accounts, models, and imports
│  └─ task and runtime monitoring panels
└─ embedded Pi runtime
   ├─ pi --mode rpc
   ├─ Picode bridge extension
   └─ user and project Pi extensions
```

The desktop UI communicates with Pi through a local RPC/WebSocket bridge. Agent execution remains local to the computer running Picode.

## Build from source

### Requirements

- [Rust](https://www.rust-lang.org/tools/install)
- [Bun](https://bun.sh/)
- Tauri 2 platform prerequisites for your operating system
- Git

```bash
git clone https://github.com/awangs1986/picode.git
cd picode
bun install --frozen-lockfile
bun run dev
```

Build a desktop package:

```bash
bun run build
```

Run the checks used during development:

```bash
bun test
cd src-tauri
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt -- --check
```

## Project status

Picode currently targets personal development use and is being validated primarily on Windows. Linux and macOS portability is an architectural requirement, but platform-specific behavior still needs broader testing before a stable release.

The implementation roadmap and architectural decisions live in [`docs/`](./docs/).

## Upstream and acknowledgements

Picode is a fork and derivative work of [Picot](https://github.com/shixin-guo/picot). Picot provided the desktop interaction model, Tauri foundation, session UI, and much of the original integration work that made this project possible. We are sincerely grateful to the Picot maintainers and contributors.

Picode is powered by the [Pi coding agent](https://github.com/earendil-works/pi). Pi provides the compact agent runtime, RPC mode, session format, model/provider integration, and extension ecosystem at the center of Picode. We are equally grateful to Pi's maintainers and contributors.

Where practical, Picode keeps its changes separable and documented so useful upstream Picot improvements can continue to be incorporated.

Picode is an independent community project and is not affiliated with or endorsed by OpenAI, Anthropic, or Cursor.

## License

Picode is distributed under the [MIT License](./LICENSE), consistent with Picot's license. Third-party components and bundled dependencies retain their respective licenses and notices.
