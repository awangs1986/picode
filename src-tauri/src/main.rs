#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod account_binding;
mod account_import;
mod account_vault;
mod acp_adapter;
mod authorization;
mod broker_ws;
mod capability;
mod capability_service;
mod chat_backup;
mod chat_migration;
mod client_gateway;
mod code_intelligence;
mod completion_coordinator;
mod completion_engine;
mod context_compression;
mod context_engine;
mod delegation_engine;
mod execution;
mod execution_store;
mod extension_manager;
mod extension_service;
mod guidance_policy;
mod harness;
mod harness_service;
mod harness_v2_router;
mod hook_manager;
mod host_data;
mod host_router;
mod host_server;
mod metadata_store;
mod native_pi_manager;
mod orchestration;
mod orchestration_service;
mod pi_auth_sync;
mod pi_manager;
mod pi_rpc_bridge;
mod remote_auth;
mod resource_sampler;
mod runtime_coordinator;
mod runtime_lifecycle;
mod runtime_registry;
mod runtime_spine;
mod safe_files;
mod secrets;
mod session_kernel;
mod settings_store;
mod task_control;
mod task_experience_service;
mod work_manager;

use account_binding::AccountBindingStore;
use account_import::AccountImportService;
use account_vault::AccountVault;
use acp_adapter::AcpAdapter;
use broker_ws::BrokerWs;
use capability::CapabilityTier;
use capability_service::{CapabilityService, EffectiveSource};
use chat_backup::{BackupSelectionFlags, ChatBackupService};
use chat_migration::ChatMigrationService;
use client_gateway::{ClientGateway, ClientHello, SharedClientFacts, SharedSnapshotSource};
use code_intelligence::CodeIntelligence;
use completion_coordinator::CompletionCoordinator;
use context_compression::ContextCompressionService;
use context_engine::ContextEngine;
use delegation_engine::{DelegationEngine, DelegationOptions};
use execution::TaskKind;
use extension_manager::ExtensionManager;
use extension_service::{
    DapLaunchConfig, DiagnosticFinding, ExtensionManifest, ExtensionScope, ExternalSource,
    ManagedCatalogComponent, ManagedSkill, ProjectAdapter, RegressionMetrics, RegressionScenario,
};
use guidance_policy::{GuidanceMode, GuidancePolicy, GuidanceRequest, ModelGuidanceProfile};
use harness_service::HarnessService;
use harness_v2_router::HarnessV2Router;
use hook_manager::HookManager;
use host_server::HostServer;
use metadata_store::MetadataStore;
use native_pi_manager::NativePiManager;
use orchestration::{RoutingEvaluations, SubagentModelPolicy, TaskGraph};
use orchestration_service::{DelegationRequest, OrchestrationService, SubagentPolicyConfiguration};
use pi_auth_sync::PiAuthSynchronizer;
use pi_manager::{
    locked_pi_version, wait_for_endpoint, wait_for_health as wait_for_pi_health, PiManager,
};
use picode::conversation_control::{
    ActivityState, Authorization, ClientIdentity, ConversationControl,
};
use picode::core_locator::{remove_owned_locator, write_locator, CoreLocator, CORE_LOCATOR_FILE};
use remote_auth::RemoteAuth;
use runtime_coordinator::RuntimeTarget;
use runtime_spine::RuntimeSpine;
use secrets::{SecretReference, SecretStore};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use task_control::TaskControl;
use task_experience_service::{
    AccountSelection, CreateTask, TaskExperienceService, TaskTarget, TaskTransition,
};
use tauri::image::Image;
#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_dialog::MessageDialogKind;
use work_manager::WorkManager;
use zeroize::Zeroize;

type PiManagerState = Arc<PiManager>;
type BrokerWsState = Arc<BrokerWs>;
type NativePiManagerState = NativePiManager;
type TaskControlState = Arc<Mutex<TaskControl>>;
type TaskExperienceState = Arc<TaskExperienceService>;
type CapabilityServiceState = Arc<Mutex<CapabilityService>>;
type OrchestrationServiceState = Arc<OrchestrationService>;
type ExtensionServiceState = Arc<ExtensionManager>;
type SecretStoreState = Arc<Mutex<SecretStore>>;
type RuntimeSpineState = Arc<Mutex<RuntimeSpine>>;
type AcpAdapterState = Arc<AcpAdapter>;
type WorkManagerState = Arc<WorkManager>;
type ContextEngineState = Arc<ContextEngine>;
type CodeIntelligenceState = Arc<CodeIntelligence>;
type HookManagerState = Arc<HookManager>;
type SessionKernelState = Arc<Mutex<session_kernel::SessionKernel>>;
type CompletionCoordinatorState = Arc<CompletionCoordinator>;
type ClientGatewayState = Arc<ClientGateway>;
type ConversationControlState = Arc<Mutex<ConversationControl>>;

struct CoreLocatorPath(PathBuf);

struct CoreSnapshotSource {
    manager: Arc<PiManager>,
    broker: Arc<BrokerWs>,
    accounts: Arc<AccountImportService>,
    sessions: SessionKernelState,
    task_control: TaskControlState,
    orchestration: OrchestrationServiceState,
    extensions: ExtensionServiceState,
    work: WorkManagerState,
    runtime: RuntimeSpineState,
    conversation_control: ConversationControlState,
}

impl SharedSnapshotSource for CoreSnapshotSource {
    fn collect(&self) -> Result<SharedClientFacts, String> {
        let tasks = {
            let control = self
                .task_control
                .lock()
                .map_err(|_| "Task Control lock is poisoned".to_owned())?;
            let mut value = serde_json::to_value(control.snapshot())
                .map_err(|error| format!("Cannot encode Task snapshot: {error}"))?;
            if let Some(object) = value.as_object_mut() {
                object.insert(
                    "orchestration".into(),
                    serde_json::to_value(self.orchestration.snapshot()).map_err(|error| {
                        format!("Cannot encode Orchestration snapshot: {error}")
                    })?,
                );
            }
            value
        };
        Ok(SharedClientFacts {
            accounts: serde_json::to_value(self.accounts.list_accounts()?)
                .map_err(|error| format!("Cannot encode account summaries: {error}"))?,
            sessions: {
                let sessions = self
                    .sessions
                    .lock()
                    .map_err(|_| "Session Kernel lock is poisoned".to_owned())?;
                serde_json::to_value(sessions.list(false))
                    .map_err(|error| format!("Cannot encode session summaries: {error}"))?
            },
            live_chats: serde_json::to_value(self.broker.live_chat_routes())
                .map_err(|error| format!("Cannot encode live chat routes: {error}"))?,
            tasks,
            extensions: serde_json::to_value(self.extensions.snapshot())
                .map_err(|error| format!("Cannot encode Extension snapshot: {error}"))?,
            work: serde_json::to_value(self.work.snapshot()?)
                .map_err(|error| format!("Cannot encode Work snapshot: {error}"))?,
            runtime: {
                let runtime = self
                    .runtime
                    .lock()
                    .map_err(|_| "Runtime Spine lock is poisoned".to_owned())?;
                serde_json::to_value(runtime.snapshot())
                    .map_err(|error| format!("Cannot encode runtime snapshot: {error}"))?
            },
            conversation_control: {
                let mut control = self
                    .conversation_control
                    .lock()
                    .map_err(|_| "Conversation Control lock is poisoned".to_owned())?;
                serde_json::to_value(control.snapshot(unix_millis())).map_err(|error| {
                    format!("Cannot encode Conversation Control snapshot: {error}")
                })?
            },
            packages: self.manager.list_configured_package_sources()?,
        })
    }
}

#[derive(Clone)]
struct ChatDataServices {
    migration: Arc<ChatMigrationService>,
    backup: Arc<ChatBackupService>,
    compression: Arc<ContextCompressionService>,
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

/// Create a new session within the current workspace (RPC command to existing pi)
fn new_session_core(port: u16, manager: &PiManager, broker: &BrokerWs) -> Result<(), String> {
    let result = manager.send_rpc(port, serde_json::json!({ "type": "new_session" }));
    if result.is_ok() {
        broker.set_active_port(port);
    }
    result
}

/// Resume (switch to) an existing session file within the current workspace
fn switch_session_core(
    port: u16,
    session_path: &str,
    manager: &PiManager,
    broker: &BrokerWs,
) -> Result<(), String> {
    let result = manager.send_rpc(
        port,
        serde_json::json!({ "type": "switch_session", "sessionPath": session_path }),
    );
    if result.is_ok() {
        broker.register_session(port, session_path);
    }
    result
}

/// Fork the current session from a specific user entry within the workspace.
/// pi handles `fork` natively over its RPC channel (it replaces the active
/// session in-process and emits `session_start { reason: "fork" }`), so we just
/// forward the command to the existing pi like new_session/switch_session do.
/// The process/port is unchanged (fork is in-place), so the active port stays.
fn fork_session_core(
    port: u16,
    entry_id: &str,
    manager: &PiManager,
    broker: &BrokerWs,
) -> Result<(), String> {
    let result = manager.send_rpc(
        port,
        serde_json::json!({ "type": "fork", "entryId": entry_id }),
    );
    if result.is_ok() {
        broker.set_active_port(port);
    }
    result
}

/// Clone the complete current session at its active leaf. Pi exposes this as
/// `clone`, which differs from the message-level `fork`: no user entry is
/// discarded, so the taskbar action preserves the whole conversation.
fn clone_session_core(port: u16, manager: &PiManager, broker: &BrokerWs) -> Result<(), String> {
    let result = manager.send_rpc(port, serde_json::json!({ "type": "clone" }));
    if result.is_ok() {
        broker.set_active_port(port);
    }
    result
}

/// Open a workspace directory by spawning a separate pi process.
/// When `open_window` is true (default) a new OS window is opened for the new pi.
/// When false, the pi process is spawned headlessly and the caller is expected to
/// navigate the current window to the returned port.
#[allow(clippy::too_many_arguments)]
async fn open_workspace_core(
    cwd: &str,
    session_path: Option<&str>,
    force_new_session: bool,
    open_window: bool,
    wait_for_health: bool,
    wait_for_sessions: bool,
    manager: &PiManager,
    broker: &BrokerWs,
    app: Option<&AppHandle>,
) -> Result<u16, String> {
    let started_at = Instant::now();
    let port = manager.next_port();
    let spawn_started_at = Instant::now();
    manager.spawn(cwd, port, session_path)?;
    log::info!(
        "[pi-desktop] open_workspace spawn complete: port={} cwd={} elapsed_ms={}",
        port,
        cwd,
        spawn_started_at.elapsed().as_millis()
    );

    if wait_for_health {
        // Brief pause then check if the process crashed immediately (fast-fail
        // instead of waiting the full 30-second health timeout).
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if let Some(status) = manager.check_exited(port) {
            return Err(format!(
                "Pi process exited immediately (port {}, status: {}). \
                 Check stderr for crash details.",
                port, status
            ));
        }

        let health_started_at = Instant::now();
        match wait_for_pi_health(port, 30).await {
            Ok(_) => {}
            Err(e) => {
                let extra = if let Some(status) = manager.check_exited(port) {
                    format!(" Process has exited with status: {}.", status)
                } else {
                    String::new()
                };
                return Err(format!("{}{}", e, extra));
            }
        }
        log::info!(
            "[pi-desktop] open_workspace health ready: port={} elapsed_ms={}",
            port,
            health_started_at.elapsed().as_millis()
        );
    }
    // Register with the broker only after the process is confirmed reachable
    // (or, when health checks are skipped, right before we start driving it).
    // Registering earlier would start the upstream reconnect loop against a
    // port that may never come up, leaking a 750ms-interval reconnect spinner
    // on any spawn failure path that returns without unregistering.
    broker.register_session(port, session_path.unwrap_or(""));
    if force_new_session {
        let new_session_started_at = Instant::now();
        manager.send_rpc(port, serde_json::json!({ "type": "new_session" }))?;
        log::info!(
            "[pi-desktop] open_workspace new_session sent: port={} elapsed_ms={}",
            port,
            new_session_started_at.elapsed().as_millis()
        );
    }
    if wait_for_sessions {
        let sessions_started_at = Instant::now();
        match wait_for_endpoint(port, "/api/sessions", 4).await {
            Ok(_) => log::info!(
                "[pi-desktop] open_workspace sessions ready: port={} elapsed_ms={}",
                port,
                sessions_started_at.elapsed().as_millis()
            ),
            Err(err) => log::warn!(
                "[pi-desktop] open_workspace sessions warmup skipped: port={} error={}",
                port,
                err
            ),
        }
    }
    if open_window {
        if let Some(app) = app {
            open_workspace_window(app, port, &broker.url())?;
        } else {
            log::warn!(
                "[pi-desktop] open_workspace requested a window but no AppHandle is available (port {})",
                port
            );
        }
    }
    log::info!(
        "[pi-desktop] open_workspace complete: port={} total_elapsed_ms={}",
        port,
        started_at.elapsed().as_millis()
    );
    Ok(port)
}

/// Stop (kill) a pi instance
fn stop_instance_core(port: u16, manager: &PiManager, broker: &BrokerWs) {
    manager.kill(port);
    broker.unregister_port(port);
}

/// Spawn (or reuse) a dedicated pi process for a specific session file so it
/// can run concurrently with the workspace's primary process.
/// Returns the port the dedicated process is listening on.
async fn spawn_session_process_core(
    workspace_port: u16,
    session_file: &str,
    cwd: &str,
    manager: &PiManager,
    broker: &BrokerWs,
) -> Result<u16, String> {
    let port = manager.spawn_session_dedicated(workspace_port, session_file.to_string(), cwd)?;
    if let Err(error) = wait_for_pi_health(port, 90).await {
        // A timed-out child must not remain cached as the dedicated runtime for
        // this session. Otherwise every later selection reuses the same hung
        // process and the chat can never recover without restarting Picode.
        manager.kill_session_dedicated(session_file);
        return Err(error);
    }
    // Use track_background_session instead of register_session so the dedicated
    // process is routable by session ID but does NOT become the default
    // active_port — that would silently misroute commands from the session the
    // user is currently viewing.
    broker.track_background_session(port, session_file);
    Ok(port)
}

/// Native folder picker dialog
async fn pick_folder_core(app: &AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let result = path.map(|p| match p {
            tauri_plugin_fs::FilePath::Path(pb) => pb.to_string_lossy().into_owned(),
            tauri_plugin_fs::FilePath::Url(url) => url.to_string(),
        });
        let _ = tx.send(result);
    });
    rx.await.ok().flatten()
}

async fn pick_backup_save_core(app: &AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Picode Chat Backup", &["picot-backup"])
        .set_file_name("picot-chat-backup.picot-backup")
        .save_file(move |path| {
            let result = path.map(|path| match path {
                tauri_plugin_fs::FilePath::Path(path) => path.to_string_lossy().into_owned(),
                tauri_plugin_fs::FilePath::Url(url) => url.to_string(),
            });
            let _ = tx.send(result);
        });
    rx.await.ok().flatten()
}

async fn pick_backup_open_core(app: &AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Picode Chat Backup", &["picot-backup"])
        .pick_file(move |path| {
            let result = path.map(|path| match path {
                tauri_plugin_fs::FilePath::Path(path) => path.to_string_lossy().into_owned(),
                tauri_plugin_fs::FilePath::Url(url) => url.to_string(),
            });
            let _ = tx.send(result);
        });
    rx.await.ok().flatten()
}

async fn pick_context_save_core(app: &AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Picode Compressed Context", &["picot-context"])
        .set_file_name("picot-compressed-context.picot-context")
        .save_file(move |path| {
            let result = path.map(|path| match path {
                tauri_plugin_fs::FilePath::Path(path) => path.to_string_lossy().into_owned(),
                tauri_plugin_fs::FilePath::Url(url) => url.to_string(),
            });
            let _ = tx.send(result);
        });
    rx.await.ok().flatten()
}

/// A launchable external app target (editor / terminal / file manager).
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AppTarget {
    id: String,
    label: String,
    /// "app" → launched via `open -a <app_name>` (macOS)
    /// "command" → launched via the `command` binary (cross-platform CLI)
    /// "finder" → reveal in the OS file manager
    kind: String,
    app_name: Option<String>,
    command: Option<String>,
}

#[cfg(target_os = "macos")]
fn macos_installed_app_names() -> std::collections::HashSet<String> {
    use std::collections::HashSet;
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/Applications/Utilities"),
        PathBuf::from("/System/Applications/Utilities"),
    ];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Applications"));
    }
    let mut names = HashSet::new();
    for root in roots {
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if path.extension().and_then(|ext| ext.to_str()) != Some("app") {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                names.insert(stem.to_ascii_lowercase());
            }
        }
    }
    names
}

/// List the external apps Picode can open a project in. On macOS this is
/// filtered down to the apps actually installed; on other platforms it falls
/// back to a fixed list of CLI launchers (resolved against PATH at open time).
fn list_installed_apps_core() -> Vec<AppTarget> {
    // (id, label, [candidate .app bundle names], cli command)
    let candidates: [(&str, &str, &[&str], &str); 6] = [
        ("vscode", "VS Code", &["Visual Studio Code", "Code"], "code"),
        ("cursor", "Cursor", &["Cursor"], "cursor"),
        (
            "webstorm",
            "WebStorm",
            &["WebStorm", "WebStorm EAP"],
            "webstorm",
        ),
        ("zed", "Zed", &["Zed"], "zed"),
        ("terminal", "Terminal", &["Terminal", "iTerm", "Warp"], ""),
        ("ghostty", "Ghostty", &["Ghostty"], ""),
    ];

    #[cfg(target_os = "macos")]
    {
        let installed = macos_installed_app_names();
        let mut targets = Vec::new();
        for (id, label, bundle_names, _cmd) in candidates {
            if let Some(app_name) = bundle_names
                .iter()
                .find(|name| installed.contains(&name.to_ascii_lowercase()))
            {
                targets.push(AppTarget {
                    id: id.to_string(),
                    label: label.to_string(),
                    kind: "app".to_string(),
                    app_name: Some((*app_name).to_string()),
                    command: None,
                });
            }
        }
        targets.push(AppTarget {
            id: "finder".to_string(),
            label: "Finder".to_string(),
            kind: "finder".to_string(),
            app_name: None,
            command: None,
        });
        targets
    }

    #[cfg(not(target_os = "macos"))]
    {
        let mut targets: Vec<AppTarget> = candidates
            .iter()
            .filter(|(_, _, _, cmd)| !cmd.is_empty())
            .map(|(id, label, _, cmd)| AppTarget {
                id: id.to_string(),
                label: label.to_string(),
                kind: "command".to_string(),
                app_name: None,
                command: Some(cmd.to_string()),
            })
            .collect();
        targets.push(AppTarget {
            id: "finder".to_string(),
            label: "File Manager".to_string(),
            kind: "finder".to_string(),
            app_name: None,
            command: None,
        });
        targets
    }
}

