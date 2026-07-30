use std::collections::HashMap;
use std::fs;
use std::io::Write;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::native_pi_manager::NativeLaunchSpec;
use serde_json::Value;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const CURSOR_OAUTH_PACKAGE: &str = "npm:@rahularya01/pi-cursor@1.4.0";
const CURSOR_OAUTH_PACKAGE_NAME: &str = "@rahularya01/pi-cursor";
const CURSOR_SDK_PACKAGE: &str = "npm:pi-cursor-sdk@0.1.61";
const CURSOR_SDK_PACKAGE_NAME: &str = "pi-cursor-sdk";
const MATT_POCOCK_SKILLS_PACKAGE: &str = "git:github.com/mattpocock/skills";
const CURSOR_BRIDGE_ORIGINAL: &str = "spawn(process.execPath,[";
const CURSOR_BRIDGE_PATCHED: &str = "spawn(process.env.PICODE_CURSOR_NODE||\"node\",[";
const CURSOR_OAUTH_REFRESH_ORIGINAL: &str =
    "async refreshModels(M){if(!M.allowNetwork||M.signal?.aborted)return r.map(Bt);";
const CURSOR_OAUTH_REFRESH_PATCHED: &str =
    "async refreshModels(M){if(M.signal?.aborted)return r.map(Bt);";

struct PiProcess {
    child: Child,
    stdin: ChildStdin,
}

pub struct PiManager {
    processes: Arc<Mutex<HashMap<u16, PiProcess>>>,
    /// Maps session_file -> port for dedicated per-session processes.
    session_ports: Arc<Mutex<HashMap<String, u16>>>,
    /// Maps workspace_port -> [dedicated session ports] for cleanup on window close.
    workspace_dedicated: Arc<Mutex<HashMap<u16, Vec<u16>>>>,
    static_dir: PathBuf,
}

struct EmbeddedExtensionResolution {
    path: String,
    /// Tag describing which candidate matched, for diagnostic logging.
    /// Examples: "bundled", "dev:source", "env:PI_STUDIO_EXTENSION".
    source: &'static str,
}

/// `scripts/pi-version.json` baked into the binary at compile time so we can
/// forward the locked pi version to the embedded server (which displays it
/// in the UI footer) without re-running fetch logic at startup.
const PI_VERSION_JSON: &str = include_str!("../../scripts/pi-version.json");

/// Locked pi version string (e.g. "0.77.0"). Resolved lazily on first call.
pub fn locked_pi_version() -> &'static str {
    static CACHED: OnceLock<String> = OnceLock::new();
    CACHED.get_or_init(|| {
        // We deliberately do a hand-rolled extraction rather than a full
        // serde_json parse: this string is baked in at compile time, the
        // schema is trivial ({"version": "..."}), and avoiding the
        // dependency makes this fn callable from `const` contexts in the
        // future if needed. If the JSON shape grows, switch to serde_json.
        let needle = "\"version\"";
        let bytes = PI_VERSION_JSON;
        let start = bytes
            .find(needle)
            .expect("pi-version.json: missing \"version\" key");
        let after_key = &bytes[start + needle.len()..];
        let colon = after_key
            .find(':')
            .expect("pi-version.json: malformed \"version\" entry");
        let after_colon = &after_key[colon + 1..];
        let first_quote = after_colon
            .find('"')
            .expect("pi-version.json: \"version\" value not quoted");
        let rest = &after_colon[first_quote + 1..];
        let end_quote = rest
            .find('"')
            .expect("pi-version.json: unterminated \"version\" value");
        rest[..end_quote].to_string()
    })
}

#[cfg(target_os = "windows")]
fn configure_child_process_for_windows(command: &mut Command) {
    // Prevent child `pi.exe` processes from creating a visible console window
    // when Picode runs as a GUI app on Windows.
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn configure_child_process_for_windows(_command: &mut Command) {}

/// Build an augmented PATH for child processes.
///
/// `fix_path_env::fix()` is called at app startup and already merges the
/// user's login-shell PATH into this process.  This function is a second
/// safety net: it appends any well-known tool directories that might still
/// be absent (e.g. nvm-managed node versions, Volta, Bun, Mise shims) so
/// that `npm`, `npx`, and friends are always reachable.
///
/// Directories already present in PATH are not duplicated.
fn build_augmented_path() -> String {
    use std::path::{Path, PathBuf};

    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|v| std::env::split_paths(&v).collect())
        .unwrap_or_default();

    #[cfg(not(target_os = "windows"))]
    {
        let mut extras: Vec<PathBuf> = vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/opt/homebrew/sbin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/local/sbin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ];

        if let Ok(home) = std::env::var("HOME") {
            let h = Path::new(&home);
            extras.push(pi_extension_npm_bin_dir(h));
            extras.push(h.join(".local/bin"));
            extras.push(h.join(".bun/bin"));
            extras.push(h.join(".volta/bin"));
            extras.push(h.join(".cargo/bin"));
            extras.push(h.join(".local/share/mise/shims"));
            // nvm: enumerate all installed node versions
            let nvm_root = h.join(".nvm/versions/node");
            if let Ok(entries) = std::fs::read_dir(nvm_root) {
                for entry in entries.flatten() {
                    let bin = entry.path().join("bin");
                    if bin.is_dir() {
                        extras.push(bin);
                    }
                }
            }
        }

        for extra in extras {
            if !dirs.iter().any(|d| d == &extra) {
                dirs.push(extra);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let mut extras: Vec<PathBuf> = Vec::new();
        if let Ok(appdata) = std::env::var("APPDATA") {
            extras.push(Path::new(&appdata).join("npm"));
        }
        if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
            let h = Path::new(&home);
            extras.push(pi_extension_npm_bin_dir(h));
            extras.push(h.join(".cargo").join("bin"));
            extras.push(h.join(".bun").join("bin"));
            extras.push(h.join("scoop").join("shims"));
        }
        for extra in extras {
            if !dirs.iter().any(|d| d == &extra) {
                dirs.push(extra);
            }
        }
    }

    std::env::join_paths(dirs)
        .ok()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
}

