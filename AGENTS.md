# pi-web-ui — Pi Studio

## Product

**Pi Studio** is a local Codex-style GUI for the Pi coding agent. It runs as a Tauri desktop app (primary) or as a lightweight Pi extension (secondary).

### Modes

**Desktop app (primary)**
Tauri wraps the web UI. A Rust `PiManager` (`src-tauri/src/pi_manager.rs`) spawns one `pi --mode rpc` subprocess per workspace, each on its own port. Each workspace gets its own OS window. The project launcher (`public/launcher.js`) shows all known projects as bubbles; clicking one opens or focuses the workspace window. Multi-project, multi-agent, no terminal required.

```
Tauri Desktop
  OS Window A  →  WebviewWindow → localhost:3001  →  pi --mode rpc  (project A)
  OS Window B  →  WebviewWindow → localhost:3002  →  pi --mode rpc  (project B)
  ...
  PiManager (Rust) spawns + tracks all pi processes
```

Tauri IPC commands (invoked via `window.tauriNative` in `public/tauri-bridge.js`):
- `cmd_open_workspace(cwd)` — spawn pi for a workspace, open a window
- `cmd_new_session(port)` — create a new session in a running pi
- `cmd_switch_session(port, sessionPath)` — resume a historical session
- `cmd_stop_instance(port)` — kill a pi process
- `cmd_pick_folder()` — native folder picker

**Pi extension (secondary)**
`extensions/mirror-server.ts` starts an HTTP + WebSocket server inside a running Pi process. Same web UI, no Tauri. Install with `pi install npm:pi-studio` and open the URL in any browser.

```
Pi process
  mirror-server extension  →  HTTP + WS on :3001  →  Browser (any device)
```

### Goals

- Local Codex-style GUI: all projects and agents visible in one app
- Multi-project: each project has its own window, isolated working directory, session history, and running agent
- Multi-agent: spawn new agents per project; switch between sessions without leaving the app
- Visualization: streaming chat, tool-call cards, thinking blocks, token/cost tracking per session
- Desktop-first; extension mode retained for lightweight / remote / mobile access

### Constraints

- Frontend: vanilla JS, no framework (`public/`)
- Backend: Rust (Tauri) for the desktop app; Node.js for the extension server
- PI integration: always via `pi --mode rpc` subprocess — never re-implement PI runtime logic
- Session history and working directory are isolated per project/port
- Extension mode must remain usable independently; desktop features are additive

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