/// Open a project directory in an external app (editor / terminal / file
/// manager). Mirrors the launch strategy used elsewhere in the workspace:
///   - `app_name` → `open -a <app_name> <path>` on macOS
///   - `command`  → run the CLI binary with the path as the argument
///   - neither    → reveal the path in the OS file manager
fn open_in_app_core(
    path: &str,
    app_name: Option<&str>,
    command: Option<&str>,
) -> Result<(), String> {
    use std::process::Command;

    let trimmed_path = path.trim();
    if trimmed_path.is_empty() {
        return Err("Missing path".to_string());
    }

    // CLI command launch (cross-platform): `code <path>`, `cursor <path>`, …
    if let Some(command) = command.map(|c| c.trim()).filter(|c| !c.is_empty()) {
        let status = Command::new(command)
            .arg(trimmed_path)
            .status()
            .map_err(|e| format!("Failed to launch `{command}`: {e}"))?;
        if !status.success() {
            return Err(format!("`{command}` exited with status {status}"));
        }
        return Ok(());
    }

    // App launch by bundle name (macOS only).
    if let Some(app_name) = app_name.map(|a| a.trim()).filter(|a| !a.is_empty()) {
        #[cfg(target_os = "macos")]
        {
            let status = Command::new("open")
                .arg("-a")
                .arg(app_name)
                .arg(trimmed_path)
                .status()
                .map_err(|e| format!("Failed to open `{app_name}`: {e}"))?;
            if !status.success() {
                return Err(format!("`{app_name}` failed to open (status {status})"));
            }
            return Ok(());
        }
        #[cfg(not(target_os = "macos"))]
        {
            let status = Command::new(app_name)
                .arg(trimmed_path)
                .status()
                .map_err(|e| format!("Failed to open `{app_name}`: {e}"))?;
            if !status.success() {
                return Err(format!("`{app_name}` failed to open (status {status})"));
            }
            return Ok(());
        }
    }

    // Fallback: reveal in the OS file manager.
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(trimmed_path).status();
    #[cfg(target_os = "windows")]
    let status = Command::new("explorer").arg(trimmed_path).status();
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let status = Command::new("xdg-open").arg(trimmed_path).status();

    status
        .map_err(|e| format!("Failed to reveal path: {e}"))
        .and_then(|s| {
            if s.success() {
                Ok(())
            } else {
                Err(format!("File manager exited with status {s}"))
            }
        })
}

fn open_devtools_core(port: u16, app: &AppHandle) -> Result<(), String> {
    let label = format!("workspace-{}", port);
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("No workspace window found for port {}", port))?;
    window.open_devtools();
    Ok(())
}

/// Open a URL in the user's default system browser. Uses the platform opener
/// (`open` / `start` / `xdg-open`) directly so we don't depend on the
/// deprecated shell-plugin `open`.
fn open_external_core(url: &str) -> Result<(), String> {
    use std::process::Command;

    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("Missing URL".to_string());
    }

    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(trimmed).status();
    #[cfg(target_os = "windows")]
    let status = Command::new("cmd")
        .args(["/C", "start", "", trimmed])
        .status();
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let status = Command::new("xdg-open").arg(trimmed).status();

    status
        .map_err(|e| format!("Failed to open URL: {e}"))
        .and_then(|s| {
            if s.success() {
                Ok(())
            } else {
                Err(format!("Opener exited with status {s}"))
            }
        })
}

// ─── Window helpers ───────────────────────────────────────────────────────────

fn encode_query_value(value: &str) -> String {
    // Encode everything that isn't an unreserved URL character so the value is
    // safe in a query string regardless of its contents.
    percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string()
}

fn open_workspace_window(app: &AppHandle, port: u16, broker_ws_url: &str) -> Result<(), String> {
    let label = format!("workspace-{}", port);
    let url = format!(
        "http://localhost:{}?brokerWs={}",
        port,
        encode_query_value(broker_ws_url)
    );
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .map_err(|e| format!("Failed to load window icon: {}", e))?;

    let builder =
        WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url.parse().unwrap()))
            .title("Picode")
            .inner_size(1300.0, 860.0)
            .min_inner_size(800.0, 600.0)
            .icon(icon)
            .map_err(|e| e.to_string())?;

    // macOS: extend WebView into title bar; traffic lights float on top.
    #[cfg(target_os = "macos")]
    let builder = builder
        .decorations(true)
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true);

    // Non-macOS: keep standard native decorations.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(true);

    builder.build().map_err(|e| e.to_string())?;

    Ok(())
}

fn open_chat_context_window(
    app: &AppHandle,
    port: u16,
    broker_ws_url: &str,
    scan_id: &str,
    candidate_id: &str,
    title: &str,
) -> Result<(), String> {
    let scan_label = scan_id
        .chars()
        .filter(|char| char.is_ascii_alphanumeric())
        .take(8);
    let candidate_label = candidate_id
        .chars()
        .filter(|char| char.is_ascii_alphanumeric())
        .take(12);
    let label = format!(
        "chat-context-{}-{}",
        scan_label.collect::<String>(),
        candidate_label.collect::<String>()
    );
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let url = format!(
        "http://localhost:{port}/chat-context-viewer.html?scanId={}&candidateId={}&brokerWs={}",
        encode_query_value(scan_id),
        encode_query_value(candidate_id),
        encode_query_value(broker_ws_url),
    );
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .map_err(|error| format!("Failed to load window icon: {error}"))?;
    let window_title = if title.trim().is_empty() {
        "Picode · Chat context".to_string()
    } else {
        format!("Picode · {title}")
    };
    let builder = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::External(
            url.parse()
                .map_err(|error| format!("Invalid chat context URL: {error}"))?,
        ),
    )
    .title(window_title)
    .inner_size(1080.0, 800.0)
    .min_inner_size(680.0, 520.0)
    .icon(icon)
    .map_err(|error| error.to_string())?;

    #[cfg(target_os = "macos")]
    let builder = builder
        .decorations(true)
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(true);
    builder.build().map_err(|error| error.to_string())?;
    Ok(())
}

fn open_native_workspace_window(
    app: &AppHandle,
    host_origin: &str,
    target: &RuntimeTarget,
) -> Result<(), String> {
    let label = format!("native-workspace-{}", target.workspace_id);
    let url = format!(
        "{}/app/workspaces/{}/sessions/{}",
        host_origin, target.workspace_id, target.session_id
    );
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .map_err(|error| format!("Failed to load window icon: {error}"))?;
    let builder = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::External(
            url.parse()
                .map_err(|error| format!("Invalid native Host URL: {error}"))?,
        ),
    )
    .title("Picode")
    .inner_size(1300.0, 860.0)
    .min_inner_size(800.0, 600.0)
    .icon(icon)
    .map_err(|error| error.to_string())?;

    #[cfg(target_os = "macos")]
    let builder = builder
        .decorations(true)
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(true);
    builder.build().map_err(|error| error.to_string())?;
    Ok(())
}

fn open_bootstrap_window(app: &AppHandle, startup_error: &str) -> Result<(), String> {
    let label = "bootstrap";
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .map_err(|e| format!("Failed to load window icon: {}", e))?;
    let encoded_error = startup_error
        .replace('&', "%26")
        .replace(' ', "%20")
        .replace('\n', "%0A");
    let url = format!("bootstrap.html?startupError={}", encoded_error);

    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title("Picode")
        .inner_size(900.0, 640.0)
        .min_inner_size(700.0, 480.0)
        .icon(icon)
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    let builder = builder
        .decorations(true)
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true);

    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(true);

    builder.build().map_err(|e| e.to_string())?;

    Ok(())
}

fn canonical_if_exists(dir: PathBuf) -> Option<PathBuf> {
    if dir.join("index.html").exists() {
        Some(fs::canonicalize(&dir).unwrap_or(dir))
    } else {
        None
    }
}

fn resolve_static_dir(
    resource_dir: Option<PathBuf>,
    workspace_public: PathBuf,
    current_dir: Option<PathBuf>,
    debug_assertions: bool,
) -> PathBuf {
    let bundled_public = resource_dir.as_ref().map(|dir| dir.join("public"));
    let current_public = current_dir.unwrap_or_default().join("public");

    if debug_assertions {
        if let Some(dir) = canonical_if_exists(workspace_public) {
            return dir;
        }
        if let Some(dir) = canonical_if_exists(current_public.clone()) {
            return dir;
        }
        return current_public;
    }

    if let Some(dir) = bundled_public.and_then(canonical_if_exists) {
        return dir;
    }

    resource_dir
        .map(|dir| dir.join("public"))
        .unwrap_or_else(|| PathBuf::from("public"))
}

fn find_static_dir(app: &tauri::App) -> PathBuf {
    resolve_static_dir(
        app.path().resource_dir().ok(),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("public"),
        std::env::current_dir().ok(),
        cfg!(debug_assertions),
    )
}

#[cfg(test)]
mod tests {
    use super::{provider_model_urls, resolve_static_dir};
    use crate::runtime_lifecycle::extract_subagent_candidate;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("pi-studio-{label}-{suffix}"))
    }

    #[test]
    fn debug_build_prefers_workspace_public_over_bundled_copy() {
        let root = unique_temp_dir("static-dir-debug");
        let workspace_public = root.join("workspace").join("public");
        let bundled_public = root.join("bundled").join("public");

        fs::create_dir_all(&workspace_public).unwrap();
        fs::create_dir_all(&bundled_public).unwrap();
        fs::write(workspace_public.join("index.html"), "workspace").unwrap();
        fs::write(bundled_public.join("index.html"), "bundled").unwrap();

        let resolved = resolve_static_dir(
            Some(root.join("bundled")),
            workspace_public.clone(),
            Some(root.join("workspace")),
            true,
        );

        assert_eq!(resolved, fs::canonicalize(&workspace_public).unwrap());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn builds_compatible_openai_and_anthropic_model_discovery_urls() {
        let openai =
            provider_model_urls("https://api.deepseek.example/v1", "openai-completions").unwrap();
        assert_eq!(openai[0].as_str(), "https://api.deepseek.example/v1/models");

        let anthropic =
            provider_model_urls("https://claude.example", "anthropic-messages").unwrap();
        assert_eq!(anthropic[0].as_str(), "https://claude.example/v1/models");
        assert_eq!(anthropic[1].as_str(), "https://claude.example/models");
    }

    #[test]
    fn rejects_model_discovery_urls_that_embed_credentials() {
        assert!(
            provider_model_urls("https://user:secret@api.example/v1", "openai-completions")
                .is_err()
        );
    }

    #[test]
    fn subagent_candidate_extracts_only_the_last_bounded_assistant_text() {
        let result = extract_subagent_candidate(&serde_json::json!({
            "event": {
                "messages": [
                    { "role": "user", "content": "ignore me" },
                    { "role": "assistant", "content": [{ "type": "text", "text": "candidate" }] }
                ]
            }
        }));
        assert_eq!(result, "candidate");
    }
}

fn prepare_managed_default_workspace(app_data_dir: &Path) -> Result<String, String> {
    let workspace = app_data_dir.join("scratch").join("default");
    fs::create_dir_all(&workspace).map_err(|error| {
        format!(
            "Cannot create Picode's managed default workspace at {}: {error}",
            workspace.display()
        )
    })?;
    Ok(workspace.to_string_lossy().into_owned())
}

fn select_fresh_startup_target(managed_default_cwd: String) -> (String, Option<String>) {
    (managed_default_cwd, None)
}

fn native_runtime_enabled() -> bool {
    cfg!(debug_assertions)
        && std::env::var("PICOT_RUNTIME").is_ok_and(|value| value.eq_ignore_ascii_case("native"))
}

fn setup_native_runtime(app: &mut tauri::App, static_dir: PathBuf) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve Picode app data directory: {error}"))?;
    let (cwd, session_path) =
        select_fresh_startup_target(prepare_managed_default_workspace(&app_data_dir)?);
    let metadata_path = app_data_dir.join("picot.sqlite3");
    let mut metadata = MetadataStore::open(&metadata_path)?;
    let workspace_id = metadata.workspace_id_for_path(std::path::Path::new(&cwd))?;
    let session_id = format!("temporary-{}", uuid::Uuid::new_v4().simple());
    let target = RuntimeTarget::new(
        workspace_id,
        session_id,
        format!("instance-{}", uuid::Uuid::new_v4().simple()),
    );
    let resolver = PiManager::new(static_dir.clone());
    let launch = resolver.native_launch_spec(&cwd, session_path.as_deref())?;
    let runtimes = NativePiManager::new(256);
    let remote_auth = Arc::new(Mutex::new(RemoteAuth::new(metadata)));
    let host = tauri::async_runtime::block_on(HostServer::start_with_workspaces(
        static_dir,
        runtimes.clone(),
        remote_auth,
        std::collections::HashMap::from([(target.workspace_id.clone(), PathBuf::from(&cwd))]),
    ))?;
    runtimes.spawn(target.clone(), launch)?;
    if let Err(error) = open_native_workspace_window(app.handle(), host.origin(), &target) {
        runtimes.stop_all();
        return Err(error);
    }
    log::info!(
        "[picot-native] started workspace_id={} session_id={} instance_id={} origin={}",
        target.workspace_id,
        target.session_id,
        target.instance_id,
        host.origin()
    );
    app.manage(runtimes);
    app.manage(host);
    Ok(())
}

#[tauri::command]
async fn cmd_retry_startup(
    app: AppHandle,
    manager: State<'_, PiManagerState>,
    broker: State<'_, BrokerWsState>,
) -> Result<u16, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve Picode app data directory: {error}"))?;
    let (cwd, session_path) =
        select_fresh_startup_target(prepare_managed_default_workspace(&app_data_dir)?);
    // Mirror the main setup hook: never adopt a port we don't own. Always
    // claim a fresh one so the resulting pi is driveable via our PiManager.
    let initial_port = manager.next_port();
    manager.spawn(&cwd, initial_port, session_path.as_deref())?;
    broker.register_session(initial_port, session_path.as_deref().unwrap_or(""));
    if let Err(e) = wait_for_pi_health(initial_port, 30).await {
        // Tear down the upstream reconnect loop started by register_session so it
        // doesn't spin forever against a dead port every 750ms.
        broker.unregister_port(initial_port);
        return Err(e);
    }
    Ok(initial_port)
}

// ─── Auto-updater cores ─────────────────────────────────────────────────────

/// Check GitHub for a newer release. Returns update metadata as JSON, or
/// `Value::Null` when already up to date. Mirrors the shape the old JS
/// `checkForUpdate` returned so the frontend renderer is unchanged.
async fn check_for_update_core(app: &AppHandle) -> Result<Value, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => Ok(serde_json::json!({
            "available": true,
            "version": update.version,
            "currentVersion": update.current_version,
            "date": update.date.map(|d| d.to_string()),
            "notes": update.body.clone().unwrap_or_default(),
        })),
        None => Ok(Value::Null),
    }
}

/// Download + install the available update, streaming progress frames through
/// `progress` (broker → client). Replaces the Tauri `Channel` the JS used.
async fn download_and_install_update_core(
    app: &AppHandle,
    progress: broker_ws::ProgressSink,
) -> Result<Value, String> {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Arc;
    use tauri_plugin_updater::UpdaterExt;

    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => update,
        None => return Ok(serde_json::json!({ "installed": false, "reason": "no_update" })),
    };
    let version = update.version.clone();

    let downloaded = Arc::new(AtomicU64::new(0));
    let started = Arc::new(AtomicBool::new(false));
    let chunk_sink = progress.clone();
    let dl = downloaded.clone();
    let started_flag = started.clone();
    let finish_sink = progress.clone();

    update
        .download_and_install(
            move |chunk_length, content_length| {
                let total =
                    dl.fetch_add(chunk_length as u64, Ordering::Relaxed) + chunk_length as u64;
                if !started_flag.swap(true, Ordering::Relaxed) {
                    chunk_sink(serde_json::json!({
                        "phase": "started",
                        "contentLength": content_length,
                    }));
                }
                chunk_sink(serde_json::json!({
                    "phase": "progress",
                    "downloaded": total,
                    "contentLength": content_length,
                }));
            },
            move || {
                finish_sink(serde_json::json!({ "phase": "finished" }));
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({ "installed": true, "version": version }))
}

// ─── Broker control handler ──────────────────────────────────────────────────

/// Resolve a control command's target port: prefer the explicit port from the
/// request, else fall back to the broker's active port.
pub(crate) fn resolve_control_port(port: Option<u16>, broker: &BrokerWs) -> Result<u16, String> {
    if let Some(port) = port {
        return Ok(port);
    }
    // No explicit target. Falling back to the global active_port is only safe
    // when a single pi process is live; with several (multi-window) it belongs
    // to whichever window registered last, so a lifecycle op (new_session /
    // switch_session / stop_instance) could land on the wrong workspace (F4).
    if broker.live_upstream_count() > 1 {
        return Err(
            "Ambiguous target: multiple pi instances are running; a port must be specified"
                .to_string(),
        );
    }
    broker
        .active_port()
        .ok_or_else(|| "No active pi instance".to_string())
}

fn provider_model_urls(base_url: &str, api: &str) -> Result<Vec<reqwest::Url>, String> {
    let mut base = reqwest::Url::parse(base_url.trim())
        .map_err(|_| "Base URL must be a valid HTTP or HTTPS URL".to_string())?;
    if !matches!(base.scheme(), "http" | "https")
        || base.host_str().is_none()
        || !base.username().is_empty()
        || base.password().is_some()
    {
        return Err("Base URL must be a valid HTTP or HTTPS URL without credentials".to_string());
    }
    base.set_query(None);
    base.set_fragment(None);
    let path = base.path().trim_end_matches('/');
    if path.ends_with("/models") || path == "models" {
        return Ok(vec![base]);
    }

    let make_url = |suffix: &str| {
        let mut url = base.clone();
        let prefix = base.path().trim_end_matches('/');
        url.set_path(&format!("{prefix}/{suffix}"));
        url
    };
    let direct = make_url("models");
    if path.ends_with("/v1") || path.ends_with("/v1beta") {
        return Ok(vec![direct]);
    }
    let versioned = make_url("v1/models");
    if api == "anthropic-messages" {
        Ok(vec![versioned, direct])
    } else {
        Ok(vec![direct, versioned])
    }
}

