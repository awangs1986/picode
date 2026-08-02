use crate::extension_manager::{ExtensionLifecycle, ExtensionManager, Permission};
use crate::extension_service::{ExtensionManifest, HealthCheck, ResourceLimits};
use crate::work_manager::{StartProcess, WorkKind, WorkManager, WorkStatus};
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use uuid::Uuid;

pub const HERDR_EXTENSION_ID: &str = "herdr-terminal-host";
const STATE_SCHEMA: u32 = 1;
const MAX_ARTIFACT_BYTES: usize = 128 * 1024 * 1024;
const HERDR_VERSION: &str = "0.7.5";
const HERDR_STABLE_COMMIT: &str = "ef4c23f5775bb8cfec05f05d0844226ff959a07a";
const HERDR_WINDOWS_PREVIEW_COMMIT: &str = "44b3adb125524ea9a55739eee3776f922f2115ad";
const WINDOWS_BUILD: &str = "2026-07-29-44b3adb12552";

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HerdrDecision {
    #[default]
    Undecided,
    Declined,
    Approved,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactFormat {
    Binary,
    Zip,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HerdrRelease {
    pub version: String,
    pub commit: String,
    pub channel: String,
    pub build_id: Option<String>,
    pub platform: String,
    pub platform_status: String,
    pub source: String,
    pub license: String,
    pub url: String,
    pub artifact_sha256: String,
    pub format: ArtifactFormat,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledHerdr {
    release: HerdrRelease,
    executable: PathBuf,
    executable_sha256: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HerdrState {
    #[serde(default = "state_schema")]
    schema_version: u32,
    #[serde(default)]
    decision: HerdrDecision,
    #[serde(default)]
    installed: Option<InstalledHerdr>,
    #[serde(default)]
    last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HerdrStatus {
    pub decision: HerdrDecision,
    pub release: Option<HerdrRelease>,
    pub supported: bool,
    pub installed: bool,
    pub enabled: bool,
    pub trusted: bool,
    pub running: bool,
    pub executable: Option<PathBuf>,
    pub install_path: PathBuf,
    pub permissions: Vec<String>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HerdrLaunch {
    pub attach_executable: PathBuf,
    pub server_run_id: String,
    pub pane_id: String,
}

fn state_schema() -> u32 {
    STATE_SCHEMA
}

pub trait ArtifactDownloader: Send + Sync {
    fn download<'a>(
        &'a self,
        release: &'a HerdrRelease,
        max_bytes: usize,
    ) -> BoxFuture<'a, Result<Vec<u8>, String>>;
}

pub trait HerdrProcessAdapter: Send + Sync {
    fn health(&self, executable: &Path) -> Result<(), String>;
    fn command(
        &self,
        executable: &Path,
        arguments: &[String],
        cwd: &Path,
        timeout: Duration,
    ) -> Result<String, String>;
}

pub struct HttpArtifactDownloader {
    client: reqwest::Client,
}

impl HttpArtifactDownloader {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::limited(5))
                .connect_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(120))
                .build()
                .map_err(|error| format!("create Herdr downloader: {error}"))?,
        })
    }
}

impl ArtifactDownloader for HttpArtifactDownloader {
    fn download<'a>(
        &'a self,
        release: &'a HerdrRelease,
        max_bytes: usize,
    ) -> BoxFuture<'a, Result<Vec<u8>, String>> {
        Box::pin(async move {
            let url = reqwest::Url::parse(&release.url)
                .map_err(|error| format!("invalid pinned Herdr URL: {error}"))?;
            if url.scheme() != "https"
                || !matches!(
                    url.host_str(),
                    Some("github.com") | Some("objects.githubusercontent.com")
                )
            {
                return Err("Herdr download must use the pinned GitHub HTTPS asset".into());
            }
            let response = self
                .client
                .get(url)
                .send()
                .await
                .map_err(|error| format!("download Herdr: {error}"))?;
            if !response.status().is_success() {
                return Err(format!(
                    "download Herdr returned HTTP {}",
                    response.status()
                ));
            }
            if response
                .content_length()
                .is_some_and(|length| length > max_bytes as u64)
            {
                return Err("Herdr asset exceeds the bounded download size".into());
            }
            let bytes = response
                .bytes()
                .await
                .map_err(|error| format!("read Herdr asset: {error}"))?;
            if bytes.len() > max_bytes {
                return Err("Herdr asset exceeds the bounded download size".into());
            }
            Ok(bytes.to_vec())
        })
    }
}