fn pi_extension_npm_bin_dir(home: &Path) -> PathBuf {
    home.join(".pi")
        .join("agent")
        .join("npm")
        .join("node_modules")
        .join(".bin")
}

fn log_child_path_diagnostics(context: &str, path: &str) {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok();
    let Some(home) = home else {
        log::info!(
            "[pi-desktop] child PATH diagnostics: context={} home=<unset> path={}",
            context,
            path
        );
        return;
    };

    let pi_extension_bin = pi_extension_npm_bin_dir(Path::new(&home));
    let hypa_bin = pi_extension_bin.join(if cfg!(target_os = "windows") {
        "hypa.cmd"
    } else {
        "hypa"
    });
    let dirs: Vec<PathBuf> = std::env::split_paths(path).collect();
    let contains_pi_extension_bin = dirs.iter().any(|dir| dir == &pi_extension_bin);

    log::info!(
        "[pi-desktop] child PATH diagnostics: context={} pi_extension_bin={} exists={} hypa_bin={} hypa_exists={} contains_pi_extension_bin={} path={}",
        context,
        pi_extension_bin.display(),
        pi_extension_bin.is_dir(),
        hypa_bin.display(),
        hypa_bin.is_file(),
        contains_pi_extension_bin,
        path
    );
}

/// Strip a Windows verbatim / extended-length path prefix (`\\?\` or
/// `\\?\UNC\`) from a path string.
///
/// Tauri's `resource_dir()` returns extended-length paths (e.g.
/// `\\?\C:\Users\...\Picode\pi\pi.exe`). The embedded pi (Bun 1.3.10,
/// Windows arm64, compiled standalone) segfaults (`Segmentation fault at
/// address 0x18`) when it is launched with — or asked to load an
/// `--extension` from — a `\\?\`-prefixed path. Passing the plain
/// `C:\Users\...` form avoids the crash. This is a no-op on non-Windows
/// platforms and for paths without the prefix.
fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        // `\\?\UNC\server\share` -> `\\server\share`
        format!(r"\\{}", rest)
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

/// Return a path to the embedded-server extension that is safe to pass as a
/// `--extension` argument to the embedded pi binary.
///
/// On Windows the Bun-compiled pi binary truncates `--extension` values at the
/// first space (e.g. `C:\...\Picode\...\embedded-server.mjs` is loaded as
/// `C:\...\Pi`), which then fails to load and segfaults the process. Since Pi
/// Studio always installs under a space-containing path, we mirror the
/// extension file into a space-free directory under the system temp dir and
/// return that path instead. The copy is idempotent (skipped when an existing
/// mirror already matches by length + mtime), so repeated spawns are cheap.
///
/// On non-Windows platforms, or when the path has no space, the original path
/// is returned unchanged.
#[cfg(not(target_os = "windows"))]
fn sanitize_extension_path_for_pi(original: &str) -> String {
    original.to_string()
}

#[cfg(target_os = "windows")]
fn sanitize_extension_path_for_pi(original: &str) -> String {
    if !original.contains(' ') {
        return original.to_string();
    }

    match mirror_to_space_free_dir(Path::new(original)) {
        Ok(mirrored) => {
            log::info!(
                "[pi-desktop] extension path contains spaces; mirrored to space-free path: {} -> {}",
                original,
                mirrored.display()
            );
            mirrored.to_string_lossy().to_string()
        }
        Err(e) => {
            // Non-fatal: fall back to the original path. Worst case is the
            // pre-existing crash, but we don't want the mirroring step itself
            // to be a new hard failure mode.
            log::warn!(
                "[pi-desktop] failed to mirror extension to space-free path ({}); using original: {}",
                e,
                original
            );
            original.to_string()
        }
    }
}

/// Copy `src` into `<temp>/pi-studio-ext/<filename>` (a space-free directory),
/// skipping the copy when an up-to-date mirror already exists. Returns the
/// mirrored path.
#[cfg(target_os = "windows")]
fn mirror_to_space_free_dir(src: &Path) -> std::io::Result<PathBuf> {
    let file_name = src.file_name().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "extension path has no file name",
        )
    })?;

    let mut dest_dir = std::env::temp_dir();
    // Guard: if the temp dir itself contains a space, fall back to a
    // well-known space-free root so the workaround actually helps.
    if dest_dir.to_string_lossy().contains(' ') {
        dest_dir = PathBuf::from("C:\\ProgramData\\pi-studio");
    }
    dest_dir.push("pi-studio-ext");
    std::fs::create_dir_all(&dest_dir)?;

    let dest = dest_dir.join(file_name);

    if mirror_is_up_to_date(src, &dest) {
        return Ok(dest);
    }

    std::fs::copy(src, &dest)?;
    Ok(dest)
}

