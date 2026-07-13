# Delete Workspace Design

## Goal

Let a user permanently remove a Picot workspace's Pi session history without
deleting the underlying project directory.

## User interaction

Each workspace group in the session sidebar gets a trash action next to its
existing new-chat action. Its confirmation uses the same overlay, keyboard,
backdrop, Cancel, and Delete interaction as **Delete all archived sessions**.
The message states that all sessions for the named workspace will be deleted
permanently, active agents will be stopped, and the project folder is kept.

On confirmation, the UI disables duplicate action, executes the deletion, and
reloads the session list. The normal empty-workspace sidebar state is shown if
no projects remain.

## Deletion boundary

Deletion is scoped to the exact workspace `cwd`, not a user-provided filesystem
path. The native control handler finds every PiManager instance whose `cwd`
matches, stops and unregisters each of them, then removes every session
directory under `~/.pi/agent/sessions/` whose JSONL session header declares the
same `cwd`. It must never delete the workspace/project directory itself.

The backend does not trust a browser-supplied session directory name. It scans
only direct child directories of the Pi sessions root, reads the existing JSONL
session headers, and deletes only directories whose declared cwd exactly matches
the requested workspace. Failures are returned to the UI and leave the
workspace visible after reload.

## Components

- `public/session-sidebar.js`: renders the trash action, owns the confirmation
  copy and invokes an injected workspace-deletion callback.
- `public/app.js`: wires the callback to the native broker, guards the current
  workspace navigation state, and reloads the sidebar after success/failure.
- `src-tauri/src/main.rs` and `src-tauri/src/pi_manager.rs`: add a broker
  control operation that stops all matching managed processes and safely deletes
  the session directories verified to belong to that workspace.
- Focused JS and Rust tests prove confirmation/callback behavior, cwd scoping,
active-instance shutdown, and sibling-workspace preservation.

## Error handling

The browser must not optimistically remove a workspace. A broker error is shown
through the existing chat error surface and the sidebar is reloaded. The Rust
operation matches session headers before filesystem deletion, tolerates an
already-stopped instance, and returns a clear error for an invalid target.

## Non-goals

- Deleting files in the user's project folder.
- Deleting a single non-archived session through this new action.
- Adding a workspace registry or a hidden-workspace state.