pub struct WorkHerdrProcessAdapter {
    work: Arc<WorkManager>,
}

impl WorkHerdrProcessAdapter {
    pub fn new(work: Arc<WorkManager>) -> Self {
        Self { work }
    }
}

impl HerdrProcessAdapter for WorkHerdrProcessAdapter {
    fn health(&self, executable: &Path) -> Result<(), String> {
        let output = self.command(
            executable,
            &["--version".into()],
            executable.parent().unwrap_or_else(|| Path::new(".")),
            Duration::from_secs(10),
        )?;
        if !output.to_ascii_lowercase().contains("herdr") {
            return Err("Herdr health check returned an unexpected version response".into());
        }
        Ok(())
    }

    fn command(
        &self,
        executable: &Path,
        arguments: &[String],
        cwd: &Path,
        timeout: Duration,
    ) -> Result<String, String> {
        let run_id = format!("herdr-probe-{}", Uuid::new_v4().simple());
        let handle = self.work.start_process(&StartProcess {
            task_id: "picode.herdr.setup".into(),
            run_id,
            kind: WorkKind::Extension,
            component_id: Some(HERDR_EXTENSION_ID.into()),
            executable: executable.to_string_lossy().into_owned(),
            args: arguments.to_vec(),
            environment: Default::default(),
            cwd: cwd.to_string_lossy().into_owned(),
            timeout_ms: timeout.as_millis().try_into().unwrap_or(u64::MAX),
        })?;
        let completed = self
            .work
            .wait(&handle.id, timeout + Duration::from_secs(2))?;
        if completed.status == WorkStatus::Running {
            let _ = self.work.cancel(&completed.id);
            return Err("Herdr health command did not finish before its deadline".into());
        }
        if completed.status != WorkStatus::Completed {
            return Err(format!(
                "Herdr command failed ({:?}): {}",
                completed.status,
                String::from_utf8_lossy(&completed.bounded_output)
            ));
        }
        Ok(String::from_utf8_lossy(&completed.bounded_output).into_owned())
    }
}

pub struct HerdrInstaller {
    root: PathBuf,
    state: Mutex<HerdrState>,
    extensions: Arc<ExtensionManager>,
}

impl HerdrInstaller {
    pub fn open(root: &Path, extensions: Arc<ExtensionManager>) -> Result<Self, String> {
        fs::create_dir_all(root).map_err(|error| format!("create Herdr store: {error}"))?;
        let state_path = root.join("state.json");
        let state = if state_path.is_file() {
            serde_json::from_slice::<HerdrState>(
                &fs::read(&state_path).map_err(|error| format!("read Herdr state: {error}"))?,
            )
            .map_err(|error| format!("parse Herdr state: {error}"))?
        } else {
            HerdrState {
                schema_version: STATE_SCHEMA,
                ..Default::default()
            }
        };
        if state.schema_version != STATE_SCHEMA {
            return Err(format!(
                "unsupported Herdr state schema {}",
                state.schema_version
            ));
        }
        let service = Self {
            root: root.to_owned(),
            state: Mutex::new(state),
            extensions,
        };
        service.persist()?;
        Ok(service)
    }