/// Cheap freshness check: the mirror is considered current when it exists and
/// matches the source by byte length and modified time. This avoids re-copying
/// the extension on every spawn while still picking up updated builds.
#[cfg(target_os = "windows")]
fn mirror_is_up_to_date(src: &Path, dest: &Path) -> bool {
    let (Ok(src_meta), Ok(dest_meta)) = (std::fs::metadata(src), std::fs::metadata(dest)) else {
        return false;
    };
    if src_meta.len() != dest_meta.len() {
        return false;
    }
    match (src_meta.modified(), dest_meta.modified()) {
        (Ok(src_mtime), Ok(dest_mtime)) => dest_mtime >= src_mtime,
        _ => false,
    }
}

fn package_source_contains(source: &str, package_name: &str) -> bool {
    let source = source.trim().strip_prefix("npm:").unwrap_or(source.trim());
    source == package_name
        || source
            .strip_prefix(package_name)
            .is_some_and(|suffix| suffix.starts_with('@'))
}

fn missing_default_package_sources(sources: &[String]) -> Vec<&'static str> {
    if sources.iter().any(|source| {
        let normalized = source.trim().trim_end_matches(".git").to_ascii_lowercase();
        normalized == "git:github.com/mattpocock/skills"
            || normalized == "https://github.com/mattpocock/skills"
            || normalized.starts_with("git:github.com/mattpocock/skills@")
            || normalized.starts_with("https://github.com/mattpocock/skills@")
    }) {
        Vec::new()
    } else {
        vec![MATT_POCOCK_SKILLS_PACKAGE]
    }
}

fn node_version_at_least_22_19(output: &str) -> bool {
    let mut parts = output.trim().trim_start_matches('v').split('.');
    let Some(major) = parts.next().and_then(|value| value.parse::<u64>().ok()) else {
        return false;
    };
    let minor = parts
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    major > 22 || (major == 22 && minor >= 19)
}

fn patch_cursor_bridge_contents(contents: &str) -> Result<Option<String>, String> {
    if contents.contains(CURSOR_BRIDGE_PATCHED) {
        return Ok(None);
    }
    let matches = contents.matches(CURSOR_BRIDGE_ORIGINAL).count();
    if matches != 1 {
        return Err(format!(
            "The pinned Cursor OAuth extension has an unexpected bridge layout ({matches} matches); refusing to modify third-party code"
        ));
    }
    Ok(Some(contents.replacen(
        CURSOR_BRIDGE_ORIGINAL,
        CURSOR_BRIDGE_PATCHED,
        1,
    )))
}

fn patch_cursor_oauth_model_refresh_contents(contents: &str) -> Result<Option<String>, String> {
    if contents.contains(CURSOR_OAUTH_REFRESH_PATCHED) {
        return Ok(None);
    }
    let matches = contents.matches(CURSOR_OAUTH_REFRESH_ORIGINAL).count();
    if matches != 1 {
        return Err(format!(
            "The pinned Cursor OAuth extension has an unexpected model refresh layout ({matches} matches); refusing to modify third-party code"
        ));
    }
    Ok(Some(contents.replacen(
        CURSOR_OAUTH_REFRESH_ORIGINAL,
        CURSOR_OAUTH_REFRESH_PATCHED,
        1,
    )))
}

fn pi_agent_dir() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("PI_CODING_AGENT_DIR").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    dirs::home_dir()
        .map(|home| home.join(".pi").join("agent"))
        .ok_or_else(|| "Cannot find the current user's home directory".to_string())
}

