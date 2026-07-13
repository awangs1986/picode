# Delete Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a destructive workspace action that stops every managed Pi instance for that workspace and permanently removes all of its Pi session files, while preserving the project directory.

**Architecture:** `SessionSidebar` owns the archived-style confirmation UI and emits a deletion request for a concrete project. `app.js` uses a dedicated transport method and refreshes visible state only after it resolves. Rust records each managed process cwd, stops every matching process, then scans Pi session headers and removes only direct session directories whose declared cwd matches the requested workspace.

**Tech Stack:** Vanilla JavaScript and Vitest; Rust/Tauri v2; Pi embedded HTTP/broker runtime.

---

## File structure

- `public/session-sidebar.js`: workspace-header trash button, confirmation message, and injected async deletion callback.
- `public/session-sidebar.test.js` (new): DOM-level confirmation and callback behavior.
- `public/transport.js` and `public/transport.test.js`: typed browser transport wrapper for the new broker command.
- `public/app.js` plus a focused app test: invokes the transport, resets deleted-workspace state, reloads the sidebar, and reports errors.
- `src-tauri/src/pi_manager.rs`: persist each process cwd and find managed ports for a workspace.
- `src-tauri/src/main.rs`: cwd-verified session-directory deletion core, broker-control branch, and Rust tests.

### Task 1: Prove the native deletion boundary

**Files:**
- Modify: `src-tauri/src/main.rs:157-161, 545-605, 784-890`
- Modify: `src-tauri/src/pi_manager.rs:18-24, 628-630, 657-668`
- Test: `src-tauri/src/main.rs` test module

- [ ] **Step 1: Write a failing Rust test for sibling preservation**

Create a temporary sessions root with one JSONL `session` header containing `cwd: "/Users/me/project"`, one sibling containing `cwd: "/Users/me/other"`, and an empty directory. Test that deleting `/Users/me/project` removes only its directory.

```rust
#[test]
fn delete_workspace_sessions_keeps_other_workspace_directories() {
    let root = tempfile::tempdir().unwrap();
    write_session(root.path(), "--Users-me-project--", "/Users/me/project");
    write_session(root.path(), "--Users-me-other--", "/Users/me/other");
    fs::create_dir(root.path().join("empty")).unwrap();
    delete_workspace_session_dirs(root.path(), "/Users/me/project").unwrap();
    assert!(!root.path().join("--Users-me-project--").exists());
    assert!(root.path().join("--Users-me-other--").exists());
    assert!(root.path().join("empty").exists());
}
```

- [ ] **Step 2: Run the test to verify RED**

Run: `cargo test delete_workspace_sessions_keeps_other_workspace_directories --manifest-path src-tauri/Cargo.toml`

Expected: FAIL because the deletion helper does not exist.

- [ ] **Step 3: Implement minimal safe core**

Add `cwd: String` to `PiProcess`, populate it in `PiManager::spawn`, and expose `ports_for_cwd(&self, cwd: &str) -> Vec<u16>`. Add `delete_workspace_session_dirs(sessions_root, cwd)`: it iterates only direct child directories, uses existing `list_session_files` and `extract_session_cwd`, and calls `fs::remove_dir_all` only if a header exactly matches `cwd`. `delete_workspace_core(cwd, manager, broker)` must first call existing `stop_instance_core` for every matching managed port, then delete verified directories and return both counts.

```rust
if directory.is_dir()
    && list_session_files(&directory)
        .iter()
        .filter_map(extract_session_cwd)
        .any(|candidate| candidate == cwd)
{
    fs::remove_dir_all(directory).map_err(|error| error.to_string())?;
    deleted += 1;
}
```

- [ ] **Step 4: Expose the native broker command**

In `install_control_handler`, add `"delete_workspace"`: require non-empty `cwd`, invoke `delete_workspace_core`, and serialize `{ stoppedPorts, deletedDirectories }`. Keep it native-only, like `stop_instance`.

- [ ] **Step 5: Run focused verification**

Run: `cargo test delete_workspace --manifest-path src-tauri/Cargo.toml && bun run check:rust`