    pub fn inspect(&self) -> HerdrStatus {
        let state = self
            .state
            .lock()
            .map(|state| state.clone())
            .unwrap_or_default();
        let release = release_for_current_platform().ok();
        let snapshot = self.extensions.snapshot();
        let lifecycle = snapshot
            .lifecycle
            .iter()
            .find(|entry| entry.id == HERDR_EXTENSION_ID)
            .map(|entry| entry.state);
        HerdrStatus {
            decision: state.decision,
            release: release.clone(),
            supported: release.is_some(),
            installed: state.installed.is_some(),
            enabled: matches!(
                lifecycle,
                Some(
                    ExtensionLifecycle::Enabled
                        | ExtensionLifecycle::Trusted
                        | ExtensionLifecycle::Running
                )
            ),
            trusted: matches!(
                lifecycle,
                Some(ExtensionLifecycle::Trusted | ExtensionLifecycle::Running)
            ),
            running: lifecycle == Some(ExtensionLifecycle::Running),
            executable: state.installed.as_ref().map(|item| item.executable.clone()),
            install_path: self.root.join("releases"),
            permissions: vec!["processExecute".into(), "network".into()],
            last_error: state.last_error,
        }
    }

    pub fn decide(&self, decision: HerdrDecision) -> Result<HerdrStatus, String> {
        let mut state = self.lock_state()?;
        state.decision = decision;
        state.last_error = None;
        drop(state);
        self.persist()?;
        Ok(self.inspect())
    }

    pub fn reset_decision(&self) -> Result<HerdrStatus, String> {
        self.decide(HerdrDecision::Undecided)
    }

    pub async fn install_and_trust(
        &self,
        downloader: &dyn ArtifactDownloader,
        process: &dyn HerdrProcessAdapter,
    ) -> Result<HerdrStatus, String> {
        if self.lock_state()?.decision != HerdrDecision::Approved {
            return Err("Herdr installation requires explicit user approval".into());
        }
        let release = release_for_current_platform()?;
        self.install_release(release, downloader, process).await
    }

    #[cfg(test)]
    async fn install_release_for_test(
        &self,
        release: HerdrRelease,
        downloader: &dyn ArtifactDownloader,
        process: &dyn HerdrProcessAdapter,
    ) -> Result<HerdrStatus, String> {
        self.install_release(release, downloader, process).await
    }

    async fn install_release(
        &self,
        release: HerdrRelease,
        downloader: &dyn ArtifactDownloader,
        process: &dyn HerdrProcessAdapter,
    ) -> Result<HerdrStatus, String> {
        let bytes = downloader.download(&release, MAX_ARTIFACT_BYTES).await?;
        let actual_artifact_hash = sha256_hex(&bytes);
        if actual_artifact_hash != release.artifact_sha256 {
            return self.fail(format!(
                "Herdr artifact SHA-256 mismatch: expected {}, got {}",
                release.artifact_sha256, actual_artifact_hash
            ));
        }

        let staging = self
            .root
            .join(format!(".staging-{}", Uuid::new_v4().simple()));
        fs::create_dir_all(&staging).map_err(|error| format!("stage Herdr: {error}"))?;
        let staged_executable = staging.join(executable_name());
        let staged = (|| {
            extract_executable(&release, &bytes, &staged_executable)?;
            process.health(&staged_executable)?;
            sha256_file(&staged_executable)
        })();
        let executable_hash = match staged {
            Ok(hash) => hash,
            Err(error) => {
                let _ = fs::remove_dir_all(&staging);
                return self.fail(error);
            }
        };

        let release_identity = release
            .build_id
            .as_deref()
            .map(|build| format!("{}-preview-{build}", release.version))
            .unwrap_or_else(|| release.version.clone());
        let release_dir = self.root.join("releases").join(release_identity);
        if release_dir.exists() {
            let existing = release_dir.join(executable_name());
            if sha256_file(&existing).ok().as_deref() != Some(&executable_hash) {
                let _ = fs::remove_dir_all(&staging);
                return self.fail(
                    "existing Herdr release directory does not match the reviewed binary".into(),
                );
            }
            let _ = fs::remove_dir_all(&staging);
        } else {
            fs::create_dir_all(release_dir.parent().unwrap_or(&self.root))
                .map_err(|error| format!("create Herdr releases directory: {error}"))?;
            fs::rename(&staging, &release_dir)
                .map_err(|error| format!("atomically activate Herdr release: {error}"))?;
        }
        let executable = release_dir.join(executable_name());
        let manifest = herdr_manifest(&release, &executable, &executable_hash);
        let registration = (|| {
            if self
                .extensions
                .snapshot()
                .installations
                .iter()
                .any(|item| item.id == HERDR_EXTENSION_ID)
            {
                self.extensions.uninstall(HERDR_EXTENSION_ID)?;
            }
            self.extensions.install(manifest)?;
            self.extensions.set_enabled(HERDR_EXTENSION_ID, true)?;
            self.extensions.set_trusted(HERDR_EXTENSION_ID, true)?;
            Ok::<_, String>(())
        })();
        if let Err(error) = registration {
            let _ = self.extensions.uninstall(HERDR_EXTENSION_ID);
            let _ = fs::remove_dir_all(&release_dir);
            return self.fail(error);
        }

        let mut state = self.lock_state()?;
        state.installed = Some(InstalledHerdr {
            release,
            executable,
            executable_sha256: executable_hash,
        });
        state.last_error = None;
        drop(state);
        self.persist()?;
        Ok(self.inspect())
    }