impl PiManager {
    pub fn new(static_dir: PathBuf) -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
            session_ports: Arc::new(Mutex::new(HashMap::new())),
            workspace_dedicated: Arc::new(Mutex::new(HashMap::new())),
            static_dir,
        }
    }

    #[allow(dead_code)]
    pub fn native_launch_spec(
        &self,
        cwd: &str,
        session_path: Option<&str>,
    ) -> Result<NativeLaunchSpec, String> {
        let binary = self.resolve_bundled_pi()?;
        let mut candidates = Vec::new();
        if let Some(resources) = self.static_dir.parent() {
            candidates.push(resources.join("extensions").join("picot-bridge.mjs"));
        }
        if cfg!(debug_assertions) {
            candidates.push(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("extensions")
                    .join("dist")
                    .join("picot-bridge.mjs"),
            );
            candidates.push(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("extensions")
                    .join("picot-bridge.ts"),
            );
        }
        let bridge = candidates
            .iter()
            .find(|candidate| candidate.is_file())
            .cloned()
            .ok_or_else(|| {
                format!(
                    "Could not find picot-bridge extension. Tried:\n{}",
                    candidates
                        .iter()
                        .map(|path| format!("  - {}", path.display()))
                        .collect::<Vec<_>>()
                        .join("\n")
                )
            })?;
        Ok(NativeLaunchSpec {
            binary,
            cwd: PathBuf::from(cwd),
            session_path: session_path.map(PathBuf::from),
            extensions: vec![PathBuf::from(sanitize_extension_path_for_pi(
                &strip_verbatim_prefix(&bridge.to_string_lossy()),
            ))],
            pi_version: locked_pi_version().to_owned(),
            path_env: build_augmented_path(),
        })
    }

    /// Locate the embedded pi binary shipped inside the Tauri bundle.
    ///
    /// Lookup order:
    /// 1. `PI_BIN` env var (escape hatch for testing a different binary).
    /// 2. `<static_dir>/../pi/<bin>` — the production location, sibling of
    ///    the bundled `public/` and `extensions/` resource dirs.
    /// 3. *Debug builds only:* `<repo>/src-tauri/resources/pi/<bin>` —
    ///    populated by `bun run fetch:pi`, used during `tauri dev`.
    ///
    /// Returns `Err` (not `Ok(None)`) if no binary is found, so callers can
    /// surface a clear "run `bun run fetch:pi`" message rather than spawning
    /// a missing/stale binary.
    fn resolve_bundled_pi(&self) -> Result<PathBuf, String> {
        let bin_name = if cfg!(target_os = "windows") {
            "pi.exe"
        } else {
            "pi"
        };

        // Explicit override (rare; useful when smoke-testing a hand-built pi).
        if let Ok(explicit) = std::env::var("PI_BIN") {
            let candidate = PathBuf::from(explicit.trim());
            if candidate.is_file() {
                return Ok(candidate);
            }
        }

        let mut tried: Vec<PathBuf> = Vec::new();
        let bundled = self
            .static_dir
            .parent()
            .map(|parent| parent.join("pi").join(bin_name));
        if let Some(p) = bundled.clone() {
            if p.is_file() {
                return Ok(p);
            }
            tried.push(p);
        }

        if cfg!(debug_assertions) {
            let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join("pi")
                .join(bin_name);
            if dev_path.is_file() {
                return Ok(dev_path);
            }
            tried.push(dev_path);
        }

        let tried_str = tried
            .iter()
            .map(|p| format!("  - {}", p.display()))
            .collect::<Vec<_>>()
            .join("\n");
        Err(format!(
            "Could not find embedded pi binary. Tried:\n{}\n\n\
             For dev: run `bun run fetch:pi` from the repo root.\n\
             For release: the .app bundle is missing `resources/pi/{}`. \
             Reinstall Picode.",
            tried_str, bin_name
        ))
    }

    /// Locate the embedded-server extension shipped with this build.
    ///
    /// Returns the first existing candidate from this priority order:
    ///
    /// 1. `PI_STUDIO_EXTENSION` env var (explicit override; useful for tests).
    /// 2. Bundled `extensions/embedded-server.mjs` next to `static_dir`. This
    ///    is what shipped Picode installs use; the bundle is produced by
    ///    `scripts/build-extensions.js` and is fully self-contained (no
    ///    `node_modules` lookup at runtime).
    /// 3. Source `extensions/embedded-server.ts` next to `static_dir`. Used
    ///    by `tauri dev` where pi loads the raw `.ts` via jiti against the
    ///    repo's `node_modules/`.
    /// 4. *Debug builds only:* repo-relative paths via `CARGO_MANIFEST_DIR`
    ///    and `cwd`. These are gated to debug builds because
    ///    `CARGO_MANIFEST_DIR` is a compile-time string and would otherwise
    ///    silently "work" only on the build machine.
    ///
    /// Returns `Err` (not `Ok(None)`) when nothing is found, so callers can
    /// fail-fast and surface the error to the user instead of silently
    /// spawning a pi that has no `/api` surface.
    fn resolve_embedded_extension_path(&self) -> Result<EmbeddedExtensionResolution, String> {
        if let Ok(explicit) = std::env::var("PI_STUDIO_EXTENSION") {
            let candidate = explicit.trim();
            if !candidate.is_empty() && Path::new(candidate).exists() {
                return Ok(EmbeddedExtensionResolution {
                    path: candidate.to_string(),
                    source: "env:PI_STUDIO_EXTENSION",
                });
            }
        }

        let mut candidates: Vec<(PathBuf, &'static str)> = Vec::new();

        // Compile-time path fallbacks: only useful while developing locally.
        // Prefer the live source in debug builds before any target/debug bundle:
        // that bundle can be stale after frontend/extension edits and causes the
        // dev app to serve old API behavior until a full resource copy happens.
        if cfg!(debug_assertions) {
            candidates.push((
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("extensions")
                    .join("embedded-server.ts"),
                "dev:cargo-manifest-dir",
            ));
            if let Ok(cwd) = std::env::current_dir() {
                candidates.push((cwd.join("extensions").join("embedded-server.ts"), "dev:cwd"));
            }
        }

        if let Some(parent) = self.static_dir.parent() {
            candidates.push((
                parent.join("extensions").join("embedded-server.mjs"),
                "bundled",
            ));
            candidates.push((
                parent.join("extensions").join("embedded-server.ts"),
                "dev:source",
            ));
        }

        for (candidate, source) in &candidates {
            if candidate.exists() {
                return Ok(EmbeddedExtensionResolution {
                    path: candidate.to_string_lossy().to_string(),
                    source,
                });
            }
        }

        let tried = candidates
            .into_iter()
            .map(|(p, source)| format!("  - [{}] {}", source, p.display()))
            .collect::<Vec<_>>()
            .join("\n");
        Err(format!(
            "Could not find embedded-server extension. Tried:\n{}\n\n\
             For release builds, this means the .app bundle is missing \
             `extensions/embedded-server.mjs` (run `bun run build:extensions` \
             before `tauri build`). For dev, make sure `extensions/embedded-server.ts` \
             exists in this repo.",
            tried
        ))
    }

    /// Locate the bundled pi-chat extension, if present.
    ///
    /// Returns `None` when the extension cannot be found (e.g. in a dev build
    /// before `bun run build:extensions` has been run). The caller should treat
    /// a missing pi-chat extension as non-fatal — pi-chat is optional.
    fn resolve_pi_chat_extension_path(&self) -> Option<String> {
        let mut candidates: Vec<PathBuf> = Vec::new();

        if cfg!(debug_assertions) {
            candidates.push(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("extensions")
                    .join("dist")
                    .join("pi-chat.mjs"),
            );
            if let Ok(cwd) = std::env::current_dir() {
                candidates.push(cwd.join("extensions").join("dist").join("pi-chat.mjs"));
            }
        }

        if let Some(parent) = self.static_dir.parent() {
            candidates.push(parent.join("extensions").join("pi-chat.mjs"));
        }

        for candidate in &candidates {
            if candidate.exists() {
                return Some(sanitize_extension_path_for_pi(&strip_verbatim_prefix(
                    &candidate.to_string_lossy(),
                )));
            }
        }
        None
    }

    pub fn spawn(&self, cwd: &str, port: u16, session_path: Option<&str>) -> Result<(), String> {
        self.spawn_inner(cwd, port, session_path, false)
    }

    /// Start an isolated Pi runtime that never creates a session in the user's
    /// chat history. Used for explicit, one-shot semantic processing jobs.
    pub fn spawn_ephemeral(&self, cwd: &str, port: u16) -> Result<(), String> {
        self.spawn_inner(cwd, port, None, true)
    }

    fn spawn_inner(
        &self,
        cwd: &str,
        port: u16,
        session_path: Option<&str>,
        ephemeral: bool,
    ) -> Result<(), String> {
        // Existing OAuth installs may predate the live model refresh patch.
        // Apply it on the next explicit Picode start without scanning or
        // importing any system credentials.
        if let Err(error) = self.patch_existing_cursor_oauth_integration() {
            log::warn!("[cursor] could not prepare live model refresh: {}", error);
        }
        let pi_bin = self.resolve_bundled_pi()?;
        // Tauri resolves resource paths as `\\?\`-prefixed extended-length
        // paths. Bun (the embedded pi runtime) segfaults on Windows arm64 when
        // launched from such a path, so normalize the binary path and every
        // path-shaped argument/env we hand to it back to the plain form.
        let pi_bin_str = strip_verbatim_prefix(&pi_bin.to_string_lossy());
        let static_dir = strip_verbatim_prefix(&self.static_dir.to_string_lossy());
        let cwd = strip_verbatim_prefix(cwd);

        // We treat a missing embedded-server extension as a hard error
        // rather than continuing to spawn pi without `--extension`. Without
        // the extension, pi runs as a plain RPC process with no
        // `/api/sessions` or `/ws`, which the web UI then renders as
        // "Failed to load sessions" / "Disconnected" — a confusing soft
        // failure that hides the real bundling bug.
        let extension = self.resolve_embedded_extension_path()?;
        log::info!(
            "[pi-desktop] embedded-server resolved: source={} path={}",
            extension.source,
            extension.path
        );

        // The embedded pi (Bun-compiled standalone) mis-parses `--extension`
        // paths that contain spaces on Windows: it truncates at the first
        // space, so `...\Picode\extensions\embedded-server.mjs` is loaded
        // as `...\Pi`, which then fails to load and crashes the process
        // (segfault) during extension-load error handling. The primary fix is
        // the space-free `productName` ("Picode") so the install dir has no
        // space; this mirroring remains as a defensive fallback for paths that
        // can still contain spaces out of our control (e.g. a Windows username
        // like `C:\Users\Shi Xin\...`). Work around it by mirroring the
        // extension into a space-free directory and passing that path instead.
        //
        // Also strip the `\\?\` verbatim prefix first: Bun on Windows arm64
        // segfaults when loading an extension from an extended-length path.
        let extension_path =
            sanitize_extension_path_for_pi(&strip_verbatim_prefix(&extension.path));

        let mut args: Vec<String> = vec!["--extension".to_string(), extension_path];

        // Load pi-chat extension only in the Super Agent workspace to avoid
        // multiple processes competing for the same Telegram updates.
        let is_super_agent_workspace = std::env::var("HOME")
            .map(|home| cwd == format!("{}/.pi/agent/super-agent", home))
            .unwrap_or(false);
        if is_super_agent_workspace {
            if let Some(pi_chat_path) = self.resolve_pi_chat_extension_path() {
                log::info!(
                    "[pi-desktop] pi-chat extension resolved for super-agent workspace: {}",
                    pi_chat_path
                );
                args.push("--extension".to_string());
                args.push(pi_chat_path);
            } else {
                log::debug!("[pi-desktop] pi-chat extension not found; skipping");
            }
        }

        args.extend(["--mode".to_string(), "rpc".to_string()]);

        if ephemeral {
            args.push("--no-session".to_string());
        }

        if let Some(session) = session_path {
            args.push("--session".to_string());
            args.push(session.to_string());
        }

        log::info!(
            "[pi-desktop] spawning pi: bin={} args={:?} cwd={} port={} static_dir={}",
            pi_bin_str,
            args,
            cwd,
            port,
            static_dir
        );

        let augmented_path = build_augmented_path();
        log_child_path_diagnostics("spawn", &augmented_path);

        let mut child = Command::new(&pi_bin_str);
        configure_child_process_for_windows(&mut child);
        child
            .args(&args)
            .current_dir(&cwd)
            .env("PATH", augmented_path)
            .env("PI_STUDIO_STATIC_DIR", &static_dir)
            .env("PI_STUDIO_PORT", port.to_string())
            .env("PI_STUDIO_PI_VERSION", locked_pi_version())
            // Cursor credentials are never scraped implicitly. The only path
            // into Picode's Pi auth store is the explicit import/activation UI.
            .env("PI_CURSOR_SYSTEM_CREDENTIALS", "0")
            // pi-cursor-sdk caches its discovered catalog for 24 hours by
            // default. Picode refreshes the catalog after explicit account
            // activation, so keep the provider cache disabled to avoid
            // showing yesterday's Cursor model list in the GUI.
            .env("PI_CURSOR_SDK_DISABLE_MODEL_CACHE", "1")
            .env("PICODE_CURSOR_NODE", "node")
            .stdin(Stdio::piped())
            // Drop stdout: pi emits RPC frames on it that we don't consume here, and
            // letting it fill an unread pipe would eventually block the child.
            .stdout(Stdio::null())
            // Inherit stderr so pi's startup/runtime errors are visible in the same
            // terminal running `bun run dev` — critical for diagnosing failures of
            // new_session / open_workspace that would otherwise be silent.
            .stderr(Stdio::inherit());

        let spawn_started_at = Instant::now();
        let mut child = child.spawn().map_err(|e| {
            format!(
                "Failed to spawn embedded pi ({}): {}. \
                 The bundled binary may be corrupted or unsupported on this OS/arch. \
                 Reinstall Picode, or for dev rerun `bun run fetch:pi`.",
                pi_bin.display(),
                e,
            )
        })?;
        log::info!(
            "[pi-desktop] pi process spawned: port={} pid={} elapsed_ms={}",
            port,
            child.id(),
            spawn_started_at.elapsed().as_millis()
        );
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to get pi stdin".to_string())?;

        let mut lock = self.processes.lock().unwrap();
        lock.insert(port, PiProcess { child, stdin });

        Ok(())
    }

    /// Send an RPC command to a pi instance (JSON line on stdin)
    pub fn send_rpc(&self, port: u16, cmd: serde_json::Value) -> Result<(), String> {
        let mut lock = self.processes.lock().unwrap();
        let proc = lock
            .get_mut(&port)
            .ok_or_else(|| format!("No pi instance on port {}", port))?;
        let mut line = cmd.to_string();
        line.push('\n');
        proc.stdin
            .write_all(line.as_bytes())
            .map_err(|e| e.to_string())
    }

    pub fn ports(&self) -> Vec<u16> {
        self.processes.lock().unwrap().keys().copied().collect()
    }

    /// Return the OS process identity owned by this host for one exact Pi
    /// source port. Runtime controls use the pair rather than guessing via the
    /// broker's active port or accepting an arbitrary live PID.
    pub fn process_id(&self, port: u16) -> Option<u32> {
        self.processes
            .lock()
            .ok()?
            .get(&port)
            .map(|process| process.child.id())
    }

    pub fn owns_process(&self, port: u16, process_id: u32) -> bool {
        self.process_id(port) == Some(process_id)
    }

    /// Returns `Some(exit_status_string)` if the process has already exited, `None` if still running.
    pub fn check_exited(&self, port: u16) -> Option<String> {
        let mut lock = self.processes.lock().unwrap();
        let proc = lock.get_mut(&port)?;
        match proc.child.try_wait() {
            Ok(Some(status)) => Some(format!("{}", status)),
            _ => None,
        }
    }

    pub fn kill(&self, port: u16) {
        let mut lock = self.processes.lock().unwrap();
        if let Some(mut proc) = lock.remove(&port) {
            let _ = proc.child.kill();
        }
    }

    pub fn kill_all(&self) {
        let mut lock = self.processes.lock().unwrap();
        for (_, mut proc) in lock.drain() {
            let _ = proc.child.kill();
        }
    }

    /// Spawn (or reuse) a dedicated pi process for a specific session file,
    /// so it can run concurrently with the workspace's primary process.
    /// Returns the port the dedicated process is listening on.
    pub fn spawn_session_dedicated(
        &self,
        workspace_port: u16,
        session_file: String,
        cwd: &str,
    ) -> Result<u16, String> {
        {
            let sp = self.session_ports.lock().unwrap();
            if let Some(&port) = sp.get(&session_file) {
                return Ok(port);
            }
        }
        let port = self.next_port();
        self.spawn(cwd, port, Some(&session_file))?;
        {
            let mut sp = self.session_ports.lock().unwrap();
            sp.insert(session_file, port);
        }
        {
            let mut wd = self.workspace_dedicated.lock().unwrap();
            wd.entry(workspace_port).or_default().push(port);
        }
        Ok(port)
    }

    /// Kill all dedicated session processes spawned for a workspace port.
    /// Called when the workspace window is destroyed.
    pub fn kill_workspace_dedicated(&self, workspace_port: u16) {
        let dedicated_ports = {
            let mut wd = self.workspace_dedicated.lock().unwrap();
            wd.remove(&workspace_port).unwrap_or_default()
        };
        for port in &dedicated_ports {
            self.kill(*port);
        }
        if !dedicated_ports.is_empty() {
            let port_set: std::collections::HashSet<u16> = dedicated_ports.into_iter().collect();
            let mut sp = self.session_ports.lock().unwrap();
            sp.retain(|_, v| !port_set.contains(v));
        }
    }

    /// Stop and forget the dedicated process assigned to one session.
    /// Used when startup never reaches the health endpoint so a later retry
    /// can allocate a clean process instead of reusing a permanently bad one.
    pub fn kill_session_dedicated(&self, session_file: &str) {
        let port = self.session_ports.lock().unwrap().remove(session_file);
        let Some(port) = port else {
            return;
        };

        self.kill(port);
        let mut workspaces = self.workspace_dedicated.lock().unwrap();
        for ports in workspaces.values_mut() {
            ports.retain(|candidate| *candidate != port);
        }
        workspaces.retain(|_, ports| !ports.is_empty());
    }

    pub fn next_port(&self) -> u16 {
        let lock = self.processes.lock().unwrap();
        let mut port = 47821u16;
        while lock.contains_key(&port) || is_port_in_use(port) {
            port += 1;
        }
        port
    }

    /// Run `pi <args...>` with the embedded binary and return stdout.
    /// Used by Settings UI package management operations (install/remove/list).
    pub fn run_pi_command(&self, args: &[String]) -> Result<String, String> {
        let pi_bin = self.resolve_bundled_pi()?;
        let pi_bin_str = strip_verbatim_prefix(&pi_bin.to_string_lossy());
        let augmented_path = build_augmented_path();
        log_child_path_diagnostics("run_pi_command", &augmented_path);
        let mut command = Command::new(&pi_bin_str);
        configure_child_process_for_windows(&mut command);
        command
            .args(args)
            .env("PATH", augmented_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output = command.output().map_err(|e| {
            format!(
                "Failed to run embedded pi command ({} {:?}): {}",
                pi_bin_str, args, e
            )
        })?;
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let details = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("exit status {}", output.status)
        };
        Err(format!(
            "Embedded pi command failed: {} {:?}: {}",
            pi_bin_str, args, details
        ))
    }

    /// Parse `pi list` output and extract package sources.
    pub fn list_configured_package_sources(&self) -> Result<Vec<String>, String> {
        let args = vec!["list".to_string()];
        let output = self.run_pi_command(&args)?;
        let mut sources = Vec::new();
        for line in output.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if trimmed.eq_ignore_ascii_case("No packages installed.") {
                continue;
            }
            if trimmed.ends_with(':') {
                continue;
            }
            if let Some(rest) = trimmed.strip_prefix('-') {
                let value = rest.trim();
                if !value.is_empty() {
                    sources.push(value.to_string());
                }
                continue;
            }
            // `pi list` currently emits entries prefixed with two spaces.
            if let Some(value) = trimmed.strip_prefix("npm:") {
                sources.push(format!("npm:{}", value));
                continue;
            }
            if let Some(value) = trimmed.strip_prefix("git:") {
                sources.push(format!("git:{}", value));
                continue;
            }
            if trimmed.starts_with('/') || trimmed.starts_with("./") || trimmed.starts_with("../") {
                sources.push(trimmed.to_string());
            }
        }
        Ok(sources)
    }

    /// Install Picode's default skill bundle once. Pi records the source in
    /// the user's own settings and loads it for subsequent runtimes; existing
    /// package entries, including version-pinned entries, are left untouched.
    pub fn ensure_default_packages(&self) -> Result<Vec<String>, String> {
        let sources = self.list_configured_package_sources()?;
        let missing = missing_default_package_sources(&sources);
        for source in &missing {
            self.install_package_source(source)?;
        }
        Ok(missing.into_iter().map(str::to_owned).collect())
    }

    /// Ensure the Cursor provider package selected by an explicitly activated
    /// account is installed. Cursor API-key accounts use the official
    /// `@cursor/sdk`-backed Pi package; imported Desktop/CLI OAuth accounts
    /// use the separately marked, unofficial bridge. Both packages register
    /// provider id `cursor`, so silently installing both would make provider
    /// behavior depend on load order.
    pub fn ensure_cursor_integration(&self, metadata: &Value) -> Result<(), String> {
        let credential_kind = metadata
            .get("credentialKind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let wants_oauth = credential_kind == "cursor_ide_cli_oauth";
        let sources = self.list_configured_package_sources()?;
        let official_installed = sources
            .iter()
            .any(|source| package_source_contains(source, CURSOR_SDK_PACKAGE_NAME));
        let oauth_installed = sources
            .iter()
            .any(|source| package_source_contains(source, CURSOR_OAUTH_PACKAGE_NAME));

        if wants_oauth {
            if official_installed {
                return Err(
                    "Cursor OAuth cannot be activated while the official pi-cursor-sdk package is installed. Keep the official SDK for API-key accounts, or remove it explicitly before trying the experimental OAuth integration."
                        .to_string(),
                );
            }
            self.require_node_22()?;
            if !oauth_installed {
                self.install_package_source(CURSOR_OAUTH_PACKAGE)?;
            }
            self.patch_installed_cursor_oauth_bridge()?;
        } else {
            if oauth_installed {
                return Err(
                    "Cursor SDK API-key accounts cannot be activated while the experimental pi-cursor OAuth package is installed. Remove that package explicitly before using the official SDK."
                        .to_string(),
                );
            }
            self.require_node_22()?;
            if !official_installed {
                self.install_package_source(CURSOR_SDK_PACKAGE)?;
            }
        }
        Ok(())
    }

    fn require_node_22(&self) -> Result<(), String> {
        let augmented_path = build_augmented_path();
        let mut command = Command::new("node");
        configure_child_process_for_windows(&mut command);
        let output = command
            .arg("--version")
            .env("PATH", augmented_path)
            .output()
            .map_err(|_| {
                "Cursor SDK integration requires Node.js 22.19 or later. Install Node.js and restart Picode."
                    .to_string()
            })?;
        if !output.status.success() {
            return Err(
                "Cursor SDK integration requires Node.js 22.19 or later. Install Node.js and restart Picode."
                    .to_string(),
            );
        }
        let version = String::from_utf8_lossy(&output.stdout);
        if node_version_at_least_22_19(&version) {
            Ok(())
        } else {
            Err(format!(
                "Cursor SDK integration requires Node.js 22.19 or later; found {}. Upgrade Node.js and restart Picode.",
                version.trim()
            ))
        }
    }

    fn patch_installed_cursor_oauth_bridge(&self) -> Result<(), String> {
        let package_path = pi_agent_dir()?
            .join("npm")
            .join("node_modules")
            .join("@rahularya01")
            .join("pi-cursor")
            .join("dist")
            .join("index.js");
        let contents = fs::read_to_string(&package_path).map_err(|error| {
            format!(
                "Cursor OAuth package was installed but its compiled extension could not be read ({}): {error}",
                package_path.display()
            )
        })?;
        let bridge_patched = patch_cursor_bridge_contents(&contents)?;
        let refresh_patched = patch_cursor_oauth_model_refresh_contents(
            bridge_patched.as_deref().unwrap_or(&contents),
        )?;
        let Some(patched) = refresh_patched.or(bridge_patched) else {
            return Ok(());
        };
        fs::write(&package_path, patched).map_err(|error| {
            format!(
                "Cursor OAuth package was installed but its Bun/Node bridge compatibility patch could not be saved: {error}"
            )
        })
    }

    fn patch_existing_cursor_oauth_integration(&self) -> Result<(), String> {
        let package_path = pi_agent_dir()?
            .join("npm")
            .join("node_modules")
            .join("@rahularya01")
            .join("pi-cursor")
            .join("dist")
            .join("index.js");
        if package_path.exists() {
            self.patch_installed_cursor_oauth_bridge()?;
        }
        Ok(())
    }

    pub fn install_package_source(&self, source: &str) -> Result<(), String> {
        let args = vec!["install".to_string(), source.to_string()];
        let _ = self.run_pi_command(&args)?;
        Ok(())
    }

    pub fn remove_package_source(&self, source: &str) -> Result<(), String> {
        let args = vec!["remove".to_string(), source.to_string()];
        let _ = self.run_pi_command(&args)?;
        Ok(())
    }
}

