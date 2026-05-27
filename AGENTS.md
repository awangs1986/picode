# pi-web-ui — Tau

## Product

**Tau** (`tau-mirror` on npm) is a local, browser-based Codex-style GUI for the PI coding agent.

Current form: a Pi extension that mirrors one terminal session into the browser — same messages, same tools, any screen.

Target form: a standalone local app that manages multiple PI agents across multiple projects simultaneously, with a full visual dashboard. The goal is a web-native equivalent of the OpenAI Codex UI: open it locally, see all your projects and running agents in one place, start new agents, watch them work in real time.

This is the web-native counterpart to `pi-gui` (Electron/Tauri). They share the same product direction; Tau targets any browser without a native install.

### Goals

- **Multi-agent**: spawn, monitor, and switch between multiple PI agent instances from one UI
- **Multi-project**: each project has its own sidebar entry, isolated working directory, session history, and running agent
- **Visualization**: live tool-call timeline, streaming chat, thinking blocks, token/cost tracking per agent
- **No Electron dependency**: runs entirely in the browser against a local Node.js server; installable as a PWA

### Architecture

```
Browser (Tau UI)
  Multi-agent Dashboard
  Project Sidebar
  Chat Pane
  Tool Call Timeline
        |
        | WebSocket
        v
Local Node Server
  WebSocket Gateway
  Agent Manager
    RPC Bridge — Agent 1  -->  pi --mode rpc  (project A cwd)
    RPC Bridge — Agent 2  -->  pi --mode rpc  (project B cwd)
```

Multi-agent state lives in the server process. The browser is a pure view layer.

### Constraints

- Tech stack: vanilla JS frontend (no framework); Node.js backend; WebSocket transport
- PI integration: via `pi --mode rpc --no-session` subprocess or PI SDK — never re-implement PI logic
- Session history and working directory are isolated per project
- Never break single-agent / single-project mode; multi-agent support is strictly additive

### PI references

- RPC protocol: `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/rpc.md`
- SDK: `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/sdk.md`
- Session format: `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/session.md`
- JSON mode: `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/json.md`

---

# Agent working notes

Conventions for any coding agent working in this directory.

## Post-fix verification (Rust / Tauri)

After every edit under `src-tauri/` (or any Rust fix), run the lint+check
script before declaring the work done. It catches compile-time errors
(e.g. `E0282`, `E0061`, Tauri v1→v2 API drift, deprecated APIs) without
producing a binary, so it is much faster than `tauri build`.

```bash
# from pi-web-ui/
npm run check:rust
# or directly
bash scripts/check-rust.sh
```

`scripts/check-rust.sh` runs, in order:

1. `cargo check --all-targets` — type/borrow/API signature check (~1–5s).
2. `cargo clippy --all-targets -- -D warnings` — lints, warnings as errors.
3. `cargo fmt --check` — advisory only; prints a hint if formatting drifts,
   but does not fail the script.

### Rules

- **Never** run `tauri build` / `cargo build` just to verify a fix — use
  `npm run check:rust` instead. Per project policy, full builds are not
  used for verification.
- After editing any `*.rs` file under `src-tauri/`, run `npm run check:rust`
  and only mark the task complete if it exits 0.
- When upgrading Tauri or its plugins, run the script first to surface any
  deprecation warnings before touching feature code.

## Note on `.pi/AGENTS.md`

`./.pi/AGENTS.md` is the **runtime** spec file read by the pi coding agent
when pi is launched against this workspace. It describes *what the product
is*. Do not put developer/build workflow rules in there — put those here.