    pub fn launch_chat(
        &self,
        process: &dyn HerdrProcessAdapter,
        tui_executable: &Path,
        broker_port: u16,
        chat_id: Option<&str>,
    ) -> Result<HerdrLaunch, String> {
        validate_tui_executable(tui_executable)?;
        let installed = self
            .lock_state()?
            .installed
            .clone()
            .ok_or("Herdr is not installed")?;
        if sha256_file(&installed.executable)? != installed.executable_sha256 {
            let _ = self.extensions.set_trusted(HERDR_EXTENSION_ID, false);
            return self.fail("Herdr executable changed after trust review".into());
        }
        let running = self.extensions.snapshot().runs.into_iter().find(|run| {
            run.extension_id == HERDR_EXTENSION_ID
                && run.state == crate::extension_service::ExtensionRunState::Running
        });
        let (run, started_here) = match running {
            Some(run) => (run, false),
            None => (
                self.extensions.start_extension(
                    HERDR_EXTENSION_ID,
                    "picode.herdr.host",
                    "picode.herdr.server",
                    &self.root,
                    Duration::from_secs(7 * 24 * 60 * 60),
                )?,
                true,
            ),
        };

        let topology = (|| {
            let mut healthy = false;
            let status_args = vec!["status".into(), "server".into()];
            for _ in 0..20 {
                if process
                    .command(
                        &installed.executable,
                        &status_args,
                        &self.root,
                        Duration::from_secs(2),
                    )
                    .is_ok()
                {
                    healthy = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            if !healthy {
                return Err("Herdr server failed its post-launch health check".into());
            }

            let label = chat_id.unwrap_or("Picode");
            if label.len() > 256 || label.contains(['\r', '\n', '\0']) {
                return Err("invalid chat identity for Herdr launch".into());
            }
            let create_output = process.command(
                &installed.executable,
                &[
                    "workspace".into(),
                    "create".into(),
                    "--cwd".into(),
                    self.root.to_string_lossy().into_owned(),
                    "--label".into(),
                    format!("Picode · {label}"),
                    "--focus".into(),
                ],
                &self.root,
                Duration::from_secs(10),
            )?;
            let created: serde_json::Value = serde_json::from_str(create_output.trim())
                .map_err(|error| format!("parse Herdr workspace response: {error}"))?;
            let pane_id = created
                .pointer("/result/root_pane/pane_id")
                .and_then(serde_json::Value::as_str)
                .ok_or("Herdr workspace response did not include a root pane")?
                .to_owned();
            let command = tui_shell_command(tui_executable, broker_port, chat_id);
            process.command(
                &installed.executable,
                &["pane".into(), "run".into(), pane_id.clone(), command],
                &self.root,
                Duration::from_secs(10),
            )?;
            Ok::<_, String>(pane_id)
        })();
        let pane_id = match topology {
            Ok(pane_id) => pane_id,
            Err(error) => {
                if started_here {
                    let _ = self.extensions.cancel_run(&run.id);
                }
                return self.fail(error);
            }
        };
        Ok(HerdrLaunch {
            attach_executable: installed.executable,
            server_run_id: run.id,
            pane_id,
        })
    }

    pub fn remove(&self) -> Result<HerdrStatus, String> {
        self.extensions.uninstall(HERDR_EXTENSION_ID)?;
        let installed = self.lock_state()?.installed.clone();
        if let Some(installed) = installed {
            if let Some(release_dir) = installed.executable.parent() {
                if release_dir.starts_with(self.root.join("releases")) {
                    fs::remove_dir_all(release_dir)
                        .map_err(|error| format!("remove Herdr release: {error}"))?;
                }
            }
        }
        let mut state = self.lock_state()?;
        state.installed = None;
        state.decision = HerdrDecision::Undecided;
        state.last_error = None;
        drop(state);
        self.persist()?;
        Ok(self.inspect())
    }

    fn fail<T>(&self, error: String) -> Result<T, String> {
        if let Ok(mut state) = self.state.lock() {
            state.last_error = Some(error.clone());
        }
        let _ = self.persist();
        Err(error)
    }

    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, HerdrState>, String> {
        self.state
            .lock()
            .map_err(|_| "Herdr installer lock is poisoned".into())
    }

    fn persist(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(&*self.lock_state()?)
            .map_err(|error| format!("encode Herdr state: {error}"))?;
        let temporary = self
            .root
            .join(format!(".state-{}.tmp", Uuid::new_v4().simple()));
        let state_path = self.root.join("state.json");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("stage Herdr state: {error}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("write Herdr state: {error}"))?;
        drop(file);
        if state_path.exists() {
            fs::remove_file(&state_path)
                .map_err(|error| format!("replace Herdr state: {error}"))?;
        }
        fs::rename(&temporary, &state_path)
            .map_err(|error| format!("activate Herdr state: {error}"))
    }
}

pub fn release_for_current_platform() -> Result<HerdrRelease, String> {
    release_for(std::env::consts::OS, std::env::consts::ARCH)
}

fn release_for(os: &str, arch: &str) -> Result<HerdrRelease, String> {
    let source = "https://github.com/herdrdev/herdr".to_owned();
    let base = |platform: &str, status: &str, url: &str, hash: &str, format| HerdrRelease {
        version: HERDR_VERSION.into(),
        commit: if os == "windows" {
            HERDR_WINDOWS_PREVIEW_COMMIT
        } else {
            HERDR_STABLE_COMMIT
        }
        .into(),
        channel: if os == "windows" { "preview" } else { "stable" }.into(),
        build_id: (os == "windows").then(|| WINDOWS_BUILD.into()),
        platform: platform.into(),
        platform_status: status.into(),
        source: source.clone(),
        license: "Apache-2.0".into(),
        url: url.into(),
        artifact_sha256: hash.into(),
        format,
    };
    match (os, arch) {
        ("windows", "x86_64") => Ok(base(
            "windows-x86_64",
            "preview",
            "https://github.com/herdrdev/herdr/releases/download/preview-2026-07-29-44b3adb12552/herdr-windows-x86_64.zip",
            "ead450c21d31ea559289d45e4c60d14bb0a7ff0937668a309e74c6a3f9f6cca1",
            ArtifactFormat::Zip,
        )),
        ("linux", "x86_64") => Ok(base(
            "linux-x86_64",
            "stable",
            "https://github.com/herdrdev/herdr/releases/download/v0.7.5/herdr-linux-x86_64",
            "3dc83288073e4c2d3c679a30e7be97bcca9141c6fd17dbbb9219142e95c59253",
            ArtifactFormat::Binary,
        )),
        ("linux", "aarch64") => Ok(base(
            "linux-aarch64",
            "stable",
            "https://github.com/herdrdev/herdr/releases/download/v0.7.5/herdr-linux-aarch64",
            "32e763a1499a6b694b1d708e4f062b743be1da9f34fcfa4d212d6db6fe09a8b9",
            ArtifactFormat::Binary,
        )),
        ("macos", "x86_64") => Ok(base(
            "macos-x86_64",
            "stable",
            "https://github.com/herdrdev/herdr/releases/download/v0.7.5/herdr-macos-x86_64",
            "3fe50c4a63dc8102306b1322178628ddb3655cd3ae56d784f094153408d69e62",
            ArtifactFormat::Binary,
        )),
        ("macos", "aarch64") => Ok(base(
            "macos-aarch64",
            "stable",
            "https://github.com/herdrdev/herdr/releases/download/v0.7.5/herdr-macos-aarch64",
            "37350546b0012555943b92eaf962665de4e264395baeb44227b8015e8ff5b0d6",
            ArtifactFormat::Binary,
        )),
        _ => Err(format!("Herdr has no pinned Picode asset for {os}/{arch}")),
    }
}

fn herdr_manifest(
    release: &HerdrRelease,
    executable: &Path,
    executable_hash: &str,
) -> ExtensionManifest {
    ExtensionManifest {
        id: HERDR_EXTENSION_ID.into(),
        manifest_version: 2,
        schema_version: 1,
        name: "Herdr terminal host".into(),
        version: release
            .build_id
            .as_deref()
            .map(|build| format!("{}-preview.{build}", release.version))
            .unwrap_or_else(|| release.version.clone()),
        source: release.source.clone(),
        source_ref: Some(release.commit.clone()),
        source_hash: Some(executable_hash.into()),
        license: release.license.clone(),
        components: vec!["native-helper".into()],
        platforms: vec![std::env::consts::OS.into()],
        surfaces: vec!["tui".into()],
        health_check: Some(HealthCheck {
            kind: "process".into(),
            target: Some("--version".into()),
            timeout_ms: 10_000,
        }),
        executable: executable.to_owned(),
        arguments: vec!["server".into()],
        permissions: BTreeSet::from([Permission::ProcessExecute, Permission::Network]),
        enabled: false,
        limits: ResourceLimits {
            max_memory_bytes: 512 * 1024 * 1024,
            max_output_bytes: 64 * 1024,
        },
    }
}

fn executable_name() -> &'static str {
    if cfg!(windows) {
        "herdr.exe"
    } else {
        "herdr"
    }
}

fn extract_executable(
    release: &HerdrRelease,
    bytes: &[u8],
    destination: &Path,
) -> Result<(), String> {
    match release.format {
        ArtifactFormat::Binary => fs::write(destination, bytes)
            .map_err(|error| format!("write Herdr executable: {error}"))?,
        ArtifactFormat::Zip => {
            let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
                .map_err(|error| format!("open Herdr zip: {error}"))?;
            let mut found = None;
            for index in 0..archive.len() {
                let file = archive
                    .by_index(index)
                    .map_err(|error| format!("read Herdr zip entry: {error}"))?;
                if file.is_file()
                    && file
                        .enclosed_name()
                        .as_deref()
                        .and_then(Path::file_name)
                        .is_some_and(|name| {
                            name.to_string_lossy().eq_ignore_ascii_case("herdr.exe")
                        })
                {
                    if file.size() > MAX_ARTIFACT_BYTES as u64 {
                        return Err("Herdr executable exceeds extraction limit".into());
                    }
                    found = Some(index);
                    break;
                }
            }
            let index = found.ok_or("Herdr zip does not contain herdr.exe")?;
            let file = archive
                .by_index(index)
                .map_err(|error| format!("read Herdr executable entry: {error}"))?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(destination)
                .map_err(|error| format!("stage Herdr executable: {error}"))?;
            std::io::copy(&mut file.take(MAX_ARTIFACT_BYTES as u64 + 1), &mut output)
                .map_err(|error| format!("extract Herdr executable: {error}"))?;
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(destination, fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("mark Herdr executable: {error}"))?;
    }
    Ok(())
}

fn validate_tui_executable(path: &Path) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if !matches!(name, "picode-tui" | "picode-tui.exe") || !path.is_file() {
        return Err("Herdr may launch only the managed picode-tui executable".into());
    }
    Ok(())
}

fn tui_shell_command(executable: &Path, broker_port: u16, chat_id: Option<&str>) -> String {
    #[cfg(windows)]
    fn quote(value: &str) -> String {
        format!("\"{}\"", value.replace('"', "\"\""))
    }
    #[cfg(not(windows))]
    fn quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
    let mut command = format!(
        "{} --broker-port {}",
        quote(&executable.to_string_lossy()),
        broker_port
    );
    if let Some(chat_id) = chat_id {
        command.push_str(" --chat ");
        command.push_str(&quote(chat_id));
    }
    command
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        fs::File::open(path).map_err(|error| format!("open reviewed binary: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("hash reviewed binary: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestration_service::OrchestrationService;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FakeDownloader {
        bytes: Vec<u8>,
        calls: AtomicUsize,
    }

    struct OfflineDownloader;

    impl ArtifactDownloader for OfflineDownloader {
        fn download<'a>(
            &'a self,
            _release: &'a HerdrRelease,
            _max_bytes: usize,
        ) -> BoxFuture<'a, Result<Vec<u8>, String>> {
            Box::pin(async { Err("synthetic offline network".into()) })
        }
    }

    impl ArtifactDownloader for FakeDownloader {
        fn download<'a>(
            &'a self,
            _release: &'a HerdrRelease,
            _max_bytes: usize,
        ) -> BoxFuture<'a, Result<Vec<u8>, String>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let bytes = self.bytes.clone();
            Box::pin(async move { Ok(bytes) })
        }
    }