pub fn is_port_in_use(port: u16) -> bool {
    std::net::TcpListener::bind(format!("0.0.0.0:{}", port)).is_err()
}

pub async fn wait_for_health(port: u16, timeout_secs: u64) -> Result<(), String> {
    wait_for_endpoint(port, "/api/health", timeout_secs).await
}

/// Wait for a specific HTTP endpoint on the pi instance to respond with a non-5xx status.
/// Useful when we need to confirm the API surface the frontend will hit first (e.g. /api/sessions)
/// is ready before navigating, avoiding cold-start races where /api/health is up but route
/// handlers are still warming.
pub async fn wait_for_endpoint(port: u16, path: &str, timeout_secs: u64) -> Result<(), String> {
    let url = format!("http://localhost:{}{}", port, path);
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        if std::time::Instant::now() > deadline {
            return Err(format!("Timed out waiting for {} on port {}", path, port));
        }
        if let Ok(resp) = reqwest::get(&url).await {
            if resp.status().as_u16() < 500 {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};

    #[test]
    fn augmented_path_includes_pi_extension_npm_bin() {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .expect("a home directory environment variable must be set for this test");
        let expected = Path::new(&home)
            .join(".pi")
            .join("agent")
            .join("npm")
            .join("node_modules")
            .join(".bin");

        let path = build_augmented_path();
        let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();

        assert!(
            dirs.iter().any(|dir| dir == &expected),
            "expected augmented PATH to include {}",
            expected.display()
        );
    }

    #[test]
    fn port_in_use_detects_unspecified_ipv4_listener() {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0))
            .expect("bind ephemeral port");
        let port = listener.local_addr().expect("listener addr").port();

        assert!(is_port_in_use(port));
    }

    #[test]
    fn cursor_package_source_matching_handles_npm_versions() {
        assert!(package_source_contains(
            "npm:pi-cursor-sdk@0.1.61",
            CURSOR_SDK_PACKAGE_NAME
        ));
        assert!(package_source_contains(
            "npm:@rahularya01/pi-cursor@1.4.0",
            CURSOR_OAUTH_PACKAGE_NAME
        ));
        assert!(!package_source_contains(
            "npm:other-package@1.0.0",
            CURSOR_SDK_PACKAGE_NAME
        ));
    }

    #[test]
    fn matt_pocock_skills_are_only_installed_when_missing() {
        assert_eq!(
            missing_default_package_sources(&[]),
            vec![MATT_POCOCK_SKILLS_PACKAGE]
        );
        assert!(missing_default_package_sources(&[
            "git:github.com/mattpocock/skills@v1".to_owned()
        ])
        .is_empty());
    }

    #[test]
    fn cursor_bridge_patch_is_explicit_and_idempotent() {
        let original = "const n=spawn(process.execPath,[bi],{stdio:[\"pipe\"]});";
        let patched = patch_cursor_bridge_contents(original)
            .unwrap()
            .expect("first patch should modify the source");
        assert!(patched.contains(CURSOR_BRIDGE_PATCHED));
        assert!(patch_cursor_bridge_contents(&patched).unwrap().is_none());
    }

    #[test]
    fn cursor_oauth_model_refresh_patch_allows_live_registry_refresh() {
        let original =
            "async refreshModels(M){if(!M.allowNetwork||M.signal?.aborted)return r.map(Bt);";
        let patched = patch_cursor_oauth_model_refresh_contents(original)
            .unwrap()
            .expect("first patch should modify the model refresh guard");
        assert!(patched.contains(CURSOR_OAUTH_REFRESH_PATCHED));
        assert!(patch_cursor_oauth_model_refresh_contents(&patched)
            .unwrap()
            .is_none());
    }

    #[test]
    fn node_version_check_requires_22_19() {
        assert!(!node_version_at_least_22_19("v22.18.0"));
        assert!(node_version_at_least_22_19("v22.19.0"));
        assert!(node_version_at_least_22_19("v24.0.0"));
    }
}
