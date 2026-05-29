# pi-web-ui — Pi Studio

## Product

**Pi Studio** is a local Codex-style desktop GUI for the Pi coding agent. It is a Tauri app that bundles its own `pi` runtime — there is no separate install of `pi` to manage, and no "extension mode" / "browser mode" to ship.

### Architecture

Tauri wraps the web UI. A Rust `PiManager` (`src-tauri/src/pi_manager.rs`) spawns one `pi --mode rpc` subprocess per workspace, each on its own port, using the embedded pi binary shipped in `src-tauri/resources/pi/` (downloaded by `scripts/fetch-pi-binary.js` from pi-mono releases at the version pinned in `scripts/pi-version.json`). Each workspace gets its own OS window. The project launcher (`public/launcher.js`) shows known projects as bubbles; clicking one opens or focuses the workspace window. Multi-project, multi-agent, no terminal required.

```
Pi Studio .app
  resources/
    public/                       (frontend)
    extensions/embedded-server.mjs (HTTP + WS server, runs inside pi)
    pi/<bun-compiled pi binary + assets>
  Rust PiManager
    spawn pi --mode rpc --extension embedded-server.mjs  (project A, :3001)
    spawn pi --mode rpc --extension embedded-server.mjs  (project B, :3002)
    OS Window per project  →  WebView  →  localhost:300X
  Tauri IPC commands wired through public/tauri-bridge.js
```

Tauri IPC commands (invoked via `window.tauriNative` in `public/tauri-bridge.js`):
- `cmd_open_workspace(cwd)` — spawn pi for a workspace, open a window
- `cmd_new_session(port)` — create a new session in a running pi
- `cmd_switch_session(port, sessionPath)` — resume a historical session
- `cmd_stop_instance(port)` — kill a pi process
- `cmd_pick_folder()` — native folder picker

### Goals

- Local Codex-style GUI: all projects and agents visible in one app
- Multi-project: each project has its own window, isolated working directory, session history, and running agent
- Multi-agent: spawn new agents per project; switch between sessions without leaving the app
- Visualization: streaming chat, tool-call cards, thinking blocks, token/cost tracking per session
- Fully self-contained desktop app: zero dependency on the user's PATH / shell environment / globally installed pi

### Constraints

- Frontend: vanilla JS, no framework (`public/`)
- Backend: Rust (Tauri) wraps + manages process lifecycle; Node.js extension (`embedded-server.ts`) implements the HTTP + WS surface the WebView talks to
- PI integration: always via embedded `pi --mode rpc` subprocess — never re-implement PI runtime logic
- Session history and working directory are isolated per project/port
- The embedded pi version is the source of truth: `pi --version` shown in the UI comes from `PI_STUDIO_PI_VERSION` (set by Rust at spawn time, populated from `scripts/pi-version.json`). A user-installed pi on `$PATH` is irrelevant and never touched.
- User extensions under `~/.pi/agent/extensions/` and `<workspace>/.pi/extensions/` are still auto-loaded by the embedded pi (embedding doesn't disable user extensions).

### PI references

- RPC protocol: `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/rpc.md`
- SDK: `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/sdk.md`
- Session format: `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/session.md`
- JSON mode: `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/json.md`

---

# Agent working notes

Conventions for any coding agent working in this directory.

## Bumping the embedded pi version

1. Edit `scripts/pi-version.json` → `version`.
2. `npm run fetch:pi` (re-downloads the platform tarball, replaces `src-tauri/resources/pi/`).
3. Smoke test: `./src-tauri/resources/pi/pi --version` and `npm run dev`.
4. Commit `scripts/pi-version.json`. Do **not** commit `src-tauri/resources/pi/`; it is gitignored.

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