    struct FakeProcess {
        health_calls: AtomicUsize,
        fail_health: bool,
    }

    impl HerdrProcessAdapter for FakeProcess {
        fn health(&self, _executable: &Path) -> Result<(), String> {
            self.health_calls.fetch_add(1, Ordering::SeqCst);
            if self.fail_health {
                Err("synthetic health failure".into())
            } else {
                Ok(())
            }
        }

        fn command(
            &self,
            _executable: &Path,
            _arguments: &[String],
            _cwd: &Path,
            _timeout: Duration,
        ) -> Result<String, String> {
            Ok("{}".into())
        }
    }

    fn fixture() -> (PathBuf, HerdrInstaller, Arc<WorkManager>) {
        let root = std::env::temp_dir().join(format!("picode-herdr-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let jobs = Arc::new(OrchestrationService::open(&root.join("jobs"), 64 * 1024).unwrap());
        let work = Arc::new(WorkManager::new(jobs));
        let extensions =
            Arc::new(ExtensionManager::open(&root.join("extensions"), work.clone()).unwrap());
        let installer = HerdrInstaller::open(&root.join("herdr"), extensions).unwrap();
        (root, installer, work)
    }

    fn test_asset(release: &HerdrRelease, executable: &[u8]) -> Vec<u8> {
        if release.format == ArtifactFormat::Binary {
            return executable.to_vec();
        }
        let mut bytes = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut bytes);
            writer
                .start_file("bundle/herdr.exe", zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(executable).unwrap();
            writer.finish().unwrap();
        }
        bytes.into_inner()
    }

    #[tokio::test]
    async fn decline_is_persistent_and_zero_resident() {
        let (root, installer, work) = fixture();
        installer.decide(HerdrDecision::Declined).unwrap();
        let downloader = FakeDownloader {
            bytes: Vec::new(),
            calls: AtomicUsize::new(0),
        };
        let process = FakeProcess {
            health_calls: AtomicUsize::new(0),
            fail_health: false,
        };
        assert!(installer
            .install_and_trust(&downloader, &process)
            .await
            .unwrap_err()
            .contains("approval"));
        assert_eq!(downloader.calls.load(Ordering::SeqCst), 0);
        assert_eq!(process.health_calls.load(Ordering::SeqCst), 0);
        assert!(work.snapshot().unwrap().is_empty());
        assert_eq!(installer.inspect().decision, HerdrDecision::Declined);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn valid_reviewed_asset_installs_enabled_and_trusted_after_health() {
        let (root, installer, _work) = fixture();
        installer.decide(HerdrDecision::Approved).unwrap();
        let mut release = release_for_current_platform().unwrap();
        let bytes = test_asset(&release, b"synthetic-herdr-executable");
        release.artifact_sha256 = sha256_hex(&bytes);
        let downloader = FakeDownloader {
            bytes,
            calls: AtomicUsize::new(0),
        };
        let process = FakeProcess {
            health_calls: AtomicUsize::new(0),
            fail_health: false,
        };
        // Test the install transaction with a fixture hash while retaining all
        // production release metadata.
        let status = installer
            .install_release_for_test(release, &downloader, &process)
            .await
            .unwrap();
        assert!(status.installed && status.enabled && status.trusted);
        assert!(!status.running);
        assert_eq!(process.health_calls.load(Ordering::SeqCst), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn tampered_asset_and_failed_health_leave_no_trusted_installation() {
        let (root, installer, _work) = fixture();
        installer.decide(HerdrDecision::Approved).unwrap();
        let release = release_for_current_platform().unwrap();
        let bad = FakeDownloader {
            bytes: b"tampered".to_vec(),
            calls: AtomicUsize::new(0),
        };
        let process = FakeProcess {
            health_calls: AtomicUsize::new(0),
            fail_health: false,
        };
        assert!(installer.install_and_trust(&bad, &process).await.is_err());
        assert!(!installer.inspect().trusted);

        let mut fixture_release = release;
        let bytes = test_asset(&fixture_release, b"unhealthy-herdr");
        fixture_release.artifact_sha256 = sha256_hex(&bytes);
        let unhealthy = FakeDownloader {
            bytes,
            calls: AtomicUsize::new(0),
        };
        let failed_process = FakeProcess {
            health_calls: AtomicUsize::new(0),
            fail_health: true,
        };
        assert!(installer
            .install_release_for_test(fixture_release, &unhealthy, &failed_process)
            .await
            .unwrap_err()
            .contains("health"));
        assert!(!installer.inspect().installed);
        assert!(!installer.inspect().trusted);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn offline_and_unsupported_platforms_fail_closed_without_residents() {
        let (root, installer, work) = fixture();
        installer.decide(HerdrDecision::Approved).unwrap();
        let process = FakeProcess {
            health_calls: AtomicUsize::new(0),
            fail_health: false,
        };
        assert!(installer
            .install_and_trust(&OfflineDownloader, &process)
            .await
            .unwrap_err()
            .contains("offline"));
        assert!(!installer.inspect().installed);
        assert!(!installer.inspect().trusted);
        assert!(work.snapshot().unwrap().is_empty());
        assert!(release_for("solaris", "sparc64")
            .unwrap_err()
            .contains("no pinned"));
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn removal_returns_a_reviewed_install_to_zero_residency() {
        let (root, installer, work) = fixture();
        installer.decide(HerdrDecision::Approved).unwrap();
        let mut release = release_for_current_platform().unwrap();
        let bytes = test_asset(&release, b"removable-herdr");
        release.artifact_sha256 = sha256_hex(&bytes);
        let downloader = FakeDownloader {
            bytes,
            calls: AtomicUsize::new(0),
        };
        let process = FakeProcess {
            health_calls: AtomicUsize::new(0),
            fail_health: false,
        };
        installer
            .install_release_for_test(release, &downloader, &process)
            .await
            .unwrap();
        let removed = installer.remove().unwrap();
        assert_eq!(removed.decision, HerdrDecision::Undecided);
        assert!(!removed.installed && !removed.enabled && !removed.trusted && !removed.running);
        assert!(work.snapshot().unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