async fn discover_provider_models(
    base_url: &str,
    api: &str,
    api_key: &str,
) -> Result<Vec<String>, String> {
    if !matches!(
        api,
        "openai-completions" | "openai-responses" | "anthropic-messages"
    ) {
        return Err("Unsupported custom provider API format".to_string());
    }
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("API key is required to load the model list".to_string());
    }
    let urls = provider_model_urls(base_url, api)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("Cannot prepare model discovery: {error}"))?;
    let mut last_error = "The provider did not expose a compatible model list".to_string();
    for (index, url) in urls.iter().enumerate() {
        let request = if api == "anthropic-messages" {
            client
                .get(url.clone())
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
        } else {
            client.get(url.clone()).bearer_auth(api_key)
        };
        let response = request
            .send()
            .await
            .map_err(|error| format!("Cannot connect to the provider: {error}"))?;
        let status = response.status();
        if !status.is_success() {
            last_error = format!("The provider returned HTTP {status} while loading models");
            if status == reqwest::StatusCode::NOT_FOUND && index + 1 < urls.len() {
                continue;
            }
            break;
        }
        if response
            .content_length()
            .is_some_and(|length| length > 2 * 1024 * 1024)
        {
            return Err("The provider model list is unexpectedly large".to_string());
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("Cannot read the provider model list: {error}"))?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err("The provider model list is unexpectedly large".to_string());
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "The provider returned an invalid JSON model list".to_string())?;
        let entries = value
            .get("data")
            .and_then(Value::as_array)
            .or_else(|| value.get("models").and_then(Value::as_array))
            .ok_or_else(|| "The provider response does not contain a model array".to_string())?;
        let mut seen = std::collections::HashSet::new();
        let models: Vec<String> = entries
            .iter()
            .filter_map(|entry| {
                entry
                    .get("id")
                    .and_then(Value::as_str)
                    .or_else(|| entry.as_str())
            })
            .map(str::trim)
            .filter(|id| !id.is_empty() && id.len() <= 256)
            .filter(|id| seen.insert((*id).to_string()))
            .take(500)
            .map(str::to_string)
            .collect();
        if models.is_empty() {
            return Err("The provider returned an empty model list".to_string());
        }
        return Ok(models);
    }
    Err(last_error)
}

// Account handoff crosses binding, runtime, task, and extension ownership by
// design; each dependency is explicit so unrelated providers remain isolated.
#[allow(clippy::too_many_arguments)]
fn suspend_bound_account_tasks(
    bindings: &AccountBindingStore,
    manager: &PiManager,
    broker: &BrokerWs,
    task_control: &TaskControlState,
    extension_service: &ExtensionManager,
    logical_provider: &str,
    account_id: &str,
    replacement_account_id: Option<&str>,
) {
    let affected_tasks: std::collections::BTreeSet<String> = task_control
        .lock()
        .map(|control| {
            control
                .snapshot()
                .agent_runs
                .into_iter()
                .filter(|run| {
                    run.provider == logical_provider
                        && run.account_id == account_id
                        && !run.state.is_terminal()
                })
                .map(|run| run.task_id)
                .collect()
        })
        .unwrap_or_default();
    match bindings.suspend_account(logical_provider, account_id) {
        Ok(suspended_sessions) => {
            for session_id in suspended_sessions {
                if let Some(port) = broker.port_for_session(&session_id) {
                    if let Err(error) =
                        manager.send_rpc(port, serde_json::json!({ "type": "abort" }))
                    {
                        log::warn!(
                            "[accounts] failed to stop old-account task on port {}: {}",
                            port,
                            error
                        );
                    }
                }
            }
        }
        Err(error) => {
            // Fail closed: if persistent binding state is unavailable, stop
            // every in-flight Pi task so none can continue under another key.
            log::error!(
                "[accounts] cannot suspend old-account chats; stopping all tasks: {}",
                error
            );
            for port in manager.ports() {
                let _ = manager.send_rpc(port, serde_json::json!({ "type": "abort" }));
            }
        }
    }
    let task_result = task_control
        .lock()
        .map_err(|_| "Task Control lock is poisoned".to_owned())
        .and_then(|mut control| match replacement_account_id {
            Some(replacement) => control.handoff_account(logical_provider, account_id, replacement),
            None => control
                .deactivate_account(logical_provider, account_id)
                .map(|_| ()),
        });
    if let Err(error) = task_result {
        log::debug!(
            "[accounts] no durable Picode task required account suspension: {}",
            error
        );
    }
    for task_id in affected_tasks {
        if let Err(error) = extension_service.cancel_task_processes(&task_id) {
            log::warn!(
                "[accounts] failed to stop task extensions for {}: {}",
                task_id,
                error
            );
        }
    }
}

pub(crate) fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn install_conversation_control(
    broker: &Arc<BrokerWs>,
    conversation_control: ConversationControlState,
    session_kernel: SessionKernelState,
) {
    let disconnected = conversation_control.clone();
    broker.set_client_disconnect_observer(Arc::new(move |connection_id| {
        if let Ok(mut control) = disconnected.lock() {
            control.disconnect_connection(connection_id, unix_millis());
        }
    }));

    let activity = conversation_control.clone();
    let activity_sessions = session_kernel.clone();
    broker.set_runtime_activity_observer(Arc::new(move |session_id, event_type, at| {
        let state = match event_type {
            "agent_start"
            | "message_start"
            | "message_update"
            | "tool_execution_start"
            | "tool_execution_update"
            | "tool_execution_end"
            | "auto_compaction_start"
            | "auto_compaction_end"
            | "auto_retry_start" => Some(ActivityState::Active),
            "agent_end" => Some(ActivityState::WaitingForUser),
            "session_start" => Some(ActivityState::Idle),
            "error" | "extension_error" => Some(ActivityState::SuspectedStall),
            _ => None,
        };
        if let Some(state) = state {
            // A runtime event can arrive before any client selects the chat.
            // In that case there is no ownership fact to update yet.
            let stable_id = activity_sessions
                .lock()
                .ok()
                .and_then(|sessions| sessions.stable_chat_id(session_id))
                .unwrap_or_else(|| session_id.to_owned());
            if let Ok(mut control) = activity.lock() {
                let _ = control.record_activity(&stable_id, state, at);
            }
        }
    }));

    let authorizer_sessions = session_kernel;
    broker.set_command_authorizer(Arc::new(move |client, envelope| {
        let payload_type = envelope.pointer("/payload/type").and_then(Value::as_str);
        if !matches!(
            payload_type,
            Some(
                "prompt"
                    | "abort"
                    | "set_model"
                    | "compact"
                    | "rewind"
                    | "rename_session"
                    | "set_session_name"
                    | "delete_session"
            )
        ) {
            return Ok(());
        }
        let chat_id = envelope
            .get("sessionId")
            .and_then(Value::as_str)
            .or_else(|| {
                envelope
                    .pointer("/payload/sessionId")
                    .and_then(Value::as_str)
            });
        let Some(chat_id) = chat_id.filter(|chat_id| !chat_id.trim().is_empty()) else {
            // The first prompt of a brand-new Pi chat has no persisted session
            // identity yet. Its creator remains the only route until Pi emits
            // the canonical session ID, at which point normal fencing applies.
            return Ok(());
        };
        let stable_chat_id = authorizer_sessions
            .lock()
            .map_err(|_| "Session Kernel lock is poisoned".to_owned())?
            .stable_chat_id(chat_id)
            .unwrap_or_else(|| chat_id.to_owned());
        let generation = envelope
            .get("conversationGeneration")
            .and_then(Value::as_u64)
            .ok_or("Conversation control is required before mutating this chat")?;
        let identity =
            ClientIdentity::new(&client.client_id, &client.surface, client.connection_id)?;
        let authorization = conversation_control
            .lock()
            .map_err(|_| "Conversation Control lock is poisoned".to_owned())?
            .authorize(
                &stable_chat_id,
                &identity,
                generation,
                &client.request_id,
                unix_millis(),
            )?;
        if authorization == Authorization::Duplicate {
            return Err("Duplicate conversation mutation was already accepted".into());
        }
        Ok(())
    }));
}

#[allow(clippy::too_many_arguments)]
fn install_task_runtime_observer(
    broker: &Arc<BrokerWs>,
    manager: Arc<PiManager>,
    task_control: TaskControlState,
    extension_service: ExtensionServiceState,
    work_manager: WorkManagerState,
    session_kernel: SessionKernelState,
    runtime_spine: RuntimeSpineState,
    context_engine: ContextEngineState,
    harness_service: Arc<HarnessService>,
    hook_manager: HookManagerState,
    completion_coordinator: CompletionCoordinatorState,
) {
    runtime_lifecycle::RuntimeLifecycle::new(runtime_lifecycle::RuntimeLifecycleDeps {
        broker: broker.clone(),
        manager,
        task_control,
        extension_manager: extension_service,
        work_manager,
        session_kernel,
        runtime_spine,
        context_engine,
        harness_service,
        hook_manager,
        completion_coordinator,
    })
    .install();
}
fn notify_pi_account_reload(manager: &PiManager, broker: &BrokerWs) {
    for port in manager.ports() {
        if let Err(error) = broker
            .send_command_to_port(port, serde_json::json!({ "type": "picot_reload_accounts" }))
        {
            log::warn!(
                "[accounts] failed to notify Pi process on port {}: {}",
                port,
                error
            );
        }
    }
}