Expected: PASS with no clippy warnings.

### Task 2: Add the archived-style workspace control

**Files:**
- Modify: `public/session-sidebar.js:4-35, 780-830`
- Test: `public/session-sidebar.test.js`

- [ ] **Step 1: Write a failing sidebar test**

Render one project with an `onDeleteWorkspace` spy, click `.project-delete-workspace-btn`, accept `.sidebar-confirm-yes`, and assert the callback receives that exact project. In a second assertion, click Cancel and assert no call.

```js
it("confirms before deleting every session in a workspace", async () => {
  const onDeleteWorkspace = vi.fn().mockResolvedValue(true);
  const sidebar = new SessionSidebar(container, vi.fn(), vi.fn(), { onDeleteWorkspace });
  sidebar.projects = [{ path: "/Users/me/project", sessions: [session] }];
  sidebar.render();
  container.querySelector(".project-delete-workspace-btn").click();
  document.querySelector(".sidebar-confirm-yes").click();
  await vi.waitFor(() => expect(onDeleteWorkspace).toHaveBeenCalledWith(sidebar.projects[0]));
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `bun run vitest run public/session-sidebar.test.js`

Expected: FAIL because the action and callback are absent.

- [ ] **Step 3: Implement the minimal interaction**

Accept `options.onDeleteWorkspace`, render an accessible trash button beside `.project-new-chat-btn`, and stop its click from collapsing the group. Add `confirmWorkspaceDeletion(project)` that reuses `showFallbackConfirmDialog` and says all sessions are permanently deleted, active agents are stopped, and project files are kept. Disable the button while its callback is pending.

- [ ] **Step 4: Run GREEN**

Run: `bun run vitest run public/session-sidebar.test.js`

Expected: PASS.

### Task 3: Wire the request and refresh state

**Files:**
- Modify: `public/transport.js:50-105`
- Modify: `public/transport.test.js`
- Modify: `public/app.js` near SessionSidebar construction and workspace state helpers
- Test: `public/app-workspace-delete.test.js` (new)

- [ ] **Step 1: Write failing transport and app tests**

Add a `WsTransport` test proving `deleteWorkspace("/Users/me/project")` sends the exact native command. Add an app test proving success reloads the sidebar and a rejection calls `messageRenderer.renderError` without locally removing a project.

```js
await transport.deleteWorkspace("/Users/me/project");
expect(ws.sendControl).toHaveBeenCalledWith("delete_workspace", {
  cwd: "/Users/me/project",
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `bun run vitest run public/transport.test.js public/app-workspace-delete.test.js`

Expected: FAIL because the transport method and app callback do not exist.

- [ ] **Step 3: Implement minimal transport and app wiring**

Add `deleteWorkspace(cwd)` to `WsTransport`, forwarding `delete_workspace` with only `cwd`. Pass `onDeleteWorkspace` to `SessionSidebar`; reject a project without `path`, call `transport.deleteWorkspace(project.path)`, clear selected/active references belonging to that workspace, and call `sidebar.loadSessions()`. On failure call `messageRenderer.renderError` and preserve visible state.

- [ ] **Step 4: Run GREEN and format validation**

Run: `bun run vitest run public/session-sidebar.test.js public/transport.test.js public/app-workspace-delete.test.js && bunx biome check public/app.js public/session-sidebar.js public/transport.js public/session-sidebar.test.js public/transport.test.js public/app-workspace-delete.test.js`

Expected: PASS with no touched-file Biome violations.

### Task 4: Verify end-to-end safety

**Files:**
- Modify: no production files expected

- [ ] **Step 1: Run required verification**

Run: `bun run check && bun run test && bun run check:rust`

Expected: all checks pass; if existing unrelated Biome failures remain, record their exact untouched paths and retain the focused Biome result from Task 3.

- [ ] **Step 2: Manually smoke test with a disposable workspace**

Run `bun run dev`, create two sessions for a disposable workspace, and select Delete workspace. Verify `/api/instances` no longer lists its ports, the matching Pi session directory is gone, the project folder remains, and the sidebar no longer lists that workspace.