/// Build + install the async handler the broker uses to execute `broker_control`
/// requests from ANY client (desktop WebView, remote, mobile). It maps command
/// names to the same cores the rest of the app uses, so behavior is identical
/// regardless of transport. Native ops (folder picker, devtools, updater,
/// open-in-app/external) require an OS host and are only meaningful when this
/// handler is installed — which is exactly what `capabilities.native` advertises.
// This is the application composition root for the local broker. Keeping the
// owned services explicit makes its security boundary auditable.
#[allow(clippy::too_many_arguments)]
fn install_control_handler(
    broker: &Arc<BrokerWs>,
    manager: Arc<PiManager>,
    accounts: Arc<AccountImportService>,
    bindings: Arc<AccountBindingStore>,
    chat_data: ChatDataServices,
    auth_sync: Arc<PiAuthSynchronizer>,
    task_control: TaskControlState,
    task_experience: TaskExperienceState,
    harness_service: Arc<HarnessService>,
    capability_service: CapabilityServiceState,
    orchestration_service: OrchestrationServiceState,
    extension_service: ExtensionServiceState,
    runtime_spine: RuntimeSpineState,
    session_kernel: SessionKernelState,
    acp_adapter: AcpAdapterState,
    work_manager: WorkManagerState,
    context_engine: ContextEngineState,
    code_intelligence: CodeIntelligenceState,
    hook_manager: HookManagerState,
    secret_store: SecretStoreState,
    scratch_root: PathBuf,
    client_gateway: ClientGatewayState,
    conversation_control: ConversationControlState,
    app: AppHandle,
) {
    let broker_for_handler = broker.clone();
    let handler: broker_ws::ControlHandler = Arc::new(
        move |command: String,
              args: Value,
              progress: broker_ws::ProgressSink,
              client: broker_ws::ClientContext| {
            let manager = manager.clone();
            let broker = broker_for_handler.clone();
            let accounts = accounts.clone();
            let bindings = bindings.clone();
            let chat_migration = chat_data.migration.clone();
            let chat_backup = chat_data.backup.clone();
            let context_compression = chat_data.compression.clone();
            let auth_sync = auth_sync.clone();
            let task_control = task_control.clone();
            let task_experience = task_experience.clone();
            let harness_service = harness_service.clone();
            let capability_service = capability_service.clone();
            let orchestration_service = orchestration_service.clone();
            let extension_service = extension_service.clone();
            let runtime_spine = runtime_spine.clone();
            let session_kernel = session_kernel.clone();
            let acp_adapter = acp_adapter.clone();
            let work_manager = work_manager.clone();
            let context_engine = context_engine.clone();
            let code_intelligence = code_intelligence.clone();
            let hook_manager = hook_manager.clone();
            let secret_store = secret_store.clone();
            let scratch_root = scratch_root.clone();
            let client_gateway = client_gateway.clone();
            let conversation_control = conversation_control.clone();
            let app = app.clone();
            Box::pin(async move {
                let arg = |key: &str| args.get(key).cloned().unwrap_or(Value::Null);
                let arg_str = |key: &str| arg(key).as_str().map(|s| s.to_string());
                let arg_u16 = |key: &str| {
                    args.get(key)
                        .and_then(Value::as_u64)
                        .and_then(|n| u16::try_from(n).ok())
                };
                let arg_bool = |key: &str| args.get(key).and_then(Value::as_bool);
                let arg_u64 = |key: &str| args.get(key).and_then(Value::as_u64);
                let conversation_identity = || {
                    ClientIdentity::new(&client.client_id, &client.surface, client.connection_id)
                };
                let stable_conversation_id = |candidate: &str| -> Result<String, String> {
                    Ok(session_kernel
                        .lock()
                        .map_err(|_| "Session Kernel lock is poisoned".to_owned())?
                        .stable_chat_id(candidate)
                        .unwrap_or_else(|| candidate.to_owned()))
                };

                let harness_router = HarnessV2Router {
                    manager: &manager,
                    broker: &broker,
                    task_control: &task_control,
                    spine: &runtime_spine,
                    acp: &acp_adapter,
                    work: &work_manager,
                    context: &context_engine,
                    code: &code_intelligence,
                    hooks: &hook_manager,
                    extensions: &extension_service,
                };
                if command == "acp_request" {
                    let request = args.get("request").ok_or("request is required")?;
                    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
                    if matches!(
                        method,
                        "session/prompt"
                            | "session/cancel"
                            | "session/rename"
                            | "session/archive"
                            | "session/delete"
                            | "session/purge"
                            | "session/rewind"
                    ) {
                        let params = request.get("params").unwrap_or(&Value::Null);
                        let chat_id = params
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .ok_or("ACP mutation sessionId is required")?;
                        let stable_chat_id = stable_conversation_id(chat_id)?;
                        let generation = arg_u64("conversationGeneration")
                            .ok_or("conversationGeneration is required")?;
                        let mutation_request_id = args
                            .get("mutationRequestId")
                            .and_then(Value::as_str)
                            .or_else(|| params.get("requestId").and_then(Value::as_str))
                            .unwrap_or(&client.request_id);
                        let authorization = conversation_control
                            .lock()
                            .map_err(|_| "Conversation Control lock is poisoned".to_owned())?
                            .authorize(
                                &stable_chat_id,
                                &conversation_identity()?,
                                generation,
                                mutation_request_id,
                                unix_millis(),
                            )?;
                        if authorization == Authorization::Duplicate {
                            return Ok(serde_json::json!({
                                "accepted": false,
                                "duplicate": true,
                                "requestId": mutation_request_id,
                            }));
                        }
                    }
                }
                if let Some(result) = harness_router.handle(&command, &args, client.local).await {
                    return result;
                }

                match command.as_str() {
                    "account_list"
                    | "account_preview_local"
                    | "account_preview_json"
                    | "account_apply_import"
                    | "account_activate"
                    | "account_deactivate"
                    | "custom_provider_discover"
                    | "custom_provider_save"
                    | "chat_prepare_prompt"
                    | "chat_runtime_command"
                    | "conversation_observe"
                    | "conversation_claim"
                    | "conversation_renew"
                    | "conversation_probe_failed"
                    | "conversation_release"
                    | "conversation_authorize"
                    | "chat_migration_scan"
                    | "chat_migration_import"
                    | "chat_migration_context_open"
                    | "chat_migration_context_page"
                    | "chat_delete"
                    | "chat_backup_scan"
                    | "chat_backup_pick_save"
                    | "chat_backup_pick_open"
                    | "chat_backup_create"
                    | "chat_backup_probe"
                    | "chat_backup_inspect"
                    | "chat_backup_restore"
                    | "context_compression_review"
                    | "context_compression_pick_save"
                    | "context_compression_create"
                    | "task_snapshot"
                    | "task_create_simple"
                    | "task_register_workspace"
                    | "task_bind_workspace"
                    | "task_create_harness"
                    | "task_start"
                    | "task_continue"
                    | "agent_cancel"
                    | "harness_review"
                    | "harness_confirm"
                    | "harness_run_action"
                    | "harness_validate_gate"
                    | "capability_snapshot"
                    | "capability_effective_report"
                    | "capability_set_opt_in"
                    | "capability_set_tier"
                    | "firstmate_status"
                    | "firstmate_set_root"
                    | "firstmate_open"
                    | "capability_search"
                    | "capability_refresh_index"
                    | "capability_search_code"
                    | "background_job_start"
                    | "background_job_cancel"
                    | "background_job_get"
                    | "background_job_wait"
                    | "background_job_stdin"
                    | "task_graph_save"
                    | "task_checkpoint"
                    | "subagent_spawn"
                    | "subagent_policy_set"
                    | "subagent_policy_get"
                    | "git_snapshot"
                    | "git_worktree_create"
                    | "git_worktree_review"
                    | "git_rewind_preview"
                    | "git_rewind_apply"
                    | "git_handoff_create"
                    | "extension_install"
                    | "extension_snapshot"
                    | "extension_migrate"
                    | "extension_set_enabled"
                    | "extension_set_trusted"
                    | "extension_sync_skills"
                    | "extension_skill_set_enabled"
                    | "extension_skill_set_trusted"
                    | "extension_component_set_enabled"
                    | "extension_component_set_trusted"
                    | "firstmate_set_trusted"
                    | "extension_start"
                    | "extension_cancel"
                    | "external_import_preview"
                    | "external_import_apply"
                    | "external_import_activate"
                    | "mcp_import_preview"
                    | "mcp_import_apply"
                    | "mcp_start"
                    | "mcp_activate"
                    | "mcp_tool_request"
                    | "mcp_set_enabled"
                    | "mcp_set_trusted"
                    | "adapter_register"
                    | "adapter_set_enabled"
                    | "adapter_discover"
                    | "dap_launch"
                    | "dap_record_event"
                    | "extension_cancel_task"
                    | "diagnostic_add"
                    | "advisory_request"
                    | "advisory_complete"
                    | "regression_record"
                    | "regression_compare"
                    | "acp_request"
                    | "runtime_spine_events"
                    | "runtime_spine_state"
                    | "work_snapshot"
                    | "work_status"
                    | "work_wait"
                    | "work_cancel"
                    | "context_v2_prepare"
                    | "context_v2_store_artifact"
                    | "context_v2_fetch_artifact"
                    | "completion_evaluate"
                    | "code_lsp_request"
                    | "delegation_plan"
                    | "hook_list"
                    | "hook_install"
                    | "hook_set_enabled"
                    | "hook_set_trusted"
                    | "hook_invoke"
                        if !client.local =>
                    {
                        Err("This control is available only from the local desktop app".to_string())
                    }
                    "client_snapshot" => {
                        let hello: ClientHello = serde_json::from_value(args.clone())
                            .map_err(|error| format!("Invalid client hello: {error}"))?;
                        if hello.client_id != client.client_id
                            || hello.surface.as_str() != client.surface
                        {
                            return Err("Client hello identity must match the current connection"
                                .to_owned());
                        }
                        serde_json::to_value(client_gateway.connect(&hello, unix_millis())?)
                            .map_err(|error| format!("Cannot encode client snapshot: {error}"))
                    }
                    "conversation_observe" => {
                        let chat_id = stable_conversation_id(
                            &arg_str("chatId").ok_or("chatId is required")?,
                        )?;
                        let mut control = conversation_control
                            .lock()
                            .map_err(|_| "Conversation Control lock is poisoned".to_owned())?;
                        serde_json::to_value(control.observe(&chat_id, unix_millis()))
                            .map_err(|error| format!("Cannot encode conversation control: {error}"))
                    }
                    "conversation_claim" => {
                        let chat_id = stable_conversation_id(
                            &arg_str("chatId").ok_or("chatId is required")?,
                        )?;
                        let mut control = conversation_control
                            .lock()
                            .map_err(|_| "Conversation Control lock is poisoned".to_owned())?;
                        serde_json::to_value(control.claim(
                            &chat_id,
                            &conversation_identity()?,
                            unix_millis(),
                        )?)
                        .map_err(|error| format!("Cannot encode conversation claim: {error}"))
                    }
                    "conversation_renew" => {
                        let chat_id = stable_conversation_id(
                            &arg_str("chatId").ok_or("chatId is required")?,
                        )?;
                        let generation = arg_u64("generation").ok_or("generation is required")?;
                        let mut control = conversation_control
                            .lock()
                            .map_err(|_| "Conversation Control lock is poisoned".to_owned())?;
                        serde_json::to_value(control.renew(
                            &chat_id,
                            &conversation_identity()?,
                            generation,
                            unix_millis(),
                        )?)
                        .map_err(|error| format!("Cannot encode conversation renewal: {error}"))
                    }
                    "conversation_probe_failed" => {
                        let chat_id = stable_conversation_id(
                            &arg_str("chatId").ok_or("chatId is required")?,
                        )?;
                        let mut control = conversation_control
                            .lock()
                            .map_err(|_| "Conversation Control lock is poisoned".to_owned())?;
                        serde_json::to_value(control.probe_failed(&chat_id, unix_millis())?)
                            .map_err(|error| format!("Cannot encode failed probe: {error}"))
                    }
                    "conversation_release" => {
                        let chat_id = stable_conversation_id(
                            &arg_str("chatId").ok_or("chatId is required")?,
                        )?;
                        let generation = arg_u64("generation").ok_or("generation is required")?;
                        serde_json::to_value(
                            conversation_control
                                .lock()
                                .map_err(|_| "Conversation Control lock is poisoned".to_owned())?
                                .release(
                                    &chat_id,
                                    &conversation_identity()?,
                                    generation,
                                    unix_millis(),
                                )?,
                        )
                        .map_err(|error| format!("Cannot encode conversation release: {error}"))
                    }
                    "conversation_authorize" => {
                        let chat_id = stable_conversation_id(
                            &arg_str("chatId").ok_or("chatId is required")?,
                        )?;
                        let generation = arg_u64("generation").ok_or("generation is required")?;
                        let request_id = arg_str("mutationRequestId")
                            .unwrap_or_else(|| client.request_id.clone());
                        serde_json::to_value(
                            conversation_control
                                .lock()
                                .map_err(|_| "Conversation Control lock is poisoned".to_owned())?
                                .authorize(
                                    &chat_id,
                                    &conversation_identity()?,
                                    generation,
                                    &request_id,
                                    unix_millis(),
                                )?,
                        )
                        .map_err(|error| {
                            format!("Cannot encode conversation authorization: {error}")
                        })
                    }
                    "chat_runtime_command" => {
                        let session_id = arg_str("sessionId").ok_or("sessionId is required")?;
                        let stable_chat_id = stable_conversation_id(&session_id)?;
                        let mut payload = args
                            .get("payload")
                            .cloned()
                            .filter(Value::is_object)
                            .ok_or("payload must be an object")?;
                        let payload_type = payload
                            .get("type")
                            .and_then(Value::as_str)
                            .ok_or("payload.type is required")?;
                        if !matches!(
                            payload_type,
                            "prompt" | "abort" | "fork" | "new_session" | "set_model"
                        ) {
                            return Err("Unsupported managed chat runtime command".into());
                        }
                        let source_port = broker
                            .port_for_session(&session_id)
                            .or_else(|| {
                                args.get("sourcePort")
                                    .and_then(Value::as_u64)
                                    .and_then(|port| u16::try_from(port).ok())
                            })
                            .ok_or("No live Pi runtime owns this chat")?;
                        let generation = arg_u64("conversationGeneration")
                            .ok_or("conversationGeneration is required")?;
                        let mutation_request_id = arg_str("mutationRequestId")
                            .or_else(|| {
                                payload
                                    .get("requestId")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned)
                            })
                            .unwrap_or_else(|| client.request_id.clone());
                        let authorization = conversation_control
                            .lock()
                            .map_err(|_| "Conversation Control lock is poisoned".to_owned())?
                            .authorize(
                                &stable_chat_id,
                                &conversation_identity()?,
                                generation,
                                &mutation_request_id,
                                unix_millis(),
                            )?;
                        if authorization == Authorization::Duplicate {
                            return Ok(serde_json::json!({
                                "queued": false,
                                "duplicate": true,
                                "requestId": mutation_request_id,
                            }));
                        }
                        if let Some(routed_port) = broker.port_for_session(&session_id) {
                            if routed_port != source_port {
                                return Err("Chat route and source port disagree".into());
                            }
                        }
                        payload["sessionId"] = Value::String(session_id);
                        broker.send_command_to_port(source_port, payload)?;
                        Ok(serde_json::json!({ "queued": true, "sourcePort": source_port }))
                    }
                    "account_list" => serde_json::to_value(accounts.list_accounts()?)
                        .map_err(|error| format!("Cannot encode account list: {error}")),
                    "account_preview_local" => {
                        let provider = arg_str("provider").ok_or("provider is required")?;
                        serde_json::to_value(accounts.preview_local(&provider)?)
                            .map_err(|error| format!("Cannot encode account preview: {error}"))
                    }
                    "account_preview_json" => {
                        let provider = arg_str("provider").ok_or("provider is required")?;
                        let content = arg_str("content").ok_or("content is required")?;
                        let source_name = arg_str("sourceName");
                        serde_json::to_value(accounts.preview_json(
                            &provider,
                            &content,
                            source_name.as_deref(),
                        )?)
                        .map_err(|error| format!("Cannot encode account preview: {error}"))
                    }
                    "account_apply_import" => {
                        let preview_id = arg_str("previewId").ok_or("previewId is required")?;
                        let candidate_ids: Vec<String> = args
                            .get("candidateIds")
                            .and_then(Value::as_array)
                            .ok_or("candidateIds must be an array")?
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect();
                        let activate_candidate_id = arg_str("activateCandidateId");
                        let mut result = accounts.apply(
                            &preview_id,
                            &candidate_ids,
                            activate_candidate_id.as_deref(),
                        )?;
                        if result.active_account_id.is_some() {
                            let active = accounts
                                .active_account(&result.provider)?
                                .ok_or("The activated account was not found in the vault")?;
                            if active.provider == "cursor" {
                                if let Err(error) =
                                    manager.ensure_cursor_integration(&active.metadata)
                                {
                                    if let Err(rollback_error) = accounts.restore_active_account(
                                        &result.provider,
                                        result.previous_active_account_id.as_deref(),
                                    ) {
                                        log::error!(
                                            "[accounts] failed to restore the previous active account after Cursor integration setup failure: {}",
                                            rollback_error
                                        );
                                    }
                                    return Err(error);
                                }
                                result.restart_required = true;
                            }
                            if let Err(error) =
                                auth_sync.activate(&active, &result.deactivated_pi_providers)
                            {
                                if let Err(rollback_error) = accounts.restore_active_account(
                                    &result.provider,
                                    result.previous_active_account_id.as_deref(),
                                ) {
                                    log::error!(
                                        "[accounts] failed to restore the previous active account: {}",
                                        rollback_error
                                    );
                                }
                                return Err(error);
                            }
                            if let Some(previous_account_id) = result
                                .previous_active_account_id
                                .as_deref()
                                .filter(|previous| {
                                    Some(*previous) != result.active_account_id.as_deref()
                                })
                            {
                                suspend_bound_account_tasks(
                                    &bindings,
                                    &manager,
                                    &broker,
                                    &task_control,
                                    &extension_service,
                                    &result.provider,
                                    previous_account_id,
                                    result.active_account_id.as_deref(),
                                );
                            }
                            notify_pi_account_reload(&manager, &broker);
                        }
                        serde_json::to_value(result).map_err(|error| {
                            format!("Cannot encode account import result: {error}")
                        })
                    }
                    "account_activate" => {
                        let account_id = arg_str("accountId").ok_or("accountId is required")?;
                        let mut result = accounts.activate_stored(&account_id)?;
                        let active = accounts
                            .active_account(&result.provider)?
                            .ok_or("The activated account was not found in the vault")?;
                        if active.provider == "cursor" {
                            if let Err(error) = manager.ensure_cursor_integration(&active.metadata)
                            {
                                if let Err(rollback_error) = accounts.restore_active_account(
                                    &result.provider,
                                    result.previous_active_account_id.as_deref(),
                                ) {
                                    log::error!(
                                        "[accounts] failed to restore the previous active account after Cursor integration setup failure: {}",
                                        rollback_error
                                    );
                                }
                                return Err(error);
                            }
                            result.restart_required = true;
                        }
                        if let Err(error) =
                            auth_sync.activate(&active, &result.deactivated_pi_providers)
                        {
                            if let Err(rollback_error) = accounts.restore_active_account(
                                &result.provider,
                                result.previous_active_account_id.as_deref(),
                            ) {
                                log::error!(
                                    "[accounts] failed to restore the previous active account: {}",
                                    rollback_error
                                );
                            }
                            return Err(error);
                        }
                        if let Some(previous_account_id) = result
                            .previous_active_account_id
                            .as_deref()
                            .filter(|previous| *previous != result.active_account_id.as_str())
                        {
                            suspend_bound_account_tasks(
                                &bindings,
                                &manager,
                                &broker,
                                &task_control,
                                &extension_service,
                                &result.provider,
                                previous_account_id,
                                Some(&result.active_account_id),
                            );
                        }
                        notify_pi_account_reload(&manager, &broker);
                        serde_json::to_value(result)
                            .map_err(|error| format!("Cannot encode account activation: {error}"))
                    }
                    "account_deactivate" => {
                        let provider = arg_str("provider").ok_or("provider is required")?;
                        let result = accounts.deactivate_provider(&provider)?;
                        if let Err(error) = auth_sync.deactivate(&result.deactivated_pi_provider) {
                            if let Err(rollback_error) = accounts.restore_active_account(
                                &result.provider,
                                Some(&result.deactivated_account_id),
                            ) {
                                log::error!(
                                    "[accounts] failed to restore the deactivated account: {}",
                                    rollback_error
                                );
                            }
                            return Err(error);
                        }
                        suspend_bound_account_tasks(
                            &bindings,
                            &manager,
                            &broker,
                            &task_control,
                            &extension_service,
                            &result.provider,
                            &result.deactivated_account_id,
                            None,
                        );
                        notify_pi_account_reload(&manager, &broker);
                        serde_json::to_value(result)
                            .map_err(|error| format!("Cannot encode account deactivation: {error}"))
                    }
                    "chat_prepare_prompt" => {
                        let session_id = arg_str("sessionId").ok_or("sessionId is required")?;
                        let pi_provider = arg_str("piProvider").ok_or("piProvider is required")?;
                        let message = arg_str("message").unwrap_or_default();
                        let active = accounts.active_account_for_pi_provider(&pi_provider)?;
                        let active_ref = active
                            .as_ref()
                            .map(|account| (account.provider.as_str(), account.id.as_str()));
                        let confirmed = message.trim() == "继续"
                            || message.trim().eq_ignore_ascii_case("continue");
                        let decision = bindings.prepare_prompt(
                            &session_id,
                            &pi_provider,
                            active_ref,
                            confirmed,
                        )?;
                        if decision.allowed {
                            if let Some(task_id) = arg_str("taskId") {
                                let model = arg_str("model")
                                    .ok_or("model is required for a task prompt")?;
                                let source_port = arg_u16("sourcePort")
                                    .ok_or("sourcePort is required for a task prompt")?;
                                let provider =
                                    decision.logical_provider.as_deref().unwrap_or(&pi_provider);
                                let account_id =
                                    decision.account_id.as_deref().unwrap_or("unmanaged");
                                let (kind, workspace) = {
                                    let mut control = task_control
                                        .lock()
                                        .map_err(|_| "Task Control lock is poisoned".to_owned())?;
                                    let kind = control.task_kind(&task_id)?;
                                    let workspace = control.task_workspace(&task_id).ok();
                                    control.activate_prompt(
                                        &task_id,
                                        &session_id,
                                        provider,
                                        account_id,
                                        &pi_provider,
                                        &model,
                                        source_port,
                                        confirmed,
                                    )?;
                                    (kind, workspace)
                                };
                                let context = capability_service
                                    .lock()
                                    .map_err(|_| "Capability Service lock is poisoned".to_owned())?
                                    .prepare_task(&task_id, kind, workspace.as_deref())?;
                                let mut guidance_request = match args.get("guidance") {
                                    Some(value) if !value.is_null() => {
                                        serde_json::from_value::<GuidanceRequest>(value.clone())
                                            .map_err(|error| {
                                                format!("Invalid guidance request: {error}")
                                            })?
                                    }
                                    _ => GuidanceRequest {
                                        task_kind: kind,
                                        mode: GuidanceMode::Adaptive,
                                        model: ModelGuidanceProfile {
                                            evaluated_autonomy: 90,
                                            tool_reliability: 90,
                                        },
                                        signals: Vec::new(),
                                    },
                                };
                                guidance_request.task_kind = kind;
                                let guidance = GuidancePolicy::decide(&guidance_request);
                                broker.send_command_to_port(
                                    source_port,
                                    serde_json::json!({
                                        "type": "picode_task_context",
                                        "context": context,
                                        "guidance": guidance,
                                    }),
                                )?;
                            } else if let Some(source_port) = arg_u16("sourcePort") {
                                broker.send_command_to_port(
                                    source_port,
                                    serde_json::json!({
                                        "type": "picode_task_context",
                                        "context": Value::Null,
                                    }),
                                )?;
                            }
                        }
                        serde_json::to_value(decision)
                            .map_err(|error| format!("Cannot encode chat account binding: {error}"))
                    }
                    "chat_migration_scan" => {
                        let sources: Vec<String> = args
                            .get("sources")
                            .and_then(Value::as_array)
                            .ok_or("sources must be an array")?
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect();
                        serde_json::to_value(chat_migration.scan_local(&sources)?)
                            .map_err(|error| format!("Cannot encode local chat scan: {error}"))
                    }
                    "chat_migration_import" => {
                        let scan_id = arg_str("scanId").ok_or("scanId is required")?;
                        let selected_ids: Vec<String> = args
                            .get("candidateIds")
                            .and_then(Value::as_array)
                            .ok_or("candidateIds must be an array")?
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect();
                        let workspace_bindings: HashMap<String, String> = args
                            .get("workspaceBindings")
                            .and_then(Value::as_object)
                            .ok_or("workspaceBindings must be an object")?
                            .iter()
                            .filter_map(|(key, value)| {
                                value.as_str().map(|value| (key.clone(), value.to_string()))
                            })
                            .collect();
                        let include_reasoning = args
                            .get("includeReasoning")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        serde_json::to_value(chat_migration.import_selected(
                            &scan_id,
                            &selected_ids,
                            &workspace_bindings,
                            include_reasoning,
                        )?)
                        .map_err(|error| format!("Cannot encode chat import result: {error}"))
                    }
                    "chat_migration_context_open" => {
                        let scan_id = arg_str("scanId").ok_or("scanId is required")?;
                        let candidate_id =
                            arg_str("candidateId").ok_or("candidateId is required")?;
                        let port = arg_u16("port").ok_or("port is required")?;
                        let candidate =
                            chat_migration.candidate_summary(&scan_id, &candidate_id)?;
                        open_chat_context_window(
                            &app,
                            port,
                            &broker.url(),
                            &scan_id,
                            &candidate_id,
                            &candidate.title,
                        )?;
                        Ok(Value::Bool(true))
                    }
                    "chat_migration_context_page" => {
                        let scan_id = arg_str("scanId").ok_or("scanId is required")?;
                        let candidate_id =
                            arg_str("candidateId").ok_or("candidateId is required")?;
                        let cursor = arg_str("cursor");
                        serde_json::to_value(chat_migration.context_page(
                            &scan_id,
                            &candidate_id,
                            cursor.as_deref(),
                        )?)
                        .map_err(|error| format!("Cannot encode chat context page: {error}"))
                    }
                    "chat_delete" => {
                        let file_paths: Vec<String> = args
                            .get("filePaths")
                            .and_then(Value::as_array)
                            .ok_or("filePaths must be an array")?
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect();
                        if file_paths.len() != 1 {
                            return Err(
                                "Chat deletion must authorize and delete one chat at a time".into(),
                            );
                        }
                        let stable_chat_id = stable_conversation_id(&file_paths[0])?;
                        let generation = arg_u64("conversationGeneration")
                            .ok_or("conversationGeneration is required")?;
                        let mutation_request_id = arg_str("mutationRequestId")
                            .unwrap_or_else(|| client.request_id.clone());
                        let authorization = conversation_control
                            .lock()
                            .map_err(|_| "Conversation Control lock is poisoned".to_owned())?
                            .authorize(
                                &stable_chat_id,
                                &conversation_identity()?,
                                generation,
                                &mutation_request_id,
                                unix_millis(),
                            )?;
                        if authorization == Authorization::Duplicate {
                            return Ok(serde_json::json!({
                                "errors": [],
                                "duplicate": true,
                            }));
                        }
                        serde_json::to_value(chat_migration.delete_sessions(&file_paths)?)
                            .map_err(|error| format!("Cannot encode chat deletion result: {error}"))
                    }
                    "chat_backup_scan" => serde_json::to_value(chat_backup.scan_sessions()?)
                        .map_err(|error| format!("Cannot encode chat-backup scan: {error}")),
                    "chat_backup_pick_save" => Ok(match pick_backup_save_core(&app).await {
                        Some(path) => Value::from(path),
                        None => Value::Null,
                    }),
                    "chat_backup_pick_open" => Ok(match pick_backup_open_core(&app).await {
                        Some(path) => Value::from(path),
                        None => Value::Null,
                    }),
                    "chat_backup_create" => {
                        let scan_id = arg_str("scanId").ok_or("scanId is required")?;
                        let selected_ids: Vec<String> = args
                            .get("candidateIds")
                            .and_then(Value::as_array)
                            .ok_or("candidateIds must be an array")?
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect();
                        let flags: HashMap<String, BackupSelectionFlags> = serde_json::from_value(
                            args.get("flags")
                                .cloned()
                                .unwrap_or_else(|| serde_json::json!({})),
                        )
                        .map_err(|error| format!("Invalid chat-backup flags: {error}"))?;
                        let encrypted = arg_bool("encrypted").unwrap_or(true);
                        let password = arg_str("password").unwrap_or_default();
                        let destination =
                            arg_str("destination").ok_or("destination is required")?;
                        serde_json::to_value(chat_backup.create_backup(
                            &scan_id,
                            &selected_ids,
                            &flags,
                            encrypted,
                            password,
                            &destination,
                        )?)
                        .map_err(|error| format!("Cannot encode chat-backup result: {error}"))
                    }
                    "chat_backup_probe" => {
                        let path = arg_str("path").ok_or("path is required")?;
                        serde_json::to_value(chat_backup.probe_backup(&path)?)
                            .map_err(|error| format!("Cannot encode chat-backup probe: {error}"))
                    }
                    "chat_backup_inspect" => {
                        let path = arg_str("path").ok_or("path is required")?;
                        let password = arg_str("password").unwrap_or_default();
                        serde_json::to_value(chat_backup.inspect_backup(&path, password)?)
                            .map_err(|error| format!("Cannot encode restore preview: {error}"))
                    }
                    "chat_backup_restore" => {
                        let restore_id = arg_str("restoreId").ok_or("restoreId is required")?;
                        let selected_ids: Vec<String> = args
                            .get("candidateIds")
                            .and_then(Value::as_array)
                            .ok_or("candidateIds must be an array")?
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect();
                        let workspace_bindings: HashMap<String, String> = args
                            .get("workspaceBindings")
                            .and_then(Value::as_object)
                            .ok_or("workspaceBindings must be an object")?
                            .iter()
                            .filter_map(|(key, value)| {
                                value.as_str().map(|value| (key.clone(), value.to_string()))
                            })
                            .collect();
                        serde_json::to_value(chat_backup.restore_selected(
                            &restore_id,
                            &selected_ids,
                            &workspace_bindings,
                        )?)
                        .map_err(|error| format!("Cannot encode chat-restore result: {error}"))
                    }
                    "context_compression_review" => {
                        let scan_id = arg_str("scanId").ok_or("scanId is required")?;
                        let selected_ids: Vec<String> = args
                            .get("candidateIds")
                            .and_then(Value::as_array)
                            .ok_or("candidateIds must be an array")?
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect();
                        let provider = arg_str("provider").ok_or("provider is required")?;
                        let model_id = arg_str("modelId").ok_or("modelId is required")?;
                        serde_json::to_value(context_compression.review(
                            &scan_id,
                            &selected_ids,
                            &provider,
                            &model_id,
                        )?)
                        .map_err(|error| format!("Cannot encode compression review: {error}"))
                    }
                    "context_compression_pick_save" => {
                        Ok(match pick_context_save_core(&app).await {
                            Some(path) => Value::from(path),
                            None => Value::Null,
                        })
                    }
                    "context_compression_create" => {
                        let review_id = arg_str("reviewId").ok_or("reviewId is required")?;
                        let encrypted = arg_bool("encrypted").unwrap_or(true);
                        let password = arg_str("password").unwrap_or_default();
                        let destination =
                            arg_str("destination").ok_or("destination is required")?;
                        serde_json::to_value(
                            context_compression
                                .create_package(
                                    &manager,
                                    &review_id,
                                    encrypted,
                                    password,
                                    &destination,
                                )
                                .await?,
                        )
                        .map_err(|error| format!("Cannot encode context-package result: {error}"))
                    }
                    "task_snapshot" => {
                        let control = task_control
                            .lock()
                            .map_err(|_| "Task Control lock is poisoned".to_owned())?;
                        let mut value =
                            serde_json::to_value(control.snapshot()).map_err(|error| {
                                format!("Cannot encode Task Control snapshot: {error}")
                            })?;
                        let orchestration = serde_json::to_value(orchestration_service.snapshot())
                            .map_err(|error| {
                                format!("Cannot encode Orchestration snapshot: {error}")
                            })?;
                        if let Some(object) = value.as_object_mut() {
                            object.insert("orchestration".into(), orchestration);
                            object.insert(
                                "work".into(),
                                serde_json::to_value(work_manager.snapshot()?).map_err(
                                    |error| format!("Cannot encode Work snapshot: {error}"),
                                )?,
                            );
                            object.insert(
                                "extensions".into(),
                                serde_json::to_value(extension_service.snapshot()).map_err(
                                    |error| format!("Cannot encode Extension snapshot: {error}"),
                                )?,
                            );
                        }
                        Ok(value)
                    }
                    "task_create_simple" => {
                        let chat_id = arg_str("chatId").ok_or("chatId is required")?;
                        let goal = arg_str("goal").unwrap_or_default();
                        serde_json::to_value(task_experience.create(&CreateTask {
                            chat_id: &chat_id,
                            goal: &goal,
                            target: TaskTarget::Simple {
                                scratch_root: &scratch_root,
                            },
                            now: unix_millis(),
                        })?)
                        .map_err(|error| format!("Cannot encode Simple Task: {error}"))
                    }
                    "task_register_workspace" => {
                        let source_platform =
                            arg_str("sourcePlatform").ok_or("sourcePlatform is required")?;
                        let source_path = arg_str("sourcePath").ok_or("sourcePath is required")?;
                        let local_path = arg_str("localPath").map(PathBuf::from);
                        let mut control = task_control
                            .lock()
                            .map_err(|_| "Task Control lock is poisoned".to_owned())?;
                        serde_json::to_value(control.register_workspace(
                            &source_platform,
                            &source_path,
                            local_path.as_deref(),
                        )?)
                        .map_err(|error| format!("Cannot encode Workspace Identity: {error}"))
                    }
                    "task_bind_workspace" => {
                        let workspace_id =
                            arg_str("workspaceId").ok_or("workspaceId is required")?;
                        let local_path = arg_str("localPath").ok_or("localPath is required")?;
                        task_control
                            .lock()
                            .map_err(|_| "Task Control lock is poisoned".to_owned())?
                            .bind_workspace(&workspace_id, std::path::Path::new(&local_path))?;
                        Ok(Value::Null)
                    }
                    "task_create_harness" => {
                        let chat_id = arg_str("chatId").ok_or("chatId is required")?;
                        let goal = arg_str("goal").unwrap_or_default();
                        let workspace_id =
                            arg_str("workspaceId").ok_or("workspaceId is required")?;
                        serde_json::to_value(task_experience.create(&CreateTask {
                            chat_id: &chat_id,
                            goal: &goal,
                            target: TaskTarget::Harness {
                                workspace_id: &workspace_id,
                            },
                            now: unix_millis(),
                        })?)
                        .map_err(|error| format!("Cannot encode Harness Task: {error}"))
                    }
                    "task_start" => {
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        let provider = arg_str("provider").ok_or("provider is required")?;
                        let account_id = arg_str("accountId").ok_or("accountId is required")?;
                        let channel = arg_str("channel").ok_or("channel is required")?;
                        let model = arg_str("model").ok_or("model is required")?;
                        task_experience.transition(
                            &task_id,
                            &TaskTransition::Start(AccountSelection {
                                provider: &provider,
                                account_id: &account_id,
                                channel: &channel,
                                model: &model,
                            }),
                            unix_millis(),
                        )?;
                        Ok(Value::Null)
                    }
                    "task_continue" => {
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        let continue_command = arg_str("command").ok_or("command is required")?;
                        let provider = arg_str("provider").ok_or("provider is required")?;
                        let account_id = arg_str("accountId").ok_or("accountId is required")?;
                        let channel = arg_str("channel").ok_or("channel is required")?;
                        let model = arg_str("model").ok_or("model is required")?;
                        task_experience.transition(
                            &task_id,
                            &TaskTransition::Continue {
                                command: &continue_command,
                                account: AccountSelection {
                                    provider: &provider,
                                    account_id: &account_id,
                                    channel: &channel,
                                    model: &model,
                                },
                            },
                            unix_millis(),
                        )?;
                        Ok(Value::Null)
                    }
                    "agent_cancel" => {
                        let run_id = arg_str("runId").ok_or("runId is required")?;
                        let target = task_control
                            .lock()
                            .map_err(|_| "Task Control lock is poisoned".to_owned())?
                            .cancel_target(&run_id)?;
                        if !manager.owns_process(target.source_port, target.process_id) {
                            return Err(
                                "the selected Agent Run no longer owns that Pi process".into()
                            );
                        }
                        manager
                            .send_rpc(target.source_port, serde_json::json!({ "type": "abort" }))?;
                        task_control
                            .lock()
                            .map_err(|_| "Task Control lock is poisoned".to_owned())?
                            .cancel_agent(&run_id, "cancelled from Runtime Monitor")?;
                        extension_service.cancel_agent_processes(&run_id)?;
                        Ok(Value::Null)
                    }
                    "harness_review" => {
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        let workspace = task_control
                            .lock()
                            .map_err(|_| "Task Control lock is poisoned".to_owned())?
                            .task_workspace(&task_id)?;
                        serde_json::to_value(harness_service.review(&task_id, &workspace)?)
                            .map_err(|error| format!("Cannot encode Harness review: {error}"))
                    }
                    "harness_confirm" => {
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        let selected_ids: Vec<String> = args
                            .get("selectedIds")
                            .and_then(Value::as_array)
                            .ok_or("selectedIds must be an array")?
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect();
                        let workspace = task_control
                            .lock()
                            .map_err(|_| "Task Control lock is poisoned".to_owned())?
                            .task_workspace(&task_id)?;
                        serde_json::to_value(harness_service.confirm_profile(
                            &task_id,
                            &workspace,
                            &selected_ids,
                        )?)
                        .map_err(|error| format!("Cannot encode confirmed Harness: {error}"))
                    }
                    "harness_run_action" => {
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        let action_id = arg_str("actionId").ok_or("actionId is required")?;
                        let parameters: std::collections::BTreeMap<String, String> = args
                            .get("parameters")
                            .and_then(Value::as_object)
                            .map(|values| {
                                values
                                    .iter()
                                    .filter_map(|(key, value)| {
                                        value.as_str().map(|value| (key.clone(), value.to_owned()))
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        let workspace = task_control
                            .lock()
                            .map_err(|_| "Task Control lock is poisoned".to_owned())?
                            .task_workspace(&task_id)?;
                        let result = harness_service
                            .run_action(
                                &task_id,
                                &workspace,
                                &action_id,
                                &parameters,
                                arg_bool("riskApproved").unwrap_or(false),
                            )
                            .await?;
                        task_control
                            .lock()
                            .map_err(|_| "Task Control lock is poisoned".to_owned())?
                            .record_evidence_ref(&task_id, &result.evidence.id)?;
                        serde_json::to_value(result)
                            .map_err(|error| format!("Cannot encode Harness result: {error}"))
                    }
                    "harness_validate_gate" => {
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        let gate_id = arg_str("gateId").ok_or("gateId is required")?;
                        let workspace = task_control
                            .lock()
                            .map_err(|_| "Task Control lock is poisoned".to_owned())?
                            .task_workspace(&task_id)?;
                        let result = harness_service
                            .validate_gate(
                                &task_id,
                                &workspace,
                                &gate_id,
                                arg_bool("riskApproved").unwrap_or(false),
                            )
                            .await?;
                        task_control
                            .lock()
                            .map_err(|_| "Task Control lock is poisoned".to_owned())?
                            .record_evidence_ref(&task_id, &result.evidence.id)?;
                        serde_json::to_value(result)
                            .map_err(|error| format!("Cannot encode Gate validity result: {error}"))
                    }
                    "capability_snapshot" => serde_json::to_value(
                        capability_service
                            .lock()
                            .map_err(|_| "Capability Service lock is poisoned".to_owned())?
                            .snapshot(),
                    )
                    .map_err(|error| format!("Cannot encode Capability snapshot: {error}")),
                    "capability_effective_report" => {
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        let sources = |key: &str| -> Result<Vec<EffectiveSource>, String> {
                            serde_json::from_value(
                                args.get(key)
                                    .cloned()
                                    .unwrap_or_else(|| serde_json::json!([])),
                            )
                            .map_err(|error| format!("Invalid {key}: {error}"))
                        };
                        let kind = task_control
                            .lock()
                            .map_err(|_| "Task Control lock is poisoned".to_owned())?
                            .task_kind(&task_id)?;
                        let report = capability_service
                            .lock()
                            .map_err(|_| "Capability Service lock is poisoned".to_owned())?
                            .effective_report(
                                &task_id,
                                kind,
                                &sources("rules")?,
                                &sources("skills")?,
                                &sources("overrides")?,
                            );
                        serde_json::to_value(report).map_err(|error| {
                            format!("Cannot encode effective Capability report: {error}")
                        })
                    }
                    "capability_set_opt_in" => {
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        let enabled = arg_bool("enabled").ok_or("enabled is required")?;
                        capability_service
                            .lock()
                            .map_err(|_| "Capability Service lock is poisoned".to_owned())?
                            .set_catalog_opt_in(&task_id, enabled)?;
                        Ok(Value::Null)
                    }
                    "capability_set_tier" => {
                        let id = arg_str("id").ok_or("id is required")?;
                        let tier = match arg_str("tier")
                            .ok_or("tier is required")?
                            .to_ascii_lowercase()
                            .as_str()
                        {
                            "resident" => {
                                return Err("resident tier is reserved for the Resident Core".into())
                            }
                            "discoverable" => CapabilityTier::Discoverable,
                            "disabled" => CapabilityTier::Disabled,
                            _ => {
                                return Err(
                                    "tier must be resident, discoverable, or disabled".into()
                                )
                            }
                        };
                        if id == "firstmate-crew-orchestrator" {
                            extension_service
                                .set_firstmate_enabled(tier != CapabilityTier::Disabled)?;
                        } else if matches!(id.as_str(), "rust-lsp" | "debug-adapter") {
                            extension_service.set_catalog_component_enabled(
                                &id,
                                tier != CapabilityTier::Disabled,
                            )?;
                        }
                        capability_service
                            .lock()
                            .map_err(|_| "Capability Service lock is poisoned".to_owned())?
                            .set_module_tier(&id, tier)?;
                        Ok(Value::Null)
                    }
                    "firstmate_status" => {
                        let firstmate = extension_service.firstmate();
                        Ok(serde_json::json!({
                            "enabled": firstmate.enabled,
                            "trusted": firstmate.trusted,
                            "available": firstmate.root.is_some(),
                            "root": firstmate.root,
                            "lastError": firstmate.last_error,
                            "requiresAgentsFile": true,
                        }))
                    }
                    "firstmate_set_root" => {
                        let path = arg_str("path").ok_or("path is required")?;
                        let root = extension_service.set_firstmate_root(Path::new(&path))?;
                        Ok(serde_json::json!({
                            "available": true,
                            "root": root,
                        }))
                    }
                    "firstmate_set_trusted" => {
                        let trusted = arg_bool("trusted").ok_or("trusted is required")?;
                        extension_service.set_firstmate_trusted(trusted)?;
                        Ok(Value::Null)
                    }
                    "firstmate_open" => {
                        let firstmate = extension_service.firstmate();
                        if !firstmate.enabled {
                            return Err(
                                "Firstmate is disabled; enable it in Professional Extensions first"
                                    .into(),
                            );
                        }
                        if !firstmate.trusted {
                            return Err("Firstmate must be trusted before it can run".into());
                        }
                        let root = firstmate.root.ok_or_else(|| {
                            "Firstmate directory not found; choose a folder containing AGENTS.md"
                                .to_owned()
                        })?;
                        let port = open_workspace_core(
                            &root.to_string_lossy(),
                            None,
                            true,
                            true,
                            true,
                            false,
                            &manager,
                            &broker,
                            Some(&app),
                        )
                        .await?;
                        Ok(serde_json::json!({
                            "port": port,
                            "root": root,
                            "mode": "firstmate",
                        }))
                    }
                    "capability_search" => {
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        let query = arg_str("query").ok_or("query is required")?;
                        let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(8) as usize;
                        let kind = task_control
                            .lock()
                            .map_err(|_| "Task Control lock is poisoned".to_owned())?
                            .task_kind(&task_id)?;
                        serde_json::to_value(
                            capability_service
                                .lock()
                                .map_err(|_| "Capability Service lock is poisoned".to_owned())?
                                .search(&task_id, kind, &query, limit)?,
                        )
                        .map_err(|error| format!("Cannot encode Capability search: {error}"))
                    }
                    "capability_refresh_index" => {
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        let workspace = task_control
                            .lock()
                            .map_err(|_| "Task Control lock is poisoned".to_owned())?
                            .task_workspace(&task_id)?;
                        let count = code_intelligence.index(&task_id, &workspace)?;
                        Ok(serde_json::json!({ "indexedFiles": count }))
                    }
                    "capability_search_code" => {
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        let query = arg_str("query").ok_or("query is required")?;
                        let limit =
                            args.get("limit").and_then(Value::as_u64).unwrap_or(20) as usize;
                        serde_json::to_value(code_intelligence.navigate(&task_id, &query, limit)?)
                            .map_err(|error| format!("Cannot encode code search: {error}"))
                    }
                    "background_job_start" => {
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        let agent_run_id = arg_str("agentRunId").ok_or("agentRunId is required")?;
                        let executable = arg_str("executable").ok_or("executable is required")?;
                        let arguments: Vec<String> = args
                            .get("arguments")
                            .and_then(Value::as_array)
                            .ok_or("arguments must be an array")?
                            .iter()
                            .map(|value| {
                                value
                                    .as_str()
                                    .map(str::to_owned)
                                    .ok_or("every background job argument must be a string")
                            })
                            .collect::<Result<_, _>>()?;
                        let timeout_ms = args
                            .get("timeoutMs")
                            .and_then(Value::as_u64)
                            .unwrap_or(30 * 60 * 1000);
                        let cwd = {
                            let control = task_control
                                .lock()
                                .map_err(|_| "Task Control lock is poisoned".to_owned())?;
                            control.validate_agent_run(&agent_run_id, &task_id)?;
                            control.task_working_dir(&task_id)?
                        };
                        serde_json::to_value(orchestration_service.start_job(
                            &task_id,
                            &agent_run_id,
                            std::path::Path::new(&executable),
                            &arguments,
                            &cwd,
                            Duration::from_millis(timeout_ms),
                        )?)
                        .map_err(|error| format!("Cannot encode background job: {error}"))
                    }
                    "background_job_cancel" => {
                        let job_id = arg_str("jobId").ok_or("jobId is required")?;
                        serde_json::to_value(orchestration_service.cancel_job(&job_id)?)
                            .map_err(|error| format!("Cannot encode background job: {error}"))
                    }
                    "background_job_get" => {
                        let job_id = arg_str("jobId").ok_or("jobId is required")?;
                        serde_json::to_value(orchestration_service.job(&job_id)?)
                            .map_err(|error| format!("Cannot encode background job: {error}"))
                    }
                    "background_job_wait" => {
                        let job_id = arg_str("jobId").ok_or("jobId is required")?;
                        let timeout_ms = args
                            .get("timeoutMs")
                            .and_then(Value::as_u64)
                            .unwrap_or(30_000)
                            .clamp(20, 60_000);
                        serde_json::to_value(
                            orchestration_service
                                .wait_job(&job_id, Duration::from_millis(timeout_ms))?,
                        )
                        .map_err(|error| format!("Cannot encode background job: {error}"))
                    }
                    "background_job_stdin" => {
                        let job_id = arg_str("jobId").ok_or("jobId is required")?;
                        let input = arg_str("input").ok_or("input is required")?;
                        serde_json::to_value(
                            orchestration_service.write_job_stdin(&job_id, input.as_bytes())?,
                        )
                        .map_err(|error| format!("Cannot encode background job: {error}"))
                    }
                    "task_graph_save" => {
                        let graph: TaskGraph = serde_json::from_value(
                            args.get("graph").cloned().ok_or("graph is required")?,
                        )
                        .map_err(|error| format!("Invalid task graph: {error}"))?;
                        orchestration_service.save_graph(&graph)?;
                        Ok(Value::Null)
                    }
                    "task_checkpoint" => {
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        let goal = arg_str("goal").ok_or("goal is required")?;
                        let constraints: Vec<String> = args
                            .get("constraints")
                            .and_then(Value::as_array)
                            .ok_or("constraints must be an array")?
                            .iter()
                            .map(|value| {
                                value
                                    .as_str()
                                    .map(str::to_owned)
                                    .ok_or("every constraint must be a string")
                            })
                            .collect::<Result<_, _>>()?;
                        let workspace_facts: std::collections::BTreeMap<String, String> =
                            serde_json::from_value(
                                args.get("workspaceFacts")
                                    .cloned()
                                    .unwrap_or_else(|| serde_json::json!({})),
                            )
                            .map_err(|error| format!("Invalid workspace facts: {error}"))?;
                        let constraint_refs: Vec<&str> =
                            constraints.iter().map(String::as_str).collect();
                        serde_json::to_value(orchestration_service.checkpoint(
                            &task_id,
                            &goal,
                            &constraint_refs,
                            workspace_facts,
                            &[],
                        )?)
                        .map_err(|error| format!("Cannot encode checkpoint: {error}"))
                    }
                    "subagent_policy_get" => {
                        serde_json::to_value(orchestration_service.configured_subagent_policy())
                            .map_err(|error| format!("Cannot encode Subagent policy: {error}"))
                    }
                    "subagent_policy_set" => {
                        let policy: SubagentPolicyConfiguration = serde_json::from_value(
                            args.get("policy").cloned().ok_or("policy is required")?,
                        )
                        .map_err(|error| format!("Invalid Subagent policy: {error}"))?;
                        serde_json::to_value(orchestration_service.set_subagent_policy(policy)?)
                            .map_err(|error| format!("Cannot encode Subagent policy: {error}"))
                    }
                    "subagent_spawn" => {
                        let request: DelegationRequest = serde_json::from_value(
                            args.get("request").cloned().ok_or("request is required")?,
                        )
                        .map_err(|error| format!("Invalid Subagent request: {error}"))?;
                        let use_configured_policy =
                            arg_bool("useConfiguredPolicy").unwrap_or(false);
                        let delegation_options: DelegationOptions = serde_json::from_value(
                            args.get("delegationOptions")
                                .cloned()
                                .ok_or("delegationOptions is required")?,
                        )
                        .map_err(|error| format!("Invalid delegation options: {error}"))?;
                        let thinking_level = arg_str("thinkingLevel");
                        let decision = if use_configured_policy {
                            orchestration_service.route_configured_subagent(
                                &request.task_id,
                                &request.parent_run_id,
                                &request.work,
                            )?
                        } else {
                            orchestration_service.route_subagent(&request)?
                        };
                        let advisory_spec = args
                            .get("advisory")
                            .map(|value| {
                                let role = value
                                    .get("role")
                                    .and_then(Value::as_str)
                                    .filter(|value| !value.trim().is_empty())
                                    .ok_or("advisory.role is required")?
                                    .to_owned();
                                let context_bytes = value
                                    .get("contextBytes")
                                    .and_then(Value::as_u64)
                                    .ok_or("advisory.contextBytes is required")?
                                    as usize;
                                let cost_limit_micros = value
                                    .get("costLimitMicros")
                                    .and_then(Value::as_u64)
                                    .ok_or("advisory.costLimitMicros is required")?;
                                Ok::<_, String>((role, context_bytes, cost_limit_micros))
                            })
                            .transpose()?;
                        let (pi_provider, selected_model) = if use_configured_policy {
                            decision
                                .model_id
                                .split_once('/')
                                .map(|(provider, model)| (provider.to_owned(), model.to_owned()))
                                .ok_or("configured Subagent model must be provider/model")?
                        } else {
                            (
                                arg_str("piProvider").ok_or("piProvider is required")?,
                                decision.model_id.clone(),
                            )
                        };
                        let active = accounts.active_account_for_pi_provider(&pi_provider)?;
                        let account_id = active
                            .as_ref()
                            .map(|account| account.id.as_str())
                            .unwrap_or("unmanaged")
                            .to_owned();
                        let logical_provider = active
                            .as_ref()
                            .map(|account| account.provider.as_str())
                            .unwrap_or(&pi_provider)
                            .to_owned();
                        let (shared_cwd, kind) = {
                            let control = task_control
                                .lock()
                                .map_err(|_| "Task Control lock is poisoned".to_owned())?;
                            control.validate_delegation_parent(
                                &request.parent_run_id,
                                &request.task_id,
                            )?;
                            (
                                control.task_working_dir(&request.task_id)?,
                                control.task_kind(&request.task_id)?,
                            )
                        };
                        if kind != TaskKind::Harness {
                            return Err("Subagents are available only to Harness Tasks".to_owned());
                        }
                        let (effective_policy, qualified_models) = if use_configured_policy {
                            let configured = orchestration_service.configured_subagent_policy();
                            (
                                SubagentModelPolicy {
                                    candidates: configured.candidates.clone(),
                                    fallback: configured.fallback,
                                },
                                configured
                                    .candidates
                                    .iter()
                                    .filter(|candidate| candidate.healthy)
                                    .map(|candidate| candidate.id.clone())
                                    .collect::<Vec<_>>(),
                            )
                        } else {
                            (request.policy.clone(), request.qualified_models.clone())
                        };
                        let evaluations = RoutingEvaluations::from_qualified(
                            &request.work.class,
                            &qualified_models,
                        );
                        let delegation_plan = DelegationEngine::plan_with_options(
                            &request.work,
                            &effective_policy,
                            &evaluations,
                            &delegation_options,
                        )?;
                        if delegation_plan.routing.model_id != decision.model_id {
                            return Err(
                                "Subagent policy changed while the delegation was being planned"
                                    .to_owned(),
                            );
                        }
                        let cwd = orchestration_service.delegation_workspace(
                            &request.task_id,
                            request.work.requires_write,
                            arg_str("worktreeId").as_deref(),
                            &shared_cwd,
                        )?;
                        let port = manager.next_port();
                        manager.spawn_ephemeral(&cwd.to_string_lossy(), port)?;
                        if let Err(error) = wait_for_pi_health(port, 15).await {
                            manager.kill(port);
                            return Err(error);
                        }
                        let advisory = (|| -> Result<_, String> {
                            let Some((role, context_bytes, cost_limit_micros)) = advisory_spec
                            else {
                                return Ok(None);
                            };
                            let record = extension_service.request_advisory(
                                &request.task_id,
                                &role,
                                &decision.model_id,
                                context_bytes,
                                cost_limit_micros,
                                std::collections::BTreeSet::from(["read".into(), "search".into()]),
                            )?;
                            let bound =
                                extension_service.bind_advisory_process(&record.id, port)?;
                            Ok(Some(bound))
                        })();
                        let advisory = match advisory {
                            Ok(record) => record,
                            Err(error) => {
                                manager.kill(port);
                                return Err(error);
                            }
                        };
                        let route_id = format!("picode-subagent:{}:{port}", request.task_id);
                        broker.track_background_session(port, &route_id);
                        let setup = (|| -> Result<(), String> {
                            task_control
                                .lock()
                                .map_err(|_| "Task Control lock is poisoned".to_owned())?
                                .activate_subagent_runtime(
                                    &request.task_id,
                                    &request.parent_run_id,
                                    port,
                                    &logical_provider,
                                    &account_id,
                                    &selected_model,
                                )?;
                            let context = capability_service
                                .lock()
                                .map_err(|_| "Capability Service lock is poisoned".to_owned())?
                                .prepare_task(&request.task_id, kind, Some(&cwd))?;
                            broker.send_command_to_port(
                                port,
                                serde_json::json!({ "type": "picode_task_context", "context": context }),
                            )?;
                            broker.send_command_to_port(
                                port,
                                serde_json::json!({
                                    "type": "picode_subagent_context",
                                    "parentRunId": request.parent_run_id,
                                    "envelope": decision.envelope,
                                }),
                            )?;
                            broker.send_command_to_port(
                                port,
                                serde_json::json!({
                                    "type": "set_model",
                                    "provider": pi_provider,
                                    "modelId": selected_model,
                                }),
                            )?;
                            if let Some(level) = thinking_level {
                                broker.send_command_to_port(
                                    port,
                                    serde_json::json!({
                                        "type": "set_thinking_level",
                                        "level": level,
                                    }),
                                )?;
                            }
                            broker.send_command_to_port(
                                port,
                                serde_json::json!({
                                    "type": "prompt",
                                    "message": decision.envelope.goal,
                                }),
                            )?;
                            Ok(())
                        })();
                        if let Err(error) = setup {
                            let _ = extension_service.fail_advisory_for_process(port, &error);
                            manager.kill(port);
                            broker.unregister_port(port);
                            return Err(error);
                        }
                        Ok(serde_json::json!({
                            "port": port,
                            "decision": decision,
                            "plan": delegation_plan,
                            "advisory": advisory,
                        }))
                    }
                    "git_snapshot" => {
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        let workspace = task_control
                            .lock()
                            .map_err(|_| "Task Control lock is poisoned".to_owned())?
                            .task_workspace(&task_id)?;
                        serde_json::to_value(orchestration_service.git_snapshot(&workspace)?)
                            .map_err(|error| format!("Cannot encode Git snapshot: {error}"))
                    }
                    "git_worktree_create" => {
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        let base_ref = arg_str("baseRef").ok_or("baseRef is required")?;
                        let branch = arg_str("branch").ok_or("branch is required")?;
                        let target_path = arg_str("targetPath").ok_or("targetPath is required")?;
                        let authorized = arg_bool("explicitlyAuthorized").unwrap_or(false);
                        let workspace = task_control
                            .lock()
                            .map_err(|_| "Task Control lock is poisoned".to_owned())?
                            .task_workspace(&task_id)?;
                        serde_json::to_value(orchestration_service.create_safe_worktree(
                            &task_id,
                            &workspace,
                            &base_ref,
                            &branch,
                            std::path::Path::new(&target_path),
                            authorized,
                        )?)
                        .map_err(|error| format!("Cannot encode Safe Worktree: {error}"))
                    }
                    "git_worktree_review" => {
                        let worktree_id = arg_str("worktreeId").ok_or("worktreeId is required")?;
                        Ok(serde_json::json!({
                            "review": orchestration_service.review_worktree(&worktree_id)?,
                        }))
                    }
                    "git_rewind_preview" => {
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        let target = arg_str("target").ok_or("target is required")?;
                        let workspace = task_control
                            .lock()
                            .map_err(|_| "Task Control lock is poisoned".to_owned())?
                            .task_workspace(&task_id)?;
                        serde_json::to_value(
                            orchestration_service.preview_rewind(&workspace, &target)?,
                        )
                        .map_err(|error| format!("Cannot encode rewind preview: {error}"))
                    }
                    "git_rewind_apply" => {
                        let preview: orchestration_service::GitRewindPreview =
                            serde_json::from_value(
                                args.get("preview").cloned().ok_or("preview is required")?,
                            )
                            .map_err(|error| format!("Invalid rewind preview: {error}"))?;
                        let confirmation =
                            arg_str("confirmation").ok_or("confirmation is required")?;
                        serde_json::to_value(
                            orchestration_service.apply_rewind(&preview, &confirmation)?,
                        )
                        .map_err(|error| format!("Cannot encode rewind result: {error}"))
                    }
                    "git_handoff_create" => {
                        let request: orchestration_service::HandoffRequest =
                            serde_json::from_value(
                                args.get("request").cloned().ok_or("request is required")?,
                            )
                            .map_err(|error| format!("Invalid handoff request: {error}"))?;
                        serde_json::to_value(orchestration_service.create_handoff(request)?)
                            .map_err(|error| format!("Cannot encode handoff package: {error}"))
                    }
                    "extension_install" => {
                        let manifest: ExtensionManifest = serde_json::from_value(
                            args.get("manifest")
                                .cloned()
                                .ok_or("manifest is required")?,
                        )
                        .map_err(|error| format!("Invalid extension manifest: {error}"))?;
                        extension_service.install(manifest)?;
                        Ok(
                            serde_json::to_value(extension_service.snapshot()).map_err(
                                |error| format!("Cannot encode Extension snapshot: {error}"),
                            )?,
                        )
                    }
                    "extension_snapshot" => serde_json::to_value(extension_service.snapshot())
                        .map_err(|error| format!("Cannot encode Extension snapshot: {error}")),
                    "extension_migrate" => {
                        let extension_id =
                            arg_str("extensionId").ok_or("extensionId is required")?;
                        let manifest: ExtensionManifest = serde_json::from_value(
                            args.get("manifest")
                                .cloned()
                                .ok_or("manifest is required")?,
                        )
                        .map_err(|error| format!("Invalid extension manifest: {error}"))?;
                        extension_service.migrate(
                            &extension_id,
                            manifest,
                            arg_bool("permissionExpansionApproved").unwrap_or(false),
                        )?;
                        Ok(
                            serde_json::to_value(extension_service.snapshot()).map_err(
                                |error| format!("Cannot encode Extension snapshot: {error}"),
                            )?,
                        )
                    }
                    "extension_set_enabled" => {
                        let extension_id =
                            arg_str("extensionId").ok_or("extensionId is required")?;
                        let enabled = arg_bool("enabled").ok_or("enabled is required")?;
                        extension_service.set_enabled(&extension_id, enabled)?;
                        Ok(
                            serde_json::to_value(extension_service.snapshot()).map_err(
                                |error| format!("Cannot encode Extension snapshot: {error}"),
                            )?,
                        )
                    }
                    "extension_set_trusted" => {
                        let extension_id =
                            arg_str("extensionId").ok_or("extensionId is required")?;
                        let trusted = arg_bool("trusted").ok_or("trusted is required")?;
                        extension_service.set_trusted(&extension_id, trusted)?;
                        Ok(
                            serde_json::to_value(extension_service.snapshot()).map_err(
                                |error| format!("Cannot encode Extension snapshot: {error}"),
                            )?,
                        )
                    }
                    "extension_sync_skills" => {
                        let skills: Vec<ManagedSkill> = serde_json::from_value(
                            args.get("skills")
                                .cloned()
                                .unwrap_or_else(|| serde_json::json!([])),
                        )
                        .map_err(|error| format!("Invalid skill inventory: {error}"))?;
                        extension_service.sync_skills(skills)?;
                        serde_json::to_value(extension_service.snapshot())
                            .map_err(|error| format!("Cannot encode Extension snapshot: {error}"))
                    }
                    "extension_skill_set_enabled" => {
                        let id = arg_str("id").ok_or("id is required")?;
                        let enabled = arg_bool("enabled").ok_or("enabled is required")?;
                        extension_service.set_skill_enabled(&id, enabled)?;
                        Ok(Value::Null)
                    }
                    "extension_skill_set_trusted" => {
                        let id = arg_str("id").ok_or("id is required")?;
                        let trusted = arg_bool("trusted").ok_or("trusted is required")?;
                        extension_service.set_skill_trusted(&id, trusted)?;
                        Ok(Value::Null)
                    }
                    "extension_component_set_enabled" => {
                        let id = arg_str("id").ok_or("id is required")?;
                        let enabled = arg_bool("enabled").ok_or("enabled is required")?;
                        extension_service.set_component_enabled(&id, enabled)?;
                        if matches!(id.as_str(), "rust-lsp" | "debug-adapter") {
                            capability_service
                                .lock()
                                .map_err(|_| "Capability Service lock is poisoned".to_owned())?
                                .set_module_tier(
                                    &id,
                                    if enabled {
                                        CapabilityTier::Discoverable
                                    } else {
                                        CapabilityTier::Disabled
                                    },
                                )?;
                        }
                        Ok(Value::Null)
                    }
                    "extension_component_set_trusted" => {
                        let id = arg_str("id").ok_or("id is required")?;
                        let trusted = arg_bool("trusted").ok_or("trusted is required")?;
                        extension_service.set_component_trusted(&id, trusted)?;
                        Ok(Value::Null)
                    }
                    "extension_start" => {
                        let extension_id =
                            arg_str("extensionId").ok_or("extensionId is required")?;
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        let agent_run_id = arg_str("agentRunId").ok_or("agentRunId is required")?;
                        let timeout = Duration::from_millis(
                            args.get("timeoutMs")
                                .and_then(Value::as_u64)
                                .unwrap_or(30 * 60 * 1000),
                        );
                        let cwd = {
                            let control = task_control
                                .lock()
                                .map_err(|_| "Task Control lock is poisoned".to_owned())?;
                            control.validate_agent_run(&agent_run_id, &task_id)?;
                            control.task_working_dir(&task_id)?
                        };
                        serde_json::to_value(extension_service.start_extension(
                            &extension_id,
                            &task_id,
                            &agent_run_id,
                            &cwd,
                            timeout,
                        )?)
                        .map_err(|error| format!("Cannot encode Extension run: {error}"))
                    }
                    "extension_cancel" => {
                        let run_id = arg_str("runId").ok_or("runId is required")?;
                        serde_json::to_value(extension_service.cancel_run(&run_id)?)
                            .map_err(|error| format!("Cannot encode Extension run: {error}"))
                    }
                    "external_import_preview" => {
                        let source: ExternalSource = serde_json::from_value(
                            args.get("source").cloned().ok_or("source is required")?,
                        )
                        .map_err(|error| format!("Invalid external import source: {error}"))?;
                        let root = arg_str("root").ok_or("root is required")?;
                        serde_json::to_value(
                            extension_service
                                .preview_external_import(source, std::path::Path::new(&root))?,
                        )
                        .map_err(|error| format!("Cannot encode external import preview: {error}"))
                    }
                    "external_import_apply" => {
                        let preview_id = arg_str("previewId").ok_or("previewId is required")?;
                        let candidate_ids: Vec<String> = serde_json::from_value(
                            args.get("candidateIds")
                                .cloned()
                                .ok_or("candidateIds is required")?,
                        )
                        .map_err(|error| format!("Invalid external import selection: {error}"))?;
                        let scope: ExtensionScope = serde_json::from_value(
                            args.get("scope").cloned().ok_or("scope is required")?,
                        )
                        .map_err(|error| format!("Invalid extension scope: {error}"))?;
                        serde_json::to_value(extension_service.apply_external_import(
                            &preview_id,
                            &candidate_ids,
                            scope,
                        )?)
                        .map_err(|error| format!("Cannot encode imported capabilities: {error}"))
                    }
                    "external_import_activate" => {
                        let imported_id = arg_str("importedId").ok_or("importedId is required")?;
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        let source_port = arg_u16("sourcePort").ok_or("sourcePort is required")?;
                        if manager.process_id(source_port).is_none() {
                            return Err("sourcePort is not owned by this Picode instance".into());
                        }
                        let imported = extension_service.imported(&imported_id)?;
                        let override_id = {
                            let mut control = task_control
                                .lock()
                                .map_err(|_| "Task Control lock is poisoned".to_owned())?;
                            control.validate_task_port(&task_id, source_port)?;
                            control.add_import_override(
                                &task_id,
                                &format!("import:{}", imported.id),
                                &format!(
                                    "{:?}:{}",
                                    imported.source,
                                    imported.source_path.display()
                                ),
                            )?
                        };
                        let activation = extension_service.activate_import(
                            &imported_id,
                            &task_id,
                            override_id,
                        )?;
                        let content = extension_service.imported_content(&imported_id)?;
                        broker.send_command_to_port(
                            source_port,
                            serde_json::json!({
                                "type": "picode_imported_capability",
                                "importedId": imported.id,
                                "taskId": task_id,
                                "kind": imported.kind,
                                "version": imported.version,
                                "content": content,
                            }),
                        )?;
                        Ok(serde_json::json!({
                            "activation": activation,
                            "kind": imported.kind,
                            "version": imported.version,
                        }))
                    }
                    "mcp_import_preview" => {
                        let content = arg_str("content").ok_or("content is required")?;
                        serde_json::to_value(extension_service.preview_mcp_json(&content)?)
                            .map_err(|error| format!("Cannot encode MCP import preview: {error}"))
                    }
                    "mcp_import_apply" => {
                        let preview_id = arg_str("previewId").ok_or("previewId is required")?;
                        let selected: std::collections::BTreeMap<
                            String,
                            std::collections::BTreeMap<String, SecretReference>,
                        > = serde_json::from_value(
                            args.get("selected")
                                .cloned()
                                .ok_or("selected is required")?,
                        )
                        .map_err(|error| format!("Invalid MCP secret references: {error}"))?;
                        let scope: ExtensionScope = serde_json::from_value(
                            args.get("scope").cloned().ok_or("scope is required")?,
                        )
                        .map_err(|error| format!("Invalid extension scope: {error}"))?;
                        serde_json::to_value(extension_service.apply_mcp_import(
                            &preview_id,
                            &selected,
                            scope,
                        )?)
                        .map_err(|error| format!("Cannot encode MCP configurations: {error}"))
                    }
                    "mcp_start" => {
                        let server_id = arg_str("serverId").ok_or("serverId is required")?;
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        let agent_run_id = arg_str("agentRunId").ok_or("agentRunId is required")?;
                        let timeout = Duration::from_millis(
                            args.get("timeoutMs")
                                .and_then(Value::as_u64)
                                .unwrap_or(30 * 60 * 1000),
                        );
                        let cwd = {
                            let control = task_control
                                .lock()
                                .map_err(|_| "Task Control lock is poisoned".to_owned())?;
                            control.validate_agent_run(&agent_run_id, &task_id)?;
                            control.task_working_dir(&task_id)?
                        };
                        let secrets = secret_store
                            .lock()
                            .map_err(|_| "Secret Store lock is poisoned".to_owned())?;
                        serde_json::to_value(extension_service.start_mcp(
                            &server_id,
                            &task_id,
                            &agent_run_id,
                            &cwd,
                            timeout,
                            &secrets,
                        )?)
                        .map_err(|error| format!("Cannot encode MCP run: {error}"))
                    }
                    "mcp_set_enabled" => {
                        let server_id = arg_str("serverId").ok_or("serverId is required")?;
                        let enabled = arg_bool("enabled").ok_or("enabled is required")?;
                        extension_service.set_mcp_enabled(&server_id, enabled)?;
                        Ok(Value::Null)
                    }
                    "mcp_tool_request" => {
                        let server_id = arg_str("serverId").ok_or("serverId is required")?;
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        let agent_run_id = arg_str("agentRunId").ok_or("agentRunId is required")?;
                        let method = arg_str("method").ok_or("method is required")?;
                        if !matches!(method.as_str(), "tools/list" | "tools/call") {
                            return Err("unsupported MCP tool method".into());
                        }
                        let cwd = {
                            let control = task_control
                                .lock()
                                .map_err(|_| "Task Control lock is poisoned".to_owned())?;
                            control.validate_agent_run(&agent_run_id, &task_id)?;
                            control.task_working_dir(&task_id)?
                        };
                        let secrets = secret_store
                            .lock()
                            .map_err(|_| "Secret Store lock is poisoned".to_owned())?;
                        extension_service.request_mcp_stdio(
                            &server_id,
                            &task_id,
                            &agent_run_id,
                            &cwd,
                            &method,
                            args.get("params").cloned().unwrap_or(Value::Null),
                            Duration::from_secs(30),
                            &secrets,
                        )
                    }
                    "mcp_set_trusted" => {
                        let server_id = arg_str("serverId").ok_or("serverId is required")?;
                        let trusted = arg_bool("trusted").ok_or("trusted is required")?;
                        extension_service.set_mcp_trusted(&server_id, trusted)?;
                        Ok(Value::Null)
                    }
                    "mcp_activate" => {
                        let server_id = arg_str("serverId").ok_or("serverId is required")?;
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        let source_port = arg_u16("sourcePort").ok_or("sourcePort is required")?;
                        if manager.process_id(source_port).is_none() {
                            return Err("sourcePort is not owned by this Picode instance".into());
                        }
                        task_control
                            .lock()
                            .map_err(|_| "Task Control lock is poisoned".to_owned())?
                            .validate_task_port(&task_id, source_port)?;
                        let mut activation = {
                            let secrets = secret_store
                                .lock()
                                .map_err(|_| "Secret Store lock is poisoned".to_owned())?;
                            extension_service.prepare_mcp_client(&server_id, &task_id, &secrets)?
                        };
                        let payload = serde_json::json!({
                            "type": "picode_mcp_context",
                            "config": {
                                "serverId": activation.server_id,
                                "taskId": activation.task_id,
                                "transport": activation.transport,
                                "command": activation.command,
                                "arguments": activation.arguments,
                                "url": activation.url,
                                "environment": activation.environment,
                            }
                        });
                        broker.send_command_to_port(source_port, payload)?;
                        activation
                            .environment
                            .values_mut()
                            .for_each(Zeroize::zeroize);
                        serde_json::to_value(
                            extension_service.record_mcp_client_ready(&server_id, &task_id)?,
                        )
                        .map_err(|error| format!("Cannot encode MCP activation: {error}"))
                    }
                    "adapter_register" => {
                        let adapter: ProjectAdapter = serde_json::from_value(
                            args.get("adapter").cloned().ok_or("adapter is required")?,
                        )
                        .map_err(|error| format!("Invalid project adapter: {error}"))?;
                        extension_service.register_adapter(adapter)?;
                        Ok(Value::Null)
                    }
                    "adapter_set_enabled" => {
                        let adapter_id = arg_str("adapterId").ok_or("adapterId is required")?;
                        let enabled = arg_bool("enabled").ok_or("enabled is required")?;
                        extension_service.set_adapter_enabled(&adapter_id, enabled)?;
                        Ok(Value::Null)
                    }
                    "adapter_discover" => {
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        let workspace = task_control
                            .lock()
                            .map_err(|_| "Task Control lock is poisoned".to_owned())?
                            .task_workspace(&task_id)?;
                        serde_json::to_value(extension_service.active_adapters(&workspace)?)
                            .map_err(|error| format!("Cannot encode project adapters: {error}"))
                    }
                    "dap_launch" => {
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        let agent_run_id = arg_str("agentRunId").ok_or("agentRunId is required")?;
                        let config: DapLaunchConfig = serde_json::from_value(
                            args.get("config").cloned().ok_or("config is required")?,
                        )
                        .map_err(|error| format!("Invalid DAP configuration: {error}"))?;
                        let cwd = {
                            let control = task_control
                                .lock()
                                .map_err(|_| "Task Control lock is poisoned".to_owned())?;
                            control.validate_agent_run(&agent_run_id, &task_id)?;
                            if control.task_kind(&task_id)? != execution::TaskKind::Harness {
                                return Err("DAP is available only to Harness Tasks".into());
                            }
                            control.task_workspace(&task_id)?
                        };
                        serde_json::to_value(
                            extension_service.launch_dap(
                                &task_id,
                                &agent_run_id,
                                &cwd,
                                config,
                                arg_bool("explicitlyAuthorized").unwrap_or(false),
                                Duration::from_millis(
                                    args.get("timeoutMs")
                                        .and_then(Value::as_u64)
                                        .unwrap_or(30 * 60 * 1000),
                                ),
                            )?,
                        )
                        .map_err(|error| format!("Cannot encode DAP session: {error}"))
                    }
                    "dap_record_event" => {
                        let session_id = arg_str("sessionId").ok_or("sessionId is required")?;
                        let event = arg_str("event").ok_or("event is required")?;
                        let max_events =
                            args.get("maxEvents").and_then(Value::as_u64).unwrap_or(512) as usize;
                        let session =
                            extension_service.record_dap_event(&session_id, &event, max_events)?;
                        if matches!(
                            event.split_whitespace().next(),
                            Some("terminated" | "exited")
                        ) {
                            let event_kind = event
                                .split_whitespace()
                                .next()
                                .unwrap_or("unknown")
                                .chars()
                                .take(64)
                                .collect::<String>();
                            let evidence_content = format!(
                                "dap_session={} request={} target={} event={} state={} event_count={}",
                                session.id,
                                session.request,
                                session.target,
                                event_kind,
                                session.state,
                                session.events.len()
                            );
                            let evidence = harness_service.record_external_evidence(
                                &session.task_id,
                                "dap.lifecycle",
                                evidence_content.as_bytes(),
                                &[],
                                true,
                            )?;
                            task_control
                                .lock()
                                .map_err(|_| "Task Control lock is poisoned".to_owned())?
                                .record_evidence_ref(&session.task_id, &evidence.id)?;
                            serde_json::to_value(
                                extension_service.attach_dap_evidence(&session.id, evidence.id)?,
                            )
                            .map_err(|error| format!("Cannot encode DAP session: {error}"))
                        } else {
                            Ok(Value::Null)
                        }
                    }
                    "extension_cancel_task" => {
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        extension_service.cancel_task_processes(&task_id)?;
                        Ok(Value::Null)
                    }
                    "diagnostic_add" => {
                        let finding: DiagnosticFinding = serde_json::from_value(
                            args.get("finding").cloned().ok_or("finding is required")?,
                        )
                        .map_err(|error| format!("Invalid diagnostic finding: {error}"))?;
                        extension_service.add_diagnostic(finding)?;
                        Ok(Value::Null)
                    }
                    "advisory_request" => {
                        let task_id = arg_str("taskId").ok_or("taskId is required")?;
                        let role = arg_str("role").ok_or("role is required")?;
                        let model = arg_str("model").ok_or("model is required")?;
                        let allowed_tools: std::collections::BTreeSet<String> =
                            serde_json::from_value(
                                args.get("allowedTools")
                                    .cloned()
                                    .ok_or("allowedTools is required")?,
                            )
                            .map_err(|error| format!("Invalid adviser tools: {error}"))?;
                        serde_json::to_value(
                            extension_service.request_advisory(
                                &task_id,
                                &role,
                                &model,
                                args.get("contextBytes")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(64 * 1024) as usize,
                                args.get("costLimitMicros")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(1_000_000),
                                allowed_tools,
                            )?,
                        )
                        .map_err(|error| format!("Cannot encode advisory request: {error}"))
                    }
                    "advisory_complete" => {
                        let advisory_id = arg_str("advisoryId").ok_or("advisoryId is required")?;
                        let output =
                            arg_str("candidateOutput").ok_or("candidateOutput is required")?;
                        serde_json::to_value(
                            extension_service.complete_advisory(&advisory_id, &output)?,
                        )
                        .map_err(|error| format!("Cannot encode advisory result: {error}"))
                    }
                    "regression_record" => {
                        let scenario: RegressionScenario = serde_json::from_value(
                            args.get("scenario")
                                .cloned()
                                .ok_or("scenario is required")?,
                        )
                        .map_err(|error| format!("Invalid regression scenario: {error}"))?;
                        let metrics: RegressionMetrics = serde_json::from_value(
                            args.get("metrics").cloned().ok_or("metrics is required")?,
                        )
                        .map_err(|error| format!("Invalid regression metrics: {error}"))?;
                        let artifact = arg_str("artifact").ok_or("artifact is required")?;
                        serde_json::to_value(extension_service.record_regression(
                            scenario,
                            &arg_str("picodeVersion").ok_or("picodeVersion is required")?,
                            &arg_str("model").ok_or("model is required")?,
                            metrics,
                            artifact.as_bytes(),
                        )?)
                        .map_err(|error| format!("Cannot encode regression run: {error}"))
                    }
                    "regression_compare" => {
                        let before_id = arg_str("beforeId").ok_or("beforeId is required")?;
                        let after_id = arg_str("afterId").ok_or("afterId is required")?;
                        serde_json::to_value(
                            extension_service.compare_regressions(&before_id, &after_id)?,
                        )
                        .map_err(|error| format!("Cannot encode regression comparison: {error}"))
                    }
                    "custom_provider_discover" => {
                        let base_url = arg_str("baseUrl").ok_or("baseUrl is required")?;
                        let api = arg_str("api").ok_or("api is required")?;
                        let api_key = arg_str("apiKey").ok_or("apiKey is required")?;
                        let models = discover_provider_models(&base_url, &api, &api_key).await?;
                        Ok(serde_json::json!({ "models": models }))
                    }
                    "custom_provider_save" => {
                        let provider_id = arg_str("providerId").ok_or("providerId is required")?;
                        let display_name =
                            arg_str("displayName").ok_or("displayName is required")?;
                        let base_url = arg_str("baseUrl").ok_or("baseUrl is required")?;
                        let api = arg_str("api").ok_or("api is required")?;
                        let api_key = arg_str("apiKey").ok_or("apiKey is required")?;
                        let model_values = args
                            .get("modelIds")
                            .and_then(Value::as_array)
                            .ok_or("modelIds must be an array")?;
                        if model_values.iter().any(|model| !model.is_string()) {
                            return Err("Every model ID must be a string".to_string());
                        }
                        let model_ids: Vec<String> = model_values
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect();
                        auth_sync.save_custom_provider(
                            &provider_id,
                            &display_name,
                            &api,
                            &base_url,
                            &api_key,
                            &model_ids,
                        )?;
                        notify_pi_account_reload(&manager, &broker);
                        Ok(serde_json::json!({
                            "providerId": provider_id,
                            "modelIds": model_ids,
                        }))
                    }
                    "open_workspace" => {
                        let cwd = arg_str("cwd").ok_or("cwd is required")?;
                        let session_path = arg_str("sessionPath");
                        let port = open_workspace_core(
                            &cwd,
                            session_path.as_deref(),
                            arg_bool("forceNewSession").unwrap_or(false),
                            arg_bool("openWindow").unwrap_or(true),
                            arg_bool("waitForHealth").unwrap_or(true),
                            arg_bool("waitForSessions").unwrap_or(false),
                            &manager,
                            &broker,
                            Some(&app),
                        )
                        .await?;
                        Ok(Value::from(port))
                    }
                    "new_session" => {
                        let port = resolve_control_port(arg_u16("port"), &broker)?;
                        new_session_core(port, &manager, &broker)?;
                        Ok(Value::Null)
                    }
                    "switch_session" => {
                        let session_path =
                            arg_str("sessionPath").ok_or("sessionPath is required")?;
                        let port = resolve_control_port(arg_u16("port"), &broker)?;
                        switch_session_core(port, &session_path, &manager, &broker)?;
                        Ok(Value::Null)
                    }
                    "fork" => {
                        let entry_id = arg_str("entryId").ok_or("entryId is required")?;
                        let port = resolve_control_port(arg_u16("port"), &broker)?;
                        fork_session_core(port, &entry_id, &manager, &broker)?;
                        Ok(Value::Null)
                    }
                    "clone_session" => {
                        let port = resolve_control_port(arg_u16("port"), &broker)?;
                        clone_session_core(port, &manager, &broker)?;
                        Ok(Value::Null)
                    }
                    "stop_instance" => {
                        let port = resolve_control_port(arg_u16("port"), &broker)?;
                        stop_instance_core(port, &manager, &broker);
                        Ok(Value::Null)
                    }
                    "spawn_session_process" => {
                        let session_file =
                            arg_str("sessionFile").ok_or("sessionFile is required")?;
                        let cwd = arg_str("cwd").ok_or("cwd is required")?;
                        let workspace_port =
                            resolve_control_port(arg_u16("workspacePort"), &broker)?;
                        let port = spawn_session_process_core(
                            workspace_port,
                            &session_file,
                            &cwd,
                            &manager,
                            &broker,
                        )
                        .await?;
                        Ok(Value::from(port))
                    }
                    "get_pi_version" => Ok(Value::from(locked_pi_version())),
                    "get_app_version" => Ok(Value::from(env!("CARGO_PKG_VERSION"))),
                    "is_dev" => Ok(Value::from(cfg!(debug_assertions))),
                    "pick_folder" => Ok(match pick_folder_core(&app).await {
                        Some(path) => Value::from(path),
                        None => Value::Null,
                    }),
                    "list_installed_apps" => {
                        Ok(serde_json::to_value(list_installed_apps_core()).unwrap_or(Value::Null))
                    }
                    "open_in_app" => {
                        let path = arg_str("path").ok_or("path is required")?;
                        let app_name = arg_str("appName");
                        let command = arg_str("command");
                        open_in_app_core(&path, app_name.as_deref(), command.as_deref())?;
                        Ok(Value::Null)
                    }
                    "open_external" => {
                        let url = arg_str("url").ok_or("url is required")?;
                        open_external_core(&url)?;
                        Ok(Value::Null)
                    }
                    "open_devtools" => {
                        let port = resolve_control_port(arg_u16("port"), &broker)?;
                        open_devtools_core(port, &app)?;
                        Ok(Value::Null)
                    }
                    "list_pi_packages" => {
                        let sources = manager.list_configured_package_sources()?;
                        Ok(serde_json::to_value(sources).unwrap_or(Value::Null))
                    }
                    "install_pi_package" => {
                        let source = arg_str("source").unwrap_or_default();
                        if source.trim().is_empty() {
                            return Err("Package source cannot be empty".to_string());
                        }
                        manager.install_package_source(source.trim())?;
                        Ok(Value::Null)
                    }
                    "remove_pi_package" => {
                        let source = arg_str("source").unwrap_or_default();
                        if source.trim().is_empty() {
                            return Err("Package source cannot be empty".to_string());
                        }
                        manager.remove_package_source(source.trim())?;
                        Ok(Value::Null)
                    }
                    "check_for_update" => check_for_update_core(&app).await,
                    "download_and_install_update" => {
                        download_and_install_update_core(&app, progress).await
                    }
                    "relaunch_app" => app.restart(),
                    other => Err(format!("Unknown control command: {other}")),
                }
            })
        },
    );
    broker.set_control_handler(handler);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

fn main() {
    // Sync PATH from the user's login shell before anything else.
    // macOS GUI apps (launched from Finder/Dock) inherit only the minimal
    // system PATH (/usr/bin:/bin:/usr/sbin:/sbin).  fix_path_env::fix() runs
    // the user's login shell and merges its environment into this process so
    // that all child processes (pi binary, npm, git, …) see the same tools
    // as a normal terminal session.
    if let Err(err) = fix_path_env::fix() {
        eprintln!("[picot] failed to sync PATH from login shell: {err}");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("tokio_tungstenite", log::LevelFilter::Warn)
                .level_for("tungstenite", log::LevelFilter::Warn)
                .level_for("tokio_util", log::LevelFilter::Warn)
                .level_for("hyper", log::LevelFilter::Warn)
                .build(),
        )
        .setup(|app| {
            let static_dir = find_static_dir(app);
            if native_runtime_enabled() {
                setup_native_runtime(app, static_dir).map_err(std::io::Error::other)?;
                return Ok(());
            }
            let manager = Arc::new(PiManager::new(static_dir));
            match manager.ensure_default_packages() {
                Ok(installed) if !installed.is_empty() => {
                    log::info!("Installed default Pi packages: {}", installed.join(", "));
                }
                Ok(_) => {}
                Err(error) => {
                    // A network or registry outage must not make Picode unusable.
                    // The next launch retries because the missing package was not
                    // added to Pi's settings.
                    log::warn!("Could not install default Pi packages: {error}");
                }
            }
            let broker = Arc::new(BrokerWs::start().expect("failed to start broker websocket"));
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(std::io::Error::other)?;
            let core_locator_path = app_data_dir.join(CORE_LOCATOR_FILE);
            write_locator(
                &core_locator_path,
                &CoreLocator::new(broker.port(), std::process::id(), unix_millis()),
            )
            .map_err(std::io::Error::other)?;
            app.manage(CoreLocatorPath(core_locator_path));
            let account_vault = Arc::new(AccountVault::new(app_data_dir.join("accounts.vault")));
            let accounts = Arc::new(AccountImportService::new(account_vault));
            let bindings = Arc::new(
                AccountBindingStore::open(&app_data_dir.join("account-bindings.sqlite3"))
                    .map_err(std::io::Error::other)?,
            );
            let chat_migration = Arc::new(
                ChatMigrationService::for_current_user(&app_data_dir)
                    .map_err(std::io::Error::other)?,
            );
            let chat_backup =
                Arc::new(ChatBackupService::for_current_user().map_err(std::io::Error::other)?);
            let context_compression = Arc::new(ContextCompressionService::new(
                chat_backup.clone(),
                &app_data_dir,
            ));
            let auth_sync = Arc::new(
                PiAuthSynchronizer::for_current_user().map_err(std::io::Error::other)?,
            );
            let machine_id = std::env::var("COMPUTERNAME")
                .or_else(|_| std::env::var("HOSTNAME"))
                .unwrap_or_else(|_| std::env::consts::OS.to_owned());
            let task_control = Arc::new(Mutex::new(
                TaskControl::open(&app_data_dir.join("task-control"), &machine_id)
                    .map_err(std::io::Error::other)?,
            ));
            let harness_service = Arc::new(
                HarnessService::new(app_data_dir.join("harness"), None)
                    .map_err(std::io::Error::other)?,
            );
            let legacy_capability_state = fs::read(app_data_dir.join("capabilities/state.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
            let capability_service = Arc::new(Mutex::new(
                CapabilityService::open(&app_data_dir.join("capabilities"))
                    .map_err(std::io::Error::other)?,
            ));
            let orchestration_service = Arc::new(
                OrchestrationService::open(&app_data_dir.join("orchestration"), 64 * 1024)
                    .map_err(std::io::Error::other)?,
            );
            let work_manager = Arc::new(WorkManager::new(orchestration_service.clone()));
            let code_intelligence = Arc::new(CodeIntelligence::new(
                capability_service.clone(),
                work_manager.clone(),
            ));
            let runtime_spine = Arc::new(Mutex::new(
                RuntimeSpine::open(
                    &app_data_dir.join("harness-v2").join("runtime"),
                    64 * 1024,
                    10_000,
                )
                .map_err(|error| std::io::Error::other(format!("{error:?}")))?,
            ));
            let session_kernel = Arc::new(Mutex::new(
                session_kernel::SessionKernel::open(
                    &app_data_dir.join("harness-v2").join("sessions"),
                    256 * 1024,
                )
                .map_err(std::io::Error::other)?,
            ));
            let acp_adapter = Arc::new(AcpAdapter::new(session_kernel.clone()));
            let task_experience = Arc::new(TaskExperienceService::new(
                task_control.clone(),
                session_kernel.clone(),
            ));
            let context_engine = Arc::new(
                ContextEngine::open(&app_data_dir.join("harness-v2").join("context"), 8 * 1024 * 1024)
                    .map_err(std::io::Error::other)?,
            );
            let extension_state_existed = app_data_dir
                .join("professional-extensions/state.json")
                .is_file();
            let extension_service = Arc::new(
                ExtensionManager::open(
                    &app_data_dir.join("professional-extensions"),
                    work_manager.clone(),
                )
                .map_err(std::io::Error::other)?,
            );
            extension_service
                .migrate_legacy_hook_state(&app_data_dir.join("professional-hooks"))
                .map_err(std::io::Error::other)?;
            if !extension_state_existed {
                if let Some(root) = legacy_capability_state
                    .as_ref()
                    .and_then(|state| state.get("firstmateRoot"))
                    .and_then(Value::as_str)
                {
                    if Path::new(root).is_dir() {
                        extension_service
                            .set_firstmate_root(Path::new(root))
                            .map_err(std::io::Error::other)?;
                    }
                }
                let was_enabled = legacy_capability_state
                    .as_ref()
                    .and_then(|state| state.get("moduleTiers"))
                    .and_then(|tiers| tiers.get("firstmate-crew-orchestrator"))
                    .and_then(Value::as_str)
                    .is_some_and(|tier| tier != "disabled");
                extension_service
                    .set_firstmate_enabled(was_enabled)
                    .map_err(std::io::Error::other)?;
            }
            let managed_capabilities = capability_service
                .lock()
                .map_err(|_| std::io::Error::other("Capability Service lock is poisoned"))?
                .snapshot()
                .capabilities
                .into_iter()
                .filter_map(|capability| {
                    let kind = match capability.id.as_str() {
                        "rust-lsp" => "lsp",
                        "debug-adapter" => "dap",
                        _ => return None,
                    };
                    Some(ManagedCatalogComponent {
                        id: capability.id,
                        kind: kind.into(),
                        source: "builtin:picode".into(),
                        version: capability.version,
                        license: "MIT".into(),
                        permissions: capability.permissions.into_iter().collect(),
                        enabled: capability.tier != CapabilityTier::Disabled,
                        trusted: false,
                    })
                })
                .collect::<Vec<_>>();
            for component in managed_capabilities {
                extension_service
                    .register_catalog_component(component)
                    .map_err(std::io::Error::other)?;
            }
            for component in extension_service.snapshot().catalog_components {
                capability_service
                    .lock()
                    .map_err(|_| std::io::Error::other("Capability Service lock is poisoned"))?
                    .set_module_tier(
                        &component.id,
                        if component.enabled {
                            CapabilityTier::Discoverable
                        } else {
                            CapabilityTier::Disabled
                        },
                    )
                    .map_err(std::io::Error::other)?;
            }
            capability_service
                .lock()
                .map_err(|_| std::io::Error::other("Capability Service lock is poisoned"))?
                .set_module_tier(
                    "firstmate-crew-orchestrator",
                    if extension_service.firstmate().enabled {
                        CapabilityTier::Discoverable
                    } else {
                        CapabilityTier::Disabled
                    },
                )
                .map_err(std::io::Error::other)?;
            let hook_manager = Arc::new(HookManager::new(extension_service.clone()));
            let completion_coordinator = Arc::new(CompletionCoordinator::new(2));
            let cancel_manager = manager.clone();
            let cancel_control = task_control.clone();
            let cancel_extensions = extension_service.clone();
            let cancel_work = Arc::downgrade(&work_manager);
            work_manager
                .set_external_canceller(Arc::new(move |run_id| {
                    let owner_run_id = cancel_work
                        .upgrade()
                        .and_then(|work| work.status(run_id).ok())
                        .map(|work| work.owner_run_id)
                        .unwrap_or_else(|| run_id.to_owned());
                    let target = cancel_control
                        .lock()
                        .map_err(|_| "Task Control lock is poisoned".to_owned())?
                        .cancel_target(&owner_run_id)?;
                    if !cancel_manager.owns_process(target.source_port, target.process_id) {
                        return Err(
                            "the selected Agent Run no longer owns that Pi process".to_owned()
                        );
                    }
                    cancel_manager.send_rpc(
                        target.source_port,
                        serde_json::json!({ "type": "abort" }),
                    )?;
                    let run = {
                        let mut control = cancel_control
                            .lock()
                            .map_err(|_| "Task Control lock is poisoned".to_owned())?;
                        control.cancel_agent(&owner_run_id, "cancelled through WorkManager")?;
                        control
                            .snapshot()
                            .agent_runs
                            .into_iter()
                            .find(|run| run.id == owner_run_id)
                            .ok_or_else(|| "cancelled Agent Run disappeared".to_owned())?
                    };
                    cancel_extensions.cancel_agent_processes(&owner_run_id)?;
                    if let Some(work) = cancel_work.upgrade() {
                        work.upsert_external(runtime_lifecycle::agent_work_handle(&run))?;
                    }
                    Ok(())
                }))
                .map_err(std::io::Error::other)?;
            let secret_store = Arc::new(Mutex::new(
                SecretStore::new(app_data_dir.join("temporary-secrets"))
                    .map_err(std::io::Error::other)?,
            ));
            let scratch_root = app_data_dir.join("scratch");
            let conversation_control = Arc::new(Mutex::new(ConversationControl::new(
                15_000,
                5_000,
                4_096,
            )));
            install_conversation_control(
                &broker,
                conversation_control.clone(),
                session_kernel.clone(),
            );
            let client_gateway = Arc::new(ClientGateway::new(
                Arc::new(CoreSnapshotSource {
                    manager: manager.clone(),
                    broker: broker.clone(),
                    accounts: accounts.clone(),
                    sessions: session_kernel.clone(),
                    task_control: task_control.clone(),
                    orchestration: orchestration_service.clone(),
                    extensions: extension_service.clone(),
                    work: work_manager.clone(),
                    runtime: runtime_spine.clone(),
                    conversation_control: conversation_control.clone(),
                }),
                4 * 1024 * 1024,
            ));
            std::env::set_var("PI_STUDIO_BROKER_PORT", broker.port().to_string());
            install_control_handler(
                &broker,
                manager.clone(),
                accounts.clone(),
                bindings,
                ChatDataServices {
                    migration: chat_migration,
                    backup: chat_backup,
                    compression: context_compression,
                },
                auth_sync,
                task_control.clone(),
                task_experience,
                harness_service.clone(),
                capability_service,
                orchestration_service.clone(),
                extension_service.clone(),
                runtime_spine.clone(),
                session_kernel.clone(),
                acp_adapter,
                work_manager.clone(),
                context_engine.clone(),
                code_intelligence,
                hook_manager.clone(),
                secret_store,
                scratch_root,
                client_gateway,
                conversation_control.clone(),
                app.handle().clone(),
            );
            install_task_runtime_observer(
                &broker,
                manager.clone(),
                task_control.clone(),
                extension_service.clone(),
                work_manager.clone(),
                session_kernel,
                runtime_spine.clone(),
                context_engine,
                harness_service.clone(),
                hook_manager.clone(),
                completion_coordinator,
            );
            let extension_monitor = extension_service.clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(1));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    interval.tick().await;
                    if let Err(error) = extension_monitor.refresh() {
                        log::warn!("P4 extension resource monitor failed: {error}");
                    }
                }
            });

            let (cwd, session_path) =
                select_fresh_startup_target(prepare_managed_default_workspace(&app_data_dir)?);
            log::info!(
                "[pi-desktop] fresh startup session selected for cwd={}",
                cwd
            );

            // Pick the first free port at/above 47821. We deliberately do NOT
            // reuse a port that is already in use, even if "something pi-shaped"
            // is listening on it, because:
            //
            //   1. We can't drive that process: `cmd_new_session` /
            //      `cmd_switch_session` write to *our* `PiManager.processes`
            //      map. A pi we didn't spawn (e.g. left over from an installed
            //      Picode still running, or a previous `bun run dev` whose
            //      Rust side crashed without taking its children with it) is
            //      not in that map, so every RPC fails with
            //      `No pi instance on port <p>` and the UI looks broken.
            //
            //   2. Even if we could control it, the WebView would be talking
            //      to a completely different pi process with a different cwd
            //      and a different session history. That's strictly worse
            //      than starting our own.
            //
            // Allocating a fresh port for *this* Picode instance is the
            // simple invariant that avoids both classes of confusion. The
            // tradeoff is that `http://localhost:47821` is no longer a
            // guaranteed entry point — but Picot doesn't promise that;
            // the WebView discovers its port via the window URL.
            let initial_port = manager.next_port();

            let mut startup_ok = true;
            if initial_port != 47821 {
                log::warn!(
                    "[pi-desktop] port 47821 unavailable, using {} instead (likely another Picode instance is running)",
                    initial_port
                );
            }
            if let Err(err) = manager.spawn(&cwd, initial_port, session_path.as_deref()) {
                startup_ok = false;
                log::error!("[pi-desktop] startup failed to spawn pi: {}", err);
                if let Err(window_err) = open_bootstrap_window(&app.handle().clone(), &err) {
                    log::error!(
                        "[pi-desktop] failed to open bootstrap window after startup error: {}",
                        window_err
                    );
                    app.dialog()
                        .message(format!(
                            "Picode could not start the embedded pi runtime.\n\n{}\n\nThe Picode installation may be incomplete or corrupted. Please reinstall Picode and try again.",
                            err
                        ))
                        .title("Picode startup failed")
                        .kind(MessageDialogKind::Error)
                        .show(|_| {});
                }
            }

            app.manage(manager.clone());
            app.manage(broker.clone());
            app.manage(accounts);
            app.manage(task_control);
            app.manage(orchestration_service);
            app.manage(extension_service);

            if startup_ok {
                broker.register_session(initial_port, session_path.as_deref().unwrap_or(""));
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = wait_for_pi_health(initial_port, 30).await {
                        log::error!("Pi failed to start: {}", e);
                        // Tear down the upstream reconnect loop started by
                        // register_session so it doesn't spin forever against a
                        // dead port every 750ms.
                        if let Some(broker) = app_handle.try_state::<BrokerWsState>() {
                            broker.unregister_port(initial_port);
                        }
                    } else if let Some(broker) = app_handle.try_state::<BrokerWsState>() {
                        if let Err(e) = open_workspace_window(&app_handle, initial_port, &broker.url()) {
                            log::error!("Failed to open window: {}", e);
                        }
                    } else {
                        log::error!("Failed to open window: broker websocket state missing");
                    }
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let label = window.label();
                if let Some(workspace_id) = label.strip_prefix("native-workspace-") {
                    if let Some(manager) = window.try_state::<NativePiManagerState>() {
                        manager.stop_workspace(workspace_id);
                    }
                    return;
                }
                if let Some(port_str) = label.strip_prefix("workspace-") {
                    if let Ok(port) = port_str.parse::<u16>() {
                        if let Some(manager) = window.try_state::<PiManagerState>() {
                            manager.kill_workspace_dedicated(port);
                            manager.kill(port);
                        }
                        if let Some(broker) = window.try_state::<BrokerWsState>() {
                            broker.unregister_port(port);
                        }
                    }
                }
            }
        })
        // The main UI talks to the host exclusively over the broker WebSocket
        // (`broker_control`); the only remaining Tauri IPC command is
        // `cmd_retry_startup`, used by the native bootstrap error window
        // (bootstrap.html) which is not part of the decoupled web UI.
        .invoke_handler(tauri::generate_handler![cmd_retry_startup])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle: &tauri::AppHandle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(locator) = app_handle.try_state::<CoreLocatorPath>() {
                    if let Err(error) = remove_owned_locator(&locator.0, std::process::id()) {
                        log::warn!("failed to remove owned Core locator: {error}");
                    }
                }
                if let Some(manager) = app_handle.try_state::<NativePiManagerState>() {
                    manager.stop_all();
                }
                if let Some(manager) = app_handle.try_state::<PiManagerState>() {
                    manager.kill_all();
                }
                if let Some(orchestration) = app_handle.try_state::<OrchestrationServiceState>() {
                    if let Err(error) = orchestration.cancel_all_jobs() {
                        log::error!("failed to cancel owned Picode process groups: {error}");
                    }
                }
            }
        });
}

#[cfg(test)]
mod startup_tests {
    use super::{prepare_managed_default_workspace, select_fresh_startup_target};

    #[test]
    fn fresh_startup_uses_managed_scratch_and_never_adopts_a_previous_workspace() {
        let selected = select_fresh_startup_target("/app-data/scratch/default".to_string());

        assert_eq!(selected, ("/app-data/scratch/default".to_string(), None));
    }

    #[test]
    fn managed_default_workspace_is_created_below_the_application_data_directory() {
        let root =
            std::env::temp_dir().join(format!("picode-default-workspace-{}", uuid::Uuid::new_v4()));

        let selected = prepare_managed_default_workspace(&root).unwrap();
        let expected = root.join("scratch").join("default");

        assert_eq!(std::path::PathBuf::from(selected), expected);
        assert!(expected.is_dir());

        let _ = std::fs::remove_dir_all(root);
    }
}
