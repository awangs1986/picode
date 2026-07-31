use crate::extension_host::Permission;
use crate::extension_manager::ExtensionLifecycle;
use crate::orchestration_service::{ManagedJobStatus, OrchestrationService};
use crate::resource_sampler::ProcessSampler;
use crate::safe_files::SafeFileStore;
use crate::secrets::{SecretReference, SecretStore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
#[cfg(test)]
use std::time::Instant;
use uuid::Uuid;

const STATE_SCHEMA: u32 = 1;
const MAX_IMPORT_FILES: usize = 2_000;
const MAX_IMPORT_BYTES: u64 = 512 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceLimits {
    pub max_memory_bytes: u64,
    pub max_output_bytes: usize,
}

impl ResourceLimits {
    fn validate(self) -> Result<Self, String> {
        if self.max_memory_bytes < 1024 * 1024 || self.max_memory_bytes > 16 * 1024 * 1024 * 1024 {
            return Err("extension memory limit must be between 1 MiB and 16 GiB".into());
        }
        if self.max_output_bytes == 0 || self.max_output_bytes > 4 * 1024 * 1024 {
            return Err("extension output limit must be between 1 byte and 4 MiB".into());
        }
        Ok(self)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionManifest {
    pub id: String,
    pub schema_version: u32,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub source_ref: Option<String>,
    #[serde(default)]
    pub license: String,
    #[serde(default)]
    pub components: Vec<String>,
    #[serde(default)]
    pub platforms: Vec<String>,
    pub executable: PathBuf,
    pub arguments: Vec<String>,
    pub permissions: BTreeSet<Permission>,
    pub enabled: bool,
    pub limits: ResourceLimits,
}

impl ExtensionManifest {
    #[cfg(test)]
    pub fn new(
        id: &str,
        schema_version: u32,
        executable: PathBuf,
        arguments: Vec<String>,
        permissions: BTreeSet<Permission>,
        limits: ResourceLimits,
    ) -> Self {
        Self {
            id: id.into(),
            schema_version,
            name: id.into(),
            version: format!("schema-{schema_version}"),
            source: "local".into(),
            source_ref: None,
            license: "unknown".into(),
            components: vec!["native-helper".into()],
            platforms: vec![std::env::consts::OS.into()],
            executable,
            arguments,
            permissions,
            enabled: false,
            limits,
        }
    }

    fn validate(&self) -> Result<(), String> {
        validate_identifier(&self.id, "extension")?;
        if self.schema_version == 0 {
            return Err("extension schema version must be positive".into());
        }
        if self.source.starts_with("http")
            && self.source_ref.as_deref().is_none_or(|value| {
                value.len() != 40 || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        {
            return Err("remote extension requires a pinned full commit SHA".into());
        }
        if self.executable.as_os_str().is_empty()
            || self.arguments.iter().any(|arg| arg.contains('\0'))
        {
            return Err("extension executable or argument is invalid".into());
        }
        self.limits.validate()?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionRunState {
    Running,
    Completed,
    Failed,
    Cancelled,
    TimedOut,
    Terminated,
    ResourceStopped,
}

impl ExtensionRunState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::TimedOut => "timedOut",
            Self::Terminated => "terminated",
            Self::ResourceStopped => "resourceStopped",
        }
    }

    fn terminal(self) -> bool {
        self != Self::Running
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionRunView {
    pub id: String,
    pub extension_id: String,
    pub task_id: String,
    pub agent_run_id: String,
    pub job_id: String,
    pub process_id: u32,
    pub state: ExtensionRunState,
    pub observed_memory_bytes: u64,
    pub output_tail: Vec<u8>,
    pub full_output_hash: String,
    pub termination_result: Option<String>,
    pub started_at: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExternalSource {
    Codex,
    Claude,
    Cursor,
    OpenCode,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportKind {
    Rule,
    Skill,
    Command,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalImportCandidate {
    pub id: String,
    pub source: ExternalSource,
    pub kind: ImportKind,
    pub relative_path: PathBuf,
    pub version: String,
    pub bytes: u64,
    pub unsupported_reason: Option<String>,
    #[serde(skip)]
    source_path: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalImportPreview {
    pub id: String,
    pub source: ExternalSource,
    pub root: PathBuf,
    pub candidates: Vec<ExternalImportCandidate>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionScope {
    Global,
    Task(String),
}

impl ExtensionScope {
    fn task_matches(&self, task_id: &str) -> bool {
        matches!(self, Self::Global) || matches!(self, Self::Task(bound) if bound == task_id)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedCapability {
    pub id: String,
    pub source: ExternalSource,
    pub kind: ImportKind,
    pub source_path: PathBuf,
    pub stored_path: PathBuf,
    pub version: String,
    pub scope: ExtensionScope,
    pub enabled: bool,
    pub imported_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportActivation {
    pub id: String,
    pub imported_id: String,
    pub task_id: String,
    pub task_override_id: Option<String>,
    pub activated_at: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpTransport {
    Stdio,
    StreamableHttp,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpImportCandidate {
    pub id: String,
    pub transport: McpTransport,
    pub command: Option<PathBuf>,
    pub arguments: Vec<String>,
    pub url: Option<String>,
    pub required_environment: Vec<String>,
    pub unsupported_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpImportPreview {
    pub id: String,
    pub candidates: Vec<McpImportCandidate>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub transport: McpTransport,
    pub command: Option<PathBuf>,
    pub arguments: Vec<String>,
    pub url: Option<String>,
    pub environment: BTreeMap<String, SecretReference>,
    pub scope: ExtensionScope,
    pub enabled: bool,
}

pub struct McpClientActivation {
    pub server_id: String,
    pub task_id: String,
    pub transport: McpTransport,
    pub command: Option<PathBuf>,
    pub arguments: Vec<String>,
    pub url: Option<String>,
    pub environment: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopedProcessRun {
    pub id: String,
    pub owner_id: String,
    pub task_id: String,
    #[serde(default)]
    pub agent_run_id: String,
    pub job_id: Option<String>,
    pub process_id: Option<u32>,
    pub state: String,
    pub started_at: u64,
    pub termination_result: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAdapter {
    pub id: String,
    pub markers: Vec<String>,
    pub action_ids: Vec<String>,
    pub diagnostic_kinds: Vec<String>,
    pub enabled: bool,
    pub provenance: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterMatch {
    pub adapter_id: String,
    pub markers: Vec<String>,
    pub action_ids: Vec<String>,
    pub provenance: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DapLaunchConfig {
    pub adapter: PathBuf,
    pub arguments: Vec<String>,
    pub request: String,
    pub target: String,
    pub max_events: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DapSession {
    pub id: String,
    pub task_id: String,
    #[serde(default)]
    pub agent_run_id: String,
    pub job_id: String,
    pub process_id: u32,
    pub request: String,
    pub target: String,
    pub events: Vec<String>,
    pub state: String,
    #[serde(default)]
    pub evidence_ref: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FindingKind {
    Deterministic,
    ModelOpinion,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticFinding {
    pub source: String,
    pub path: PathBuf,
    pub version: String,
    pub line: usize,
    pub severity: DiagnosticSeverity,
    pub message: String,
    pub kind: FindingKind,
    pub evidence_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvisoryRecord {
    pub id: String,
    pub task_id: String,
    pub role: String,
    pub model: String,
    pub context_bytes: usize,
    pub cost_limit_micros: u64,
    pub allowed_tools: BTreeSet<String>,
    #[serde(default)]
    pub child_port: Option<u16>,
    #[serde(default)]
    pub child_run_id: Option<String>,
    pub candidate_output: Option<String>,
    pub output_is_evidence: bool,
    #[serde(default = "default_advisory_state")]
    pub state: String,
    pub recorded_at: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegressionScenario {
    pub id: String,
    pub version: u32,
    pub fixture_hash: String,
    pub environment: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegressionMetrics {
    pub success: bool,
    pub edit_retries: u32,
    pub verification_accuracy: f32,
    pub routing_accuracy: f32,
    pub tokens: u64,
    pub cost_micros: u64,
    pub startup_ms: i64,
    pub interaction_ms: u64,
    pub idle_memory_bytes: u64,
    pub peak_memory_bytes: u64,
    pub false_stalls: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegressionRun {
    pub id: String,
    pub scenario: RegressionScenario,
    pub picode_version: String,
    pub model: String,
    pub metrics: RegressionMetrics,
    pub artifact_path: PathBuf,
    pub artifact_hash: String,
    pub recorded_at: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegressionComparison {
    pub startup_delta_ms: i64,
    pub idle_memory_delta_bytes: i128,
    pub token_delta: i128,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedState {
    schema_version: u32,
    installations: BTreeMap<String, ExtensionManifest>,
    #[serde(default)]
    trusted_extensions: BTreeSet<String>,
    runs: BTreeMap<String, ExtensionRunView>,
    imports: BTreeMap<String, ImportedCapability>,
    import_activations: Vec<ImportActivation>,
    mcp_configs: BTreeMap<String, McpServerConfig>,
    mcp_runs: BTreeMap<String, ScopedProcessRun>,
    adapters: BTreeMap<String, ProjectAdapter>,
    dap_sessions: BTreeMap<String, DapSession>,
    diagnostics: BTreeSet<DiagnosticFinding>,
    advisories: Vec<AdvisoryRecord>,
    regression_runs: Vec<RegressionRun>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSnapshot {
    pub installations: Vec<ExtensionManifest>,
    pub runs: Vec<ExtensionRunView>,
    pub imports: Vec<ImportedCapability>,
    pub import_activations: Vec<ImportActivation>,
    pub mcp_configs: Vec<McpServerConfig>,
    pub mcp_runs: Vec<ScopedProcessRun>,
    pub adapters: Vec<ProjectAdapter>,
    pub dap_sessions: Vec<DapSession>,
    pub diagnostics: Vec<DiagnosticFinding>,
    pub advisories: Vec<AdvisoryRecord>,
    pub regression_runs: Vec<RegressionRun>,
    pub resident_process_count: usize,
    pub lifecycle: Vec<ExtensionLifecycleView>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionLifecycleView {
    pub id: String,
    pub state: ExtensionLifecycle,
    pub model_discoverable: bool,
    pub running_count: usize,
}

pub struct ExtensionService {
    root: PathBuf,
    state: Mutex<PersistedState>,
    orchestration: Arc<OrchestrationService>,
    sampler: Mutex<ProcessSampler>,
    import_previews: Mutex<BTreeMap<String, ExternalImportPreview>>,
    mcp_previews: Mutex<BTreeMap<String, McpImportPreview>>,
    persistence: Mutex<()>,
}

impl ExtensionService {
    pub fn open(root: &Path, orchestration: Arc<OrchestrationService>) -> Result<Self, String> {
        fs::create_dir_all(root.join("imports"))
            .map_err(|error| format!("create extension store: {error}"))?;
        fs::create_dir_all(root.join("regressions"))
            .map_err(|error| format!("create regression store: {error}"))?;
        let state_path = root.join("state.json");
        let mut state = if state_path.exists() {
            serde_json::from_slice::<PersistedState>(
                &fs::read(&state_path).map_err(|error| format!("read extension state: {error}"))?,
            )
            .map_err(|error| format!("invalid extension state: {error}"))?
        } else {
            PersistedState {
                schema_version: STATE_SCHEMA,
                ..Default::default()
            }
        };
        if state.schema_version != STATE_SCHEMA {
            return Err(format!(
                "unsupported extension state schema {}",
                state.schema_version
            ));
        }
        for run in state
            .runs
            .values_mut()
            .filter(|run| run.state == ExtensionRunState::Running)
        {
            run.state = ExtensionRunState::Terminated;
            run.termination_result = Some("process ownership unavailable after restart".into());
        }
        for run in state
            .mcp_runs
            .values_mut()
            .filter(|run| run.state == "running")
        {
            run.state = "terminated".into();
            run.termination_result = Some("process ownership unavailable after restart".into());
        }
        for session in state
            .dap_sessions
            .values_mut()
            .filter(|session| session.state == "running")
        {
            session.state = "terminated".into();
        }
        for advisory in state
            .advisories
            .iter_mut()
            .filter(|item| item.state == "running")
        {
            advisory.state = "terminated".into();
        }
        let service = Self {
            root: root.to_owned(),
            state: Mutex::new(state),
            orchestration,
            sampler: Mutex::new(ProcessSampler::default()),
            import_previews: Mutex::new(BTreeMap::new()),
            mcp_previews: Mutex::new(BTreeMap::new()),
            persistence: Mutex::new(()),
        };
        service.persist()?;
        Ok(service)
    }

    pub fn install(&self, manifest: ExtensionManifest) -> Result<(), String> {
        manifest.validate()?;
        let mut state = self.lock_state()?;
        if state.installations.contains_key(&manifest.id) {
            return Err("extension is already installed".into());
        }
        state.installations.insert(manifest.id.clone(), manifest);
        drop(state);
        self.persist()
    }

    pub fn migrate(
        &self,
        extension_id: &str,
        replacement: ExtensionManifest,
        permission_expansion_approved: bool,
    ) -> Result<(), String> {
        replacement.validate()?;
        if extension_id != replacement.id {
            return Err("migration cannot change extension identity".into());
        }
        let mut state = self.lock_state()?;
        let current = state
            .installations
            .get(extension_id)
            .ok_or_else(|| "extension is not installed".to_owned())?;
        if replacement.schema_version <= current.schema_version {
            return Err("extension downgrade or same-version migration is incompatible".into());
        }
        if !replacement.permissions.is_subset(&current.permissions)
            && !permission_expansion_approved
        {
            return Err("extension permission expansion requires explicit review".into());
        }
        state.installations.insert(extension_id.into(), replacement);
        drop(state);
        self.persist()
    }

    pub fn set_enabled(&self, extension_id: &str, enabled: bool) -> Result<(), String> {
        let job_ids = {
            let mut state = self.lock_state()?;
            state
                .installations
                .get_mut(extension_id)
                .ok_or_else(|| "extension is not installed".to_owned())?
                .enabled = enabled;
            if enabled {
                Vec::new()
            } else {
                state
                    .runs
                    .values()
                    .filter(|run| run.extension_id == extension_id && !run.state.terminal())
                    .map(|run| run.job_id.clone())
                    .collect()
            }
        };
        for job_id in job_ids {
            let _ = self.orchestration.cancel_job(&job_id);
        }
        self.refresh()?;
        self.persist()
    }

    pub fn set_trusted(&self, extension_id: &str, trusted: bool) -> Result<(), String> {
        let mut state = self.lock_state()?;
        let manifest = state
            .installations
            .get(extension_id)
            .ok_or_else(|| "extension is not installed".to_owned())?;
        if !manifest.enabled {
            return Err("enable the extension before changing trust".into());
        }
        if state
            .runs
            .values()
            .any(|run| run.extension_id == extension_id && !run.state.terminal())
        {
            return Err("stop the extension before changing trust".into());
        }
        if trusted {
            state.trusted_extensions.insert(extension_id.to_owned());
        } else {
            state.trusted_extensions.remove(extension_id);
        }
        drop(state);
        self.persist()
    }

    pub fn start_extension(
        &self,
        extension_id: &str,
        task_id: &str,
        agent_run_id: &str,
        cwd: &Path,
        timeout: Duration,
    ) -> Result<ExtensionRunView, String> {
        let manifest = self
            .lock_state()?
            .installations
            .get(extension_id)
            .cloned()
            .ok_or_else(|| "extension is not installed".to_owned())?;
        if !manifest.enabled {
            return Err("extension is disabled; enable it before explicit startup".into());
        }
        if !self.lock_state()?.trusted_extensions.contains(extension_id) {
            return Err("extension is not trusted; review its source and permissions first".into());
        }
        if !manifest.permissions.contains(&Permission::ProcessExecute) {
            return Err("extension lacks processExecute permission".into());
        }
        let job = self.orchestration.start_job(
            task_id,
            agent_run_id,
            &manifest.executable,
            &manifest.arguments,
            cwd,
            timeout,
        )?;
        let run = ExtensionRunView {
            id: Uuid::new_v4().to_string(),
            extension_id: extension_id.into(),
            task_id: task_id.into(),
            agent_run_id: agent_run_id.into(),
            job_id: job.id,
            process_id: job.process_id,
            state: ExtensionRunState::Running,
            observed_memory_bytes: 0,
            output_tail: Vec::new(),
            full_output_hash: job.full_output_hash,
            termination_result: None,
            started_at: job.started_at,
        };
        self.lock_state()?.runs.insert(run.id.clone(), run.clone());
        self.persist()?;
        Ok(run)
    }

    pub fn cancel_run(&self, run_id: &str) -> Result<ExtensionRunView, String> {
        let job_id = self
            .lock_state()?
            .runs
            .get(run_id)
            .map(|run| run.job_id.clone())
            .ok_or_else(|| "extension run is missing".to_owned())?;
        self.orchestration.cancel_job(&job_id)?;
        self.refresh()?;
        self.run(run_id)
    }

    #[cfg(test)]
    pub fn wait_run(&self, run_id: &str, timeout: Duration) -> Result<ExtensionRunView, String> {
        let started = Instant::now();
        loop {
            self.refresh()?;
            let run = self.run(run_id)?;
            if run.state.terminal() {
                let remaining = timeout.saturating_sub(started.elapsed());
                self.orchestration.wait_job(&run.job_id, remaining)?;
                self.refresh()?;
                return self.run(run_id);
            }
            if started.elapsed() >= timeout {
                return Err("wait for extension run timed out".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn run(&self, run_id: &str) -> Result<ExtensionRunView, String> {
        self.lock_state()?
            .runs
            .get(run_id)
            .cloned()
            .ok_or_else(|| "extension run is missing".to_owned())
    }

    pub fn refresh(&self) -> Result<(), String> {
        let jobs = self.orchestration.snapshot().jobs;
        let run_ids: Vec<String> = self.lock_state()?.runs.keys().cloned().collect();
        let mut resource_stops = Vec::new();
        let changed = {
            let mut state = self.lock_state()?;
            let mut changed = false;
            for run_id in run_ids {
                let extension_id = match state.runs.get(&run_id) {
                    Some(run) => run.extension_id.clone(),
                    None => continue,
                };
                let limit = state
                    .installations
                    .get(&extension_id)
                    .map(|manifest| manifest.limits)
                    .unwrap_or(ResourceLimits {
                        max_memory_bytes: u64::MAX,
                        max_output_bytes: 64 * 1024,
                    });
                let Some(run) = state.runs.get_mut(&run_id) else {
                    continue;
                };
                let Some(job) = jobs.iter().find(|job| job.id == run.job_id) else {
                    continue;
                };
                let output_tail = bounded_tail(&job.live_tail, limit.max_output_bytes);
                // ResourceStopped is the extension owner's terminal reason.
                // The underlying job is then cancelled as the mechanism used
                // to stop it; that lower-level Cancelled state must not erase
                // the more specific resource-policy outcome on the next poll.
                let preserve_resource_stop = run.state == ExtensionRunState::ResourceStopped
                    && job.status == ManagedJobStatus::Cancelled;
                let next_state = if preserve_resource_stop {
                    ExtensionRunState::ResourceStopped
                } else {
                    map_job_state(job.status)
                };
                let next_termination = if preserve_resource_stop {
                    run.termination_result.clone()
                } else {
                    job.termination_result.clone()
                };
                if run.output_tail != output_tail
                    || run.full_output_hash != job.full_output_hash
                    || run.termination_result != next_termination
                    || run.state != next_state
                {
                    changed = true;
                }
                run.output_tail = output_tail;
                run.full_output_hash.clone_from(&job.full_output_hash);
                run.termination_result = next_termination;
                run.state = next_state;
                if run.state == ExtensionRunState::Running {
                    if let Ok(sample) = self
                        .sampler
                        .lock()
                        .map_err(lock_error)?
                        .sample(run.process_id, unix_millis())
                    {
                        run.observed_memory_bytes = sample.memory_bytes;
                        if sample.memory_bytes > limit.max_memory_bytes {
                            run.state = ExtensionRunState::ResourceStopped;
                            run.termination_result = Some("extension exceeded memory limit".into());
                            resource_stops.push(run.job_id.clone());
                            changed = true;
                        }
                    }
                }
            }
            changed |= sync_scoped_processes(&mut state, &jobs);
            changed
        };
        for job_id in resource_stops {
            let _ = self.orchestration.cancel_job(&job_id);
        }
        if changed {
            self.persist()
        } else {
            Ok(())
        }
    }

    pub fn snapshot(&self) -> ExtensionSnapshot {
        let _ = self.refresh();
        let state = match self.lock_state() {
            Ok(state) => state,
            Err(_) => {
                return ExtensionSnapshot {
                    installations: Vec::new(),
                    runs: Vec::new(),
                    imports: Vec::new(),
                    import_activations: Vec::new(),
                    mcp_configs: Vec::new(),
                    mcp_runs: Vec::new(),
                    adapters: Vec::new(),
                    dap_sessions: Vec::new(),
                    diagnostics: Vec::new(),
                    advisories: Vec::new(),
                    regression_runs: Vec::new(),
                    resident_process_count: 0,
                    lifecycle: Vec::new(),
                }
            }
        };
        let runs: Vec<_> = state.runs.values().cloned().collect();
        let resident_process_count = runs.iter().filter(|run| !run.state.terminal()).count()
            + state
                .mcp_runs
                .values()
                .filter(|run| run.state == "running")
                .count()
            + state
                .dap_sessions
                .values()
                .filter(|run| run.state == "running")
                .count();
        let lifecycle = state
            .installations
            .values()
            .map(|manifest| {
                let running_count = runs
                    .iter()
                    .filter(|run| {
                        run.extension_id == manifest.id && run.state == ExtensionRunState::Running
                    })
                    .count();
                let trusted = state.trusted_extensions.contains(&manifest.id);
                ExtensionLifecycleView {
                    id: manifest.id.clone(),
                    state: if running_count > 0 {
                        ExtensionLifecycle::Running
                    } else if manifest.enabled && trusted {
                        ExtensionLifecycle::Trusted
                    } else if manifest.enabled {
                        ExtensionLifecycle::Enabled
                    } else {
                        ExtensionLifecycle::Discovered
                    },
                    model_discoverable: manifest.enabled,
                    running_count,
                }
            })
            .collect();
        ExtensionSnapshot {
            installations: state.installations.values().cloned().collect(),
            runs,
            imports: state.imports.values().cloned().collect(),
            import_activations: state.import_activations.clone(),
            mcp_configs: state.mcp_configs.values().cloned().collect(),
            mcp_runs: state.mcp_runs.values().cloned().collect(),
            adapters: state.adapters.values().cloned().collect(),
            dap_sessions: state.dap_sessions.values().cloned().collect(),
            diagnostics: state.diagnostics.iter().cloned().collect(),
            advisories: state.advisories.clone(),
            regression_runs: state.regression_runs.clone(),
            resident_process_count,
            lifecycle,
        }
    }

    pub fn preview_external_import(
        &self,
        source: ExternalSource,
        root: &Path,
    ) -> Result<ExternalImportPreview, String> {
        let root = root
            .canonicalize()
            .map_err(|error| format!("resolve import root: {error}"))?;
        if !root.is_dir() {
            return Err("external import root must be a directory selected by the user".into());
        }
        let mut candidates = Vec::new();
        let mut truncated = false;
        scan_import_directory(&root, &root, source, &mut candidates, &mut truncated)?;
        candidates.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        let preview = ExternalImportPreview {
            id: Uuid::new_v4().to_string(),
            source,
            root,
            candidates,
            truncated,
        };
        self.import_previews
            .lock()
            .map_err(lock_error)?
            .insert(preview.id.clone(), preview.clone());
        Ok(preview)
    }

    pub fn apply_external_import(
        &self,
        preview_id: &str,
        selected_ids: &[String],
        scope: ExtensionScope,
    ) -> Result<Vec<ImportedCapability>, String> {
        validate_scope(&scope)?;
        let preview = self
            .import_previews
            .lock()
            .map_err(lock_error)?
            .remove(preview_id)
            .ok_or_else(|| "external import preview expired".to_owned())?;
        let selected: BTreeSet<&str> = selected_ids.iter().map(String::as_str).collect();
        if selected.len() != selected_ids.len() {
            return Err("external import selection contains duplicate ids".into());
        }
        let mut pending = Vec::new();
        for selected_id in selected {
            let candidate = preview
                .candidates
                .iter()
                .find(|candidate| candidate.id == selected_id)
                .ok_or_else(|| format!("external import candidate {selected_id} is missing"))?;
            if let Some(reason) = &candidate.unsupported_reason {
                return Err(format!(
                    "unsupported import {}: {reason}",
                    candidate.relative_path.display()
                ));
            }
            let bytes = read_bounded_regular_file(&candidate.source_path)?;
            let version = content_hash(&bytes);
            if version != candidate.version {
                return Err(format!(
                    "external import {} changed after preview",
                    candidate.relative_path.display()
                ));
            }
            let id = Uuid::new_v4().to_string();
            let extension = candidate
                .source_path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("md");
            let stored_path = self.root.join("imports").join(format!("{id}.{extension}"));
            pending.push((
                bytes,
                ImportedCapability {
                    id,
                    source: candidate.source,
                    kind: candidate.kind,
                    source_path: candidate.relative_path.clone(),
                    stored_path,
                    version,
                    scope: scope.clone(),
                    enabled: true,
                    imported_at: unix_millis(),
                },
            ));
        }

        let staged = {
            let mut state = self.lock_state()?;
            for (_, item) in &pending {
                let conflict = state.imports.values().any(|existing| {
                    existing.source == item.source
                        && existing.source_path == item.source_path
                        && existing.scope == item.scope
                        && existing.enabled
                });
                if conflict {
                    return Err(format!(
                        "import conflict for {} requires explicit disable/review",
                        item.source_path.display()
                    ));
                }
            }
            let mut created = Vec::new();
            for (bytes, item) in &pending {
                if let Err(error) = create_atomic(&item.stored_path, bytes) {
                    for path in created {
                        let _ = fs::remove_file(path);
                    }
                    return Err(error);
                }
                created.push(item.stored_path.clone());
            }
            let staged = pending
                .into_iter()
                .map(|(_, item)| item)
                .collect::<Vec<_>>();
            for item in &staged {
                state.imports.insert(item.id.clone(), item.clone());
            }
            staged
        };
        if let Err(error) = self.persist() {
            if let Ok(mut state) = self.lock_state() {
                for item in &staged {
                    state.imports.remove(&item.id);
                }
            }
            for item in &staged {
                let _ = fs::remove_file(&item.stored_path);
            }
            return Err(error);
        }
        Ok(staged)
    }

    pub fn activate_import(
        &self,
        imported_id: &str,
        task_id: &str,
        task_override_id: Option<String>,
    ) -> Result<ImportActivation, String> {
        let mut state = self.lock_state()?;
        let item = state
            .imports
            .get(imported_id)
            .ok_or_else(|| "import is missing".to_owned())?;
        if !item.enabled || !item.scope.task_matches(task_id) {
            return Err("import is disabled or belongs to another task".into());
        }
        let activation = ImportActivation {
            id: Uuid::new_v4().to_string(),
            imported_id: imported_id.into(),
            task_id: task_id.into(),
            task_override_id,
            activated_at: unix_millis(),
        };
        state.import_activations.push(activation.clone());
        drop(state);
        self.persist()?;
        Ok(activation)
    }

    pub fn imported_content(&self, imported_id: &str) -> Result<String, String> {
        let item = self
            .lock_state()?
            .imports
            .get(imported_id)
            .cloned()
            .ok_or_else(|| "import is missing".to_owned())?;
        let bytes = read_bounded_regular_file(&item.stored_path)?;
        if content_hash(&bytes) != item.version {
            return Err(
                "imported capability content no longer matches its recorded version".into(),
            );
        }
        String::from_utf8(bytes).map_err(|_| "imported capability is not UTF-8".into())
    }

    pub fn imported(&self, imported_id: &str) -> Result<ImportedCapability, String> {
        self.lock_state()?
            .imports
            .get(imported_id)
            .cloned()
            .ok_or_else(|| "import is missing".to_owned())
    }

    pub fn preview_mcp_json(&self, content: &str) -> Result<McpImportPreview, String> {
        if content.len() > 1024 * 1024 {
            return Err("MCP configuration exceeds 1 MiB".into());
        }
        let document: serde_json::Value =
            serde_json::from_str(content).map_err(|error| format!("invalid MCP JSON: {error}"))?;
        let servers = document
            .get("mcpServers")
            .and_then(serde_json::Value::as_object)
            .or_else(|| document.as_object())
            .ok_or_else(|| "MCP JSON must contain an mcpServers object".to_owned())?;
        let mut candidates = Vec::new();
        for (id, value) in servers {
            let Some(object) = value.as_object() else {
                continue;
            };
            let command = object
                .get("command")
                .and_then(serde_json::Value::as_str)
                .map(PathBuf::from);
            let url = object
                .get("url")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            let transport = if url.is_some() {
                McpTransport::StreamableHttp
            } else {
                McpTransport::Stdio
            };
            let arguments = object
                .get("args")
                .and_then(serde_json::Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let mut required = BTreeSet::new();
            if let Some(values) = object.get("env").and_then(serde_json::Value::as_object) {
                required.extend(values.keys().cloned());
            }
            if let Some(values) = object.get("headers").and_then(serde_json::Value::as_object) {
                required.extend(values.keys().cloned());
            }
            let required_environment = required.into_iter().collect();
            let unsupported_reason = match (&command, &url) {
                (Some(_), None) | (None, Some(_)) => None,
                (Some(_), Some(_)) => Some("server declares both command and URL".into()),
                (None, None) => Some("server declares neither command nor URL".into()),
            };
            candidates.push(McpImportCandidate {
                id: id.clone(),
                transport,
                command,
                arguments,
                url,
                required_environment,
                unsupported_reason,
            });
        }
        candidates.sort_by(|left, right| left.id.cmp(&right.id));
        let preview = McpImportPreview {
            id: Uuid::new_v4().to_string(),
            candidates,
        };
        self.mcp_previews
            .lock()
            .map_err(lock_error)?
            .insert(preview.id.clone(), preview.clone());
        Ok(preview)
    }

    pub fn apply_mcp_import(
        &self,
        preview_id: &str,
        selected: &BTreeMap<String, BTreeMap<String, SecretReference>>,
        scope: ExtensionScope,
    ) -> Result<Vec<McpServerConfig>, String> {
        validate_scope(&scope)?;
        let preview = self
            .mcp_previews
            .lock()
            .map_err(lock_error)?
            .remove(preview_id)
            .ok_or_else(|| "MCP import preview expired".to_owned())?;
        let mut configs = Vec::new();
        for (candidate_id, refs) in selected {
            let candidate = preview
                .candidates
                .iter()
                .find(|candidate| &candidate.id == candidate_id)
                .ok_or_else(|| format!("MCP candidate {candidate_id} is missing"))?;
            if let Some(reason) = &candidate.unsupported_reason {
                return Err(format!("unsupported MCP server {candidate_id}: {reason}"));
            }
            let required: BTreeSet<_> = candidate.required_environment.iter().cloned().collect();
            let supplied: BTreeSet<_> = refs.keys().cloned().collect();
            if required != supplied {
                return Err(format!("MCP server {candidate_id} requires explicit secret references for every environment field"));
            }
            configs.push(McpServerConfig {
                id: candidate.id.clone(),
                transport: candidate.transport,
                command: candidate.command.clone(),
                arguments: candidate.arguments.clone(),
                url: candidate.url.clone(),
                environment: refs.clone(),
                scope: scope.clone(),
                enabled: true,
            });
        }
        let mut state = self.lock_state()?;
        for config in &configs {
            if state.mcp_configs.contains_key(&config.id) {
                return Err(format!(
                    "MCP server {} already exists and requires conflict review",
                    config.id
                ));
            }
        }
        for config in &configs {
            state.mcp_configs.insert(config.id.clone(), config.clone());
        }
        drop(state);
        self.persist()?;
        Ok(configs)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn start_mcp(
        &self,
        server_id: &str,
        task_id: &str,
        agent_run_id: &str,
        cwd: &Path,
        timeout: Duration,
        secrets: &SecretStore,
    ) -> Result<ScopedProcessRun, String> {
        let config = self
            .lock_state()?
            .mcp_configs
            .get(server_id)
            .cloned()
            .ok_or_else(|| "MCP server is not imported".to_owned())?;
        if !config.enabled || !config.scope.task_matches(task_id) {
            return Err("MCP server is disabled or belongs to another task".into());
        }
        if config.transport != McpTransport::Stdio {
            return Err("Streamable HTTP MCP uses the Pi client transport and has no resident extension process".into());
        }
        let executable = config
            .command
            .as_ref()
            .ok_or_else(|| "stdio MCP command is missing".to_owned())?;
        let mut environment = BTreeMap::new();
        for (name, reference) in &config.environment {
            let resolved = secrets.resolve(reference)?;
            let value = std::str::from_utf8(resolved.as_slice())
                .map_err(|_| format!("MCP secret {name} is not UTF-8"))?
                .trim_end_matches(['\r', '\n'])
                .to_owned();
            environment.insert(name.clone(), value);
        }
        let job = self.orchestration.start_job_with_environment(
            task_id,
            agent_run_id,
            executable,
            &config.arguments,
            cwd,
            timeout,
            &environment,
        )?;
        environment.values_mut().for_each(|value| value.clear());
        let run = ScopedProcessRun {
            id: Uuid::new_v4().to_string(),
            owner_id: server_id.into(),
            task_id: task_id.into(),
            agent_run_id: agent_run_id.into(),
            job_id: Some(job.id),
            process_id: Some(job.process_id),
            state: "running".into(),
            started_at: unix_millis(),
            termination_result: None,
        };
        self.lock_state()?
            .mcp_runs
            .insert(run.id.clone(), run.clone());
        self.persist()?;
        Ok(run)
    }

    pub fn prepare_mcp_client(
        &self,
        server_id: &str,
        task_id: &str,
        secrets: &SecretStore,
    ) -> Result<McpClientActivation, String> {
        let config = self
            .lock_state()?
            .mcp_configs
            .get(server_id)
            .cloned()
            .ok_or_else(|| "MCP server is not imported".to_owned())?;
        if !config.enabled || !config.scope.task_matches(task_id) {
            return Err("MCP server is disabled or belongs to another task".into());
        }
        let mut environment = BTreeMap::new();
        for (name, reference) in &config.environment {
            let resolved = secrets.resolve(reference)?;
            let value = std::str::from_utf8(resolved.as_slice())
                .map_err(|_| format!("MCP secret {name} is not UTF-8"))?
                .trim_end_matches(['\r', '\n'])
                .to_owned();
            environment.insert(name.clone(), value);
        }
        Ok(McpClientActivation {
            server_id: config.id,
            task_id: task_id.into(),
            transport: config.transport,
            command: config.command,
            arguments: config.arguments,
            url: config.url,
            environment,
        })
    }

    pub fn record_mcp_client_ready(
        &self,
        server_id: &str,
        task_id: &str,
    ) -> Result<ScopedProcessRun, String> {
        let run = ScopedProcessRun {
            id: Uuid::new_v4().to_string(),
            owner_id: server_id.into(),
            task_id: task_id.into(),
            agent_run_id: String::new(),
            job_id: None,
            process_id: None,
            state: "ready".into(),
            started_at: unix_millis(),
            termination_result: None,
        };
        self.lock_state()?
            .mcp_runs
            .insert(run.id.clone(), run.clone());
        self.persist()?;
        Ok(run)
    }

    pub fn register_adapter(&self, adapter: ProjectAdapter) -> Result<(), String> {
        validate_identifier(&adapter.id, "adapter")?;
        if adapter.markers.is_empty()
            || adapter.action_ids.is_empty()
            || adapter.provenance.trim().is_empty()
        {
            return Err("adapter markers, actions, and provenance are required".into());
        }
        let mut state = self.lock_state()?;
        if state.adapters.contains_key(&adapter.id) {
            return Err("adapter is already registered".into());
        }
        state.adapters.insert(adapter.id.clone(), adapter);
        drop(state);
        self.persist()
    }

    pub fn set_adapter_enabled(&self, adapter_id: &str, enabled: bool) -> Result<(), String> {
        self.lock_state()?
            .adapters
            .get_mut(adapter_id)
            .ok_or_else(|| "adapter is missing".to_owned())?
            .enabled = enabled;
        self.persist()
    }

    pub fn active_adapters(&self, workspace: &Path) -> Result<Vec<AdapterMatch>, String> {
        let workspace = workspace
            .canonicalize()
            .map_err(|error| format!("resolve adapter workspace: {error}"))?;
        let state = self.lock_state()?;
        let mut matches = Vec::new();
        for adapter in state.adapters.values().filter(|adapter| adapter.enabled) {
            let markers: Vec<String> = adapter
                .markers
                .iter()
                .filter(|marker| {
                    safe_relative(marker)
                        .map(|relative| workspace.join(relative).exists())
                        .unwrap_or(false)
                })
                .cloned()
                .collect();
            if !markers.is_empty() {
                matches.push(AdapterMatch {
                    adapter_id: adapter.id.clone(),
                    markers,
                    action_ids: adapter.action_ids.clone(),
                    provenance: adapter.provenance.clone(),
                });
            }
        }
        Ok(matches)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn launch_dap(
        &self,
        task_id: &str,
        agent_run_id: &str,
        cwd: &Path,
        config: DapLaunchConfig,
        explicitly_authorized: bool,
        timeout: Duration,
    ) -> Result<DapSession, String> {
        if !explicitly_authorized {
            return Err("DAP launch or attach requires explicit authorization".into());
        }
        if !matches!(config.request.as_str(), "launch" | "attach")
            || config.target.trim().is_empty()
        {
            return Err("DAP configuration is incomplete or unsupported".into());
        }
        if config.max_events == 0 || config.max_events > 10_000 {
            return Err("DAP event limit must be between 1 and 10000".into());
        }
        let job = self.orchestration.start_job(
            task_id,
            agent_run_id,
            &config.adapter,
            &config.arguments,
            cwd,
            timeout,
        )?;
        let session = DapSession {
            id: Uuid::new_v4().to_string(),
            task_id: task_id.into(),
            agent_run_id: agent_run_id.into(),
            job_id: job.id,
            process_id: job.process_id,
            request: config.request,
            target: config.target,
            events: Vec::new(),
            state: "running".into(),
            evidence_ref: None,
        };
        self.lock_state()?
            .dap_sessions
            .insert(session.id.clone(), session.clone());
        self.persist()?;
        Ok(session)
    }

    pub fn record_dap_event(
        &self,
        session_id: &str,
        event: &str,
        max_events: usize,
    ) -> Result<DapSession, String> {
        if event.len() > 64 * 1024 || max_events == 0 || max_events > 10_000 {
            return Err("DAP event or retention limit is invalid".into());
        }
        let mut state = self.lock_state()?;
        let session = state
            .dap_sessions
            .get_mut(session_id)
            .ok_or_else(|| "DAP session is missing".to_owned())?;
        let event_kind = event.split_whitespace().next().unwrap_or_default();
        session.events.push(event.into());
        if session.events.len() > max_events {
            let overflow = session.events.len() - max_events;
            session.events.drain(..overflow);
        }
        if matches!(event_kind, "terminated" | "exited") {
            session.state = "terminated".into();
        }
        let snapshot = session.clone();
        drop(state);
        self.persist()?;
        Ok(snapshot)
    }

    pub fn attach_dap_evidence(
        &self,
        session_id: &str,
        evidence_ref: String,
    ) -> Result<DapSession, String> {
        let mut state = self.lock_state()?;
        let session = state
            .dap_sessions
            .get_mut(session_id)
            .ok_or_else(|| "DAP session is missing".to_owned())?;
        session.evidence_ref = Some(evidence_ref);
        let snapshot = session.clone();
        drop(state);
        self.persist()?;
        Ok(snapshot)
    }

    pub fn cancel_task_processes(&self, task_id: &str) -> Result<(), String> {
        let job_ids = {
            let state = self.lock_state()?;
            state
                .runs
                .values()
                .filter(|run| run.task_id == task_id && !run.state.terminal())
                .map(|run| run.job_id.clone())
                .chain(
                    state
                        .mcp_runs
                        .values()
                        .filter(|run| run.task_id == task_id && run.state == "running")
                        .filter_map(|run| run.job_id.clone()),
                )
                .chain(
                    state
                        .dap_sessions
                        .values()
                        .filter(|run| run.task_id == task_id && run.state == "running")
                        .map(|run| run.job_id.clone()),
                )
                .collect::<BTreeSet<_>>()
        };
        for job_id in job_ids {
            let _ = self.orchestration.cancel_job(&job_id);
        }
        self.refresh()
    }

    pub fn cancel_agent_processes(&self, agent_run_id: &str) -> Result<(), String> {
        let job_ids = {
            let state = self.lock_state()?;
            state
                .runs
                .values()
                .filter(|run| run.agent_run_id == agent_run_id && !run.state.terminal())
                .map(|run| run.job_id.clone())
                .chain(
                    state
                        .mcp_runs
                        .values()
                        .filter(|run| run.agent_run_id == agent_run_id && run.state == "running")
                        .filter_map(|run| run.job_id.clone()),
                )
                .chain(
                    state
                        .dap_sessions
                        .values()
                        .filter(|run| run.agent_run_id == agent_run_id && run.state == "running")
                        .map(|run| run.job_id.clone()),
                )
                .collect::<BTreeSet<_>>()
        };
        for job_id in job_ids {
            let _ = self.orchestration.cancel_job(&job_id);
        }
        self.refresh()
    }

    pub fn add_diagnostic(&self, finding: DiagnosticFinding) -> Result<(), String> {
        if finding.source.trim().is_empty()
            || finding.path.as_os_str().is_empty()
            || finding.version.trim().is_empty()
            || finding.message.trim().is_empty()
        {
            return Err("diagnostic finding is incomplete".into());
        }
        self.lock_state()?.diagnostics.insert(finding);
        self.persist()
    }

    pub fn request_advisory(
        &self,
        task_id: &str,
        role: &str,
        model: &str,
        context_bytes: usize,
        cost_limit_micros: u64,
        allowed_tools: BTreeSet<String>,
    ) -> Result<AdvisoryRecord, String> {
        if task_id.trim().is_empty()
            || role.trim().is_empty()
            || model.trim().is_empty()
            || context_bytes == 0
            || context_bytes > 1024 * 1024
            || cost_limit_micros == 0
        {
            return Err("advisory request is incomplete or exceeds its bound".into());
        }
        if allowed_tools.is_empty()
            || allowed_tools
                .iter()
                .any(|tool| !matches!(tool.as_str(), "read" | "search"))
        {
            return Err("advisers are limited to declared read and search tools".into());
        }
        let record = AdvisoryRecord {
            id: Uuid::new_v4().to_string(),
            task_id: task_id.into(),
            role: role.into(),
            model: model.into(),
            context_bytes,
            cost_limit_micros,
            allowed_tools,
            candidate_output: None,
            child_port: None,
            child_run_id: None,
            output_is_evidence: false,
            state: default_advisory_state(),
            recorded_at: unix_millis(),
        };
        self.lock_state()?.advisories.push(record.clone());
        self.persist()?;
        Ok(record)
    }

    pub fn bind_advisory_process(
        &self,
        advisory_id: &str,
        child_port: u16,
    ) -> Result<AdvisoryRecord, String> {
        if child_port == 0 {
            return Err("advisory child process requires an exact Pi port".into());
        }
        let mut state = self.lock_state()?;
        if state.advisories.iter().any(|item| {
            item.id != advisory_id && item.child_port == Some(child_port) && item.state == "running"
        }) {
            return Err("advisory Pi port is already bound".into());
        }
        let advisory = state
            .advisories
            .iter_mut()
            .find(|item| item.id == advisory_id)
            .ok_or_else(|| "advisory request is missing".to_owned())?;
        if advisory.candidate_output.is_some()
            || !matches!(advisory.state.as_str(), "requested" | "failed")
        {
            return Err("advisory request cannot be rebound in its current state".into());
        }
        advisory.child_port = Some(child_port);
        advisory.child_run_id = None;
        advisory.state = "running".into();
        let result = advisory.clone();
        drop(state);
        self.persist()?;
        Ok(result)
    }

    pub fn complete_advisory_for_process(
        &self,
        child_port: u16,
        child_run_id: &str,
        candidate_output: &str,
    ) -> Result<Option<AdvisoryRecord>, String> {
        if child_run_id.trim().is_empty() {
            return Err("advisory child Agent Run is required".into());
        }
        if candidate_output.len() > 64 * 1024 {
            return Err("advisory output exceeds 64 KiB".into());
        }
        let mut state = self.lock_state()?;
        let Some(advisory) = state
            .advisories
            .iter_mut()
            .rev()
            .find(|item| item.child_port == Some(child_port) && item.state == "running")
        else {
            return Ok(None);
        };
        advisory.child_run_id = Some(child_run_id.into());
        advisory.candidate_output = Some(candidate_output.into());
        advisory.state = "completed".into();
        let result = advisory.clone();
        drop(state);
        self.persist()?;
        Ok(Some(result))
    }

    pub fn fail_advisory_for_process(&self, child_port: u16, reason: &str) -> Result<(), String> {
        let mut state = self.lock_state()?;
        let Some(advisory) = state
            .advisories
            .iter_mut()
            .rev()
            .find(|item| item.child_port == Some(child_port) && item.state == "running")
        else {
            return Ok(());
        };
        advisory.state = "failed".into();
        advisory.candidate_output = Some(reason.chars().take(4 * 1024).collect());
        drop(state);
        self.persist()
    }

    pub fn complete_advisory(
        &self,
        advisory_id: &str,
        candidate_output: &str,
    ) -> Result<AdvisoryRecord, String> {
        if candidate_output.len() > 64 * 1024 {
            return Err("advisory output exceeds 64 KiB".into());
        }
        let mut state = self.lock_state()?;
        let advisory = state
            .advisories
            .iter_mut()
            .find(|item| item.id == advisory_id)
            .ok_or_else(|| "advisory request is missing".to_owned())?;
        advisory.candidate_output = Some(candidate_output.into());
        advisory.state = "completed".into();
        let result = advisory.clone();
        drop(state);
        self.persist()?;
        Ok(result)
    }

    pub fn record_regression(
        &self,
        scenario: RegressionScenario,
        picode_version: &str,
        model: &str,
        metrics: RegressionMetrics,
        artifact: &[u8],
    ) -> Result<RegressionRun, String> {
        validate_identifier(&scenario.id, "regression scenario")?;
        if scenario.version == 0
            || scenario.fixture_hash.trim().is_empty()
            || scenario.environment.trim().is_empty()
            || picode_version.trim().is_empty()
            || model.trim().is_empty()
            || artifact.len() > 16 * 1024 * 1024
            || !(0.0..=1.0).contains(&metrics.verification_accuracy)
            || !(0.0..=1.0).contains(&metrics.routing_accuracy)
        {
            return Err("regression scenario, metrics, or artifact is invalid".into());
        }
        let id = Uuid::new_v4().to_string();
        let artifact_path = self.root.join("regressions").join(format!("{id}.json"));
        create_atomic(&artifact_path, artifact)?;
        let run = RegressionRun {
            id,
            scenario,
            picode_version: picode_version.into(),
            model: model.into(),
            metrics,
            artifact_hash: content_hash(artifact),
            artifact_path,
            recorded_at: unix_millis(),
        };
        self.lock_state()?.regression_runs.push(run.clone());
        self.persist()?;
        Ok(run)
    }

    pub fn compare_regressions(
        &self,
        before_id: &str,
        after_id: &str,
    ) -> Result<RegressionComparison, String> {
        let state = self.lock_state()?;
        let before = state
            .regression_runs
            .iter()
            .find(|run| run.id == before_id)
            .ok_or_else(|| "baseline regression run is missing".to_owned())?;
        let after = state
            .regression_runs
            .iter()
            .find(|run| run.id == after_id)
            .ok_or_else(|| "candidate regression run is missing".to_owned())?;
        if before.scenario != after.scenario || before.model != after.model {
            return Err(
                "regression runs use incompatible scenarios, fixtures, environments, or models"
                    .into(),
            );
        }
        Ok(RegressionComparison {
            startup_delta_ms: after.metrics.startup_ms - before.metrics.startup_ms,
            idle_memory_delta_bytes: after.metrics.idle_memory_bytes as i128
                - before.metrics.idle_memory_bytes as i128,
            token_delta: after.metrics.tokens as i128 - before.metrics.tokens as i128,
        })
    }

    fn lock_state(&self) -> Result<MutexGuard<'_, PersistedState>, String> {
        self.state.lock().map_err(lock_error)
    }

    fn persist(&self) -> Result<(), String> {
        let _persistence = self.persistence.lock().map_err(lock_error)?;
        let bytes = serde_json::to_vec_pretty(&*self.lock_state()?)
            .map_err(|error| format!("encode extension state: {error}"))?;
        atomic_replace(&self.root.join("state.json"), &bytes)
    }
}

fn sync_scoped_processes(
    state: &mut PersistedState,
    jobs: &[crate::orchestration_service::ManagedJobView],
) -> bool {
    let mut changed = false;
    for run in state.mcp_runs.values_mut() {
        let Some(job_id) = &run.job_id else { continue };
        if let Some(job) = jobs.iter().find(|job| &job.id == job_id) {
            let next_state = job_state_label(job.status);
            if run.state != next_state || run.termination_result != job.termination_result {
                changed = true;
                run.state = next_state.into();
                run.termination_result.clone_from(&job.termination_result);
            }
        }
    }
    for session in state.dap_sessions.values_mut() {
        if let Some(job) = jobs.iter().find(|job| job.id == session.job_id) {
            let next_state = job_state_label(job.status);
            if session.state != next_state {
                changed = true;
                session.state = next_state.into();
            }
        }
    }
    changed
}

fn map_job_state(status: ManagedJobStatus) -> ExtensionRunState {
    match status {
        ManagedJobStatus::Running => ExtensionRunState::Running,
        ManagedJobStatus::Completed => ExtensionRunState::Completed,
        ManagedJobStatus::Failed => ExtensionRunState::Failed,
        ManagedJobStatus::Cancelled => ExtensionRunState::Cancelled,
        ManagedJobStatus::TimedOut => ExtensionRunState::TimedOut,
        ManagedJobStatus::Terminated => ExtensionRunState::Terminated,
        ManagedJobStatus::TerminationUnknown => ExtensionRunState::Failed,
    }
}

fn job_state_label(status: ManagedJobStatus) -> &'static str {
    map_job_state(status).as_str()
}

fn bounded_tail(bytes: &[u8], max: usize) -> Vec<u8> {
    bytes[bytes.len().saturating_sub(max)..].to_vec()
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err(format!("{label} id is invalid"));
    }
    Ok(())
}

fn validate_scope(scope: &ExtensionScope) -> Result<(), String> {
    if matches!(scope, ExtensionScope::Task(task_id) if task_id.trim().is_empty()) {
        return Err("task extension scope requires a task id".into());
    }
    Ok(())
}

fn safe_relative(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("adapter marker must be a normalized relative path".into());
    }
    Ok(path.to_owned())
}

fn scan_import_directory(
    root: &Path,
    directory: &Path,
    source: ExternalSource,
    candidates: &mut Vec<ExternalImportCandidate>,
    truncated: &mut bool,
) -> Result<(), String> {
    if candidates.len() >= MAX_IMPORT_FILES {
        *truncated = true;
        return Ok(());
    }
    let mut entries: Vec<_> = fs::read_dir(directory)
        .map_err(|error| format!("scan external import directory: {error}"))?
        .collect::<Result<_, _>>()
        .map_err(|error| format!("scan external import entry: {error}"))?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        if candidates.len() >= MAX_IMPORT_FILES {
            *truncated = true;
            break;
        }
        let file_type = entry
            .file_type()
            .map_err(|error| format!("inspect import entry: {error}"))?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "import path escaped selected root".to_owned())?;
        if file_type.is_dir() {
            let depth = relative.components().count();
            if depth <= 6 && import_directory_relevant(source, relative) {
                scan_import_directory(root, &path, source, candidates, truncated)?;
            }
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let Some((kind, unsupported_reason)) = classify_import(source, relative) else {
            continue;
        };
        let metadata = entry
            .metadata()
            .map_err(|error| format!("inspect import file: {error}"))?;
        let oversized = (metadata.len() > MAX_IMPORT_BYTES)
            .then(|| "file exceeds the 512 KiB import limit".into());
        let reason = unsupported_reason.or(oversized);
        let bytes = if reason.is_none() {
            fs::read(&path).map_err(|error| format!("read import candidate: {error}"))?
        } else {
            Vec::new()
        };
        let version = if bytes.is_empty() {
            "unavailable".into()
        } else {
            content_hash(&bytes)
        };
        candidates.push(ExternalImportCandidate {
            id: format!(
                "{:x}",
                Sha256::digest(format!("{source:?}:{}", relative.display()).as_bytes())
            ),
            source,
            kind,
            relative_path: relative.to_owned(),
            version,
            bytes: metadata.len(),
            unsupported_reason: reason,
            source_path: path,
        });
    }
    Ok(())
}

fn import_directory_relevant(source: ExternalSource, relative: &Path) -> bool {
    let normalized = relative
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    match source {
        ExternalSource::Codex => normalized.starts_with(".codex") || !normalized.starts_with('.'),
        ExternalSource::Claude => normalized.starts_with(".claude") || !normalized.starts_with('.'),
        ExternalSource::Cursor => normalized.starts_with(".cursor") || !normalized.starts_with('.'),
        ExternalSource::OpenCode => {
            normalized.starts_with(".opencode") || !normalized.starts_with('.')
        }
    }
}

fn classify_import(
    source: ExternalSource,
    relative: &Path,
) -> Option<(ImportKind, Option<String>)> {
    let normalized = relative
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    let file_name = relative.file_name()?.to_string_lossy().to_ascii_lowercase();
    let supported_text = matches!(
        relative.extension().and_then(|value| value.to_str()),
        Some("md" | "mdc")
    );
    let classified = match source {
        ExternalSource::Codex if normalized == "agents.md" => ImportKind::Rule,
        ExternalSource::Codex
            if normalized.starts_with(".codex/skills/") && file_name == "skill.md" =>
        {
            ImportKind::Skill
        }
        ExternalSource::Codex if normalized.starts_with(".codex/commands/") => ImportKind::Command,
        ExternalSource::Claude if normalized == "claude.md" => ImportKind::Rule,
        ExternalSource::Claude
            if normalized.starts_with(".claude/skills/") && file_name == "skill.md" =>
        {
            ImportKind::Skill
        }
        ExternalSource::Claude if normalized.starts_with(".claude/commands/") => {
            ImportKind::Command
        }
        ExternalSource::Cursor if normalized.starts_with(".cursor/rules/") => ImportKind::Rule,
        ExternalSource::Cursor
            if normalized.starts_with(".cursor/skills/") && file_name == "skill.md" =>
        {
            ImportKind::Skill
        }
        ExternalSource::Cursor if normalized.starts_with(".cursor/commands/") => {
            ImportKind::Command
        }
        ExternalSource::OpenCode if normalized == "agents.md" => ImportKind::Rule,
        ExternalSource::OpenCode
            if normalized.starts_with(".opencode/skills/") && file_name == "skill.md" =>
        {
            ImportKind::Skill
        }
        ExternalSource::OpenCode if normalized.starts_with(".opencode/commands/") => {
            ImportKind::Command
        }
        _ => return None,
    };
    Some((
        classified,
        (!supported_text)
            .then(|| "only Markdown rule, Skill, and prompt-command formats are supported".into()),
    ))
}

fn read_bounded_regular_file(path: &Path) -> Result<Vec<u8>, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("inspect import file: {error}"))?;
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_IMPORT_BYTES
    {
        return Err("import source is not a bounded regular file".into());
    }
    fs::read(path).map_err(|error| format!("read import file: {error}"))
}

fn create_atomic(path: &Path, content: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("create {}: {error}", path.display()))?;
    file.write_all(content)
        .map_err(|error| format!("write {}: {error}", path.display()))?;
    file.sync_all()
        .map_err(|error| format!("sync {}: {error}", path.display()))
}

fn atomic_replace(path: &Path, content: &[u8]) -> Result<(), String> {
    let store = SafeFileStore;
    if path.exists() {
        let current = store.read(path)?;
        store.write_atomic(path, &current.version, content)?;
    } else {
        store.create_atomic(path, content)?;
    }
    Ok(())
}

fn content_hash(content: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(content))
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn default_advisory_state() -> String {
    "requested".into()
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    "extension service lock is poisoned".into()
}

#[cfg(test)]
mod tests {
    use super::{
        AdvisoryRecord, DapLaunchConfig, DiagnosticFinding, DiagnosticSeverity, ExtensionManifest,
        ExtensionScope, ExtensionService, ExternalSource, FindingKind, ProjectAdapter,
        RegressionMetrics, RegressionScenario, ResourceLimits,
    };
    use crate::extension_host::Permission;
    use crate::orchestration_service::OrchestrationService;
    use crate::secrets::{SecretReference, SecretStore};
    use std::collections::BTreeSet;
    use std::sync::Arc;

    #[test]
    fn disabled_heavy_extensions_are_nonresident_and_real_runs_are_isolated() {
        let root =
            std::env::temp_dir().join(format!("picode-extension-service-{}", uuid::Uuid::new_v4()));
        let orchestration = Arc::new(OrchestrationService::open(&root.join("jobs"), 1024).unwrap());
        let service = ExtensionService::open(&root.join("extensions"), orchestration).unwrap();
        let manifest = ExtensionManifest::new(
            "review",
            1,
            std::env::current_exe().unwrap(),
            vec![
                "extension_service::tests::extension_fixture".into(),
                "--exact".into(),
                "--nocapture".into(),
            ],
            BTreeSet::from([Permission::WorkspaceRead, Permission::ProcessExecute]),
            ResourceLimits {
                max_memory_bytes: 512 * 1024 * 1024,
                max_output_bytes: 128,
            },
        );
        service.install(manifest).unwrap();
        assert_eq!(service.snapshot().resident_process_count, 0);
        let error = service
            .start_extension(
                "review",
                "task-a",
                "run-a",
                &root,
                std::time::Duration::from_secs(5),
            )
            .unwrap_err();
        assert!(error.contains("disabled"));
        service.set_enabled("review", true).unwrap();
        assert!(service
            .start_extension(
                "review",
                "task-a",
                "run-a",
                &root,
                std::time::Duration::from_secs(5),
            )
            .unwrap_err()
            .contains("trusted"));
        service.set_trusted("review", true).unwrap();
        let run = service
            .start_extension(
                "review",
                "task-a",
                "run-a",
                &root,
                std::time::Duration::from_secs(5),
            )
            .unwrap();
        let finished = service
            .wait_run(&run.id, std::time::Duration::from_secs(5))
            .unwrap();
        assert_eq!(finished.state.as_str(), "completed");
        assert!(finished.output_tail.len() <= 128);
        assert_eq!(service.snapshot().resident_process_count, 0);
        let reopened = ExtensionService::open(
            &root.join("extensions"),
            Arc::new(OrchestrationService::open(&root.join("jobs"), 1024).unwrap()),
        )
        .unwrap();
        assert!(reopened
            .snapshot()
            .installations
            .iter()
            .any(|item| item.id == "review"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn extension_fixture() {
        println!("isolated extension output");
    }

    #[test]
    #[ignore]
    fn extension_crash_fixture() {
        panic!("isolated extension crash");
    }

    #[test]
    #[ignore]
    fn extension_hang_fixture() {
        std::thread::sleep(std::time::Duration::from_secs(30));
    }

    #[test]
    fn extension_crashes_and_hangs_end_without_corrupting_the_host() {
        let root = test_root("failure-isolation");
        let service = test_service(&root);
        let executable = std::env::current_exe().unwrap();
        for (id, fixture, timeout) in [
            (
                "crash",
                "extension_service::tests::extension_crash_fixture",
                std::time::Duration::from_secs(5),
            ),
            (
                "hang",
                "extension_service::tests::extension_hang_fixture",
                std::time::Duration::from_millis(100),
            ),
        ] {
            service
                .install(ExtensionManifest::new(
                    id,
                    1,
                    executable.clone(),
                    vec![
                        "--ignored".into(),
                        "--exact".into(),
                        fixture.into(),
                        "--nocapture".into(),
                    ],
                    BTreeSet::from([Permission::ProcessExecute]),
                    ResourceLimits {
                        max_memory_bytes: 512 * 1024 * 1024,
                        max_output_bytes: 1024,
                    },
                ))
                .unwrap();
            service.set_enabled(id, true).unwrap();
            service.set_trusted(id, true).unwrap();
            let run = service
                .start_extension(id, "task-a", "run-a", &root, timeout)
                .unwrap();
            let terminal = service
                .wait_run(&run.id, std::time::Duration::from_secs(5))
                .unwrap();
            if id == "crash" {
                assert_eq!(terminal.state, super::ExtensionRunState::Failed);
            } else {
                assert_eq!(terminal.state, super::ExtensionRunState::TimedOut);
            }
        }
        assert_eq!(service.snapshot().resident_process_count, 0);
        assert_eq!(service.snapshot().installations.len(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn extension_memory_limit_is_enforced_without_an_open_monitor_panel() {
        let root = test_root("memory-limit");
        let service = test_service(&root);
        service
            .install(ExtensionManifest::new(
                "memory-bound",
                1,
                std::env::current_exe().unwrap(),
                vec![
                    "--ignored".into(),
                    "--exact".into(),
                    "extension_service::tests::extension_hang_fixture".into(),
                    "--nocapture".into(),
                ],
                BTreeSet::from([Permission::ProcessExecute]),
                ResourceLimits {
                    max_memory_bytes: 1024 * 1024,
                    max_output_bytes: 1024,
                },
            ))
            .unwrap();
        service.set_enabled("memory-bound", true).unwrap();
        service.set_trusted("memory-bound", true).unwrap();
        let run = service
            .start_extension(
                "memory-bound",
                "task-a",
                "run-a",
                &root,
                std::time::Duration::from_secs(10),
            )
            .unwrap();
        let terminal = service
            .wait_run(&run.id, std::time::Duration::from_secs(5))
            .unwrap();
        assert_eq!(terminal.state, super::ExtensionRunState::ResourceStopped);
        assert!(terminal.observed_memory_bytes > 1024 * 1024);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migrations_imports_and_conflicts_are_explicit_transactional_and_durable() {
        let root = test_root("imports");
        let service = test_service(&root);
        let executable = std::env::current_exe().unwrap();
        let original = ExtensionManifest::new(
            "adapter",
            1,
            executable.clone(),
            Vec::new(),
            BTreeSet::from([Permission::WorkspaceRead]),
            ResourceLimits {
                max_memory_bytes: 64 * 1024 * 1024,
                max_output_bytes: 1024,
            },
        );
        service.install(original).unwrap();
        let expanded = ExtensionManifest::new(
            "adapter",
            2,
            executable,
            Vec::new(),
            BTreeSet::from([Permission::WorkspaceRead, Permission::WorkspaceWrite]),
            ResourceLimits {
                max_memory_bytes: 64 * 1024 * 1024,
                max_output_bytes: 1024,
            },
        );
        assert!(service
            .migrate("adapter", expanded.clone(), false)
            .unwrap_err()
            .contains("permission"));
        assert_eq!(service.snapshot().installations[0].schema_version, 1);
        service.migrate("adapter", expanded, true).unwrap();

        let source = root.join("source");
        std::fs::create_dir_all(source.join(".codex/skills/tdd")).unwrap();
        std::fs::create_dir_all(source.join(".codex/commands")).unwrap();
        std::fs::write(source.join("AGENTS.md"), "# Rules").unwrap();
        std::fs::write(source.join(".codex/skills/tdd/SKILL.md"), "# TDD").unwrap();
        std::fs::write(source.join(".codex/commands/build.ps1"), "Remove-Item *").unwrap();
        let preview = service
            .preview_external_import(ExternalSource::Codex, &source)
            .unwrap();
        assert_eq!(preview.candidates.len(), 3);
        assert!(preview
            .candidates
            .iter()
            .any(|item| item.unsupported_reason.is_some()));
        let selected: Vec<String> = preview
            .candidates
            .iter()
            .filter(|item| item.unsupported_reason.is_none())
            .map(|item| item.id.clone())
            .collect();
        let imported = service
            .apply_external_import(
                &preview.id,
                &selected,
                ExtensionScope::Task("task-a".into()),
            )
            .unwrap();
        assert_eq!(imported.len(), 2);
        assert!(imported.iter().all(|item| item
            .stored_path
            .starts_with(root.join("extensions/imports"))));
        let stored_before_conflict = std::fs::read_dir(root.join("extensions/imports"))
            .unwrap()
            .count();
        let second = service
            .preview_external_import(ExternalSource::Codex, &source)
            .unwrap();
        let duplicate = second
            .candidates
            .iter()
            .filter(|item| item.unsupported_reason.is_none())
            .map(|item| item.id.clone())
            .collect::<Vec<_>>();
        assert!(service
            .apply_external_import(
                &second.id,
                &duplicate,
                ExtensionScope::Task("task-a".into())
            )
            .unwrap_err()
            .contains("conflict"));
        assert_eq!(
            std::fs::read_dir(root.join("extensions/imports"))
                .unwrap()
                .count(),
            stored_before_conflict,
            "a rejected import must not leave orphaned staged files",
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn mcp_secrets_are_reference_only_lazy_scoped_and_process_owned() {
        let root = test_root("mcp");
        let service = test_service(&root);
        let executable = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .replace('\\', "\\\\");
        let document = format!(
            r#"{{"mcpServers":{{"memory":{{"command":"{executable}","args":["extension_service::tests::mcp_fixture","--exact","--nocapture"],"env":{{"PIC_PRIMARY_SECRET":"literal-must-not-survive"}}}}}}}}"#
        );
        let preview = service.preview_mcp_json(&document).unwrap();
        assert_eq!(service.snapshot().resident_process_count, 0);
        assert_eq!(
            preview.candidates[0].required_environment,
            vec!["PIC_PRIMARY_SECRET"]
        );
        assert!(!serde_json::to_string(&preview)
            .unwrap()
            .contains("literal-must-not-survive"));
        let secret_file = root.join("secret.txt");
        std::fs::write(&secret_file, "resolved-at-launch").unwrap();
        let selected = std::collections::BTreeMap::from([(
            "memory".into(),
            std::collections::BTreeMap::from([(
                "PIC_PRIMARY_SECRET".into(),
                SecretReference::File { path: secret_file },
            )]),
        )]);
        service
            .apply_mcp_import(
                &preview.id,
                &selected,
                ExtensionScope::Task("task-a".into()),
            )
            .unwrap();
        let secret_store = SecretStore::new(root.join("temporary-secrets")).unwrap();
        let run = service
            .start_mcp(
                "memory",
                "task-a",
                "run-a",
                &root,
                std::time::Duration::from_secs(5),
                &secret_store,
            )
            .unwrap();
        assert!(run.process_id.is_some());
        wait_for_no_residents(&service);
        let persisted = std::fs::read_to_string(root.join("extensions/state.json")).unwrap();
        assert!(!persisted.contains("resolved-at-launch"));
        assert!(!persisted.contains("literal-must-not-survive"));
        assert!(service
            .start_mcp(
                "memory",
                "task-b",
                "run-b",
                &root,
                std::time::Duration::from_secs(5),
                &secret_store,
            )
            .unwrap_err()
            .contains("another task"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn mcp_fixture() {
        if let Ok(value) = std::env::var("PIC_PRIMARY_SECRET") {
            assert_eq!(value, "resolved-at-launch");
        }
        println!("MCP ready");
    }

    #[test]
    fn adapters_dap_diagnostics_advisories_and_regressions_preserve_boundaries() {
        let root = test_root("professional");
        let service = test_service(&root);
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("Cargo.toml"), "[package]").unwrap();
        std::fs::write(workspace.join("Game.sln"), "solution").unwrap();
        service
            .register_adapter(ProjectAdapter {
                id: "rust".into(),
                markers: vec!["Cargo.toml".into()],
                action_ids: vec!["cargo.test".into()],
                diagnostic_kinds: vec!["rustc".into()],
                enabled: true,
                provenance: "builtin:rust@1".into(),
            })
            .unwrap();
        service
            .register_adapter(ProjectAdapter {
                id: "dotnet".into(),
                markers: vec!["Game.sln".into()],
                action_ids: vec!["dotnet.test".into()],
                diagnostic_kinds: vec!["compiler".into()],
                enabled: true,
                provenance: "extension:dotnet@1".into(),
            })
            .unwrap();
        assert_eq!(service.active_adapters(&workspace).unwrap().len(), 2);
        service.set_adapter_enabled("dotnet", false).unwrap();
        assert_eq!(
            service.active_adapters(&workspace).unwrap()[0].adapter_id,
            "rust"
        );

        let args = vec![
            "extension_service::tests::dap_fixture".into(),
            "--exact".into(),
            "--nocapture".into(),
        ];
        assert!(service
            .launch_dap(
                "task-a",
                "run-a",
                &workspace,
                DapLaunchConfig {
                    adapter: std::env::current_exe().unwrap(),
                    arguments: args.clone(),
                    request: "launch".into(),
                    target: "game.exe".into(),
                    max_events: 2,
                },
                false,
                std::time::Duration::from_secs(5)
            )
            .unwrap_err()
            .contains("authorization"));
        let dap = service
            .launch_dap(
                "task-a",
                "run-a",
                &workspace,
                DapLaunchConfig {
                    adapter: std::env::current_exe().unwrap(),
                    arguments: args,
                    request: "launch".into(),
                    target: "game.exe".into(),
                    max_events: 2,
                },
                true,
                std::time::Duration::from_secs(5),
            )
            .unwrap();
        service.record_dap_event(&dap.id, "initialized", 2).unwrap();
        service.record_dap_event(&dap.id, "stopped", 2).unwrap();
        let terminal = service.record_dap_event(&dap.id, "terminated", 2).unwrap();
        assert_eq!(
            service.snapshot().dap_sessions[0].events,
            vec!["stopped", "terminated"]
        );
        assert_eq!(terminal.state, "terminated");
        service
            .attach_dap_evidence(&dap.id, "evidence:dap".into())
            .unwrap();
        assert_eq!(
            service.snapshot().dap_sessions[0].evidence_ref.as_deref(),
            Some("evidence:dap")
        );

        let deterministic = DiagnosticFinding {
            source: "rustc".into(),
            path: "src/lib.rs".into(),
            version: "sha256:a".into(),
            line: 4,
            severity: DiagnosticSeverity::Error,
            message: "E1".into(),
            kind: FindingKind::Deterministic,
            evidence_ref: Some("evidence:a".into()),
        };
        service.add_diagnostic(deterministic.clone()).unwrap();
        service.add_diagnostic(deterministic).unwrap();
        assert_eq!(service.snapshot().diagnostics.len(), 1);
        let adviser: AdvisoryRecord = service
            .request_advisory(
                "task-a",
                "security",
                "model-b",
                2_000,
                50,
                BTreeSet::from(["read".into(), "search".into()]),
            )
            .unwrap();
        assert!(!adviser.output_is_evidence);
        service.bind_advisory_process(&adviser.id, 47899).unwrap();
        let completed = service
            .complete_advisory_for_process(47899, "run-child", "candidate review")
            .unwrap()
            .expect("the bound adviser should be completed");
        assert_eq!(completed.child_run_id.as_deref(), Some("run-child"));
        assert_eq!(
            completed.candidate_output.as_deref(),
            Some("candidate review")
        );
        assert_eq!(completed.state, "completed");
        assert!(!completed.output_is_evidence);
        assert!(service
            .request_advisory(
                "task-a",
                "writer",
                "model-b",
                2_000,
                50,
                BTreeSet::from(["write".into()]),
            )
            .unwrap_err()
            .contains("read and search"));

        let scenario = RegressionScenario {
            id: "small-search".into(),
            version: 1,
            fixture_hash: "sha256:fixture".into(),
            environment: "windows-x64".into(),
        };
        let metrics = RegressionMetrics {
            success: true,
            edit_retries: 0,
            verification_accuracy: 1.0,
            routing_accuracy: 1.0,
            tokens: 100,
            cost_micros: 20,
            startup_ms: 400,
            interaction_ms: 30,
            idle_memory_bytes: 80,
            peak_memory_bytes: 120,
            false_stalls: 0,
        };
        let before = service
            .record_regression(
                scenario.clone(),
                "0.3.0",
                "model-a",
                metrics.clone(),
                b"{\"pass\":true}",
            )
            .unwrap();
        let after = service
            .record_regression(
                scenario,
                "0.3.1",
                "model-a",
                RegressionMetrics {
                    startup_ms: 350,
                    ..metrics
                },
                b"{\"pass\":true}",
            )
            .unwrap();
        assert_eq!(
            service
                .compare_regressions(&before.id, &after.id)
                .unwrap()
                .startup_delta_ms,
            -50
        );
        assert!(before.artifact_path.exists());
        service.cancel_task_processes("task-a").unwrap();
        wait_for_no_residents(&service);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn dap_fixture() {
        println!("DAP initialized");
    }

    fn test_root(label: &str) -> std::path::PathBuf {
        let root =
            std::env::temp_dir().join(format!("picode-extension-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn test_service(root: &std::path::Path) -> ExtensionService {
        let orchestration =
            Arc::new(OrchestrationService::open(&root.join("jobs"), 64 * 1024).unwrap());
        ExtensionService::open(&root.join("extensions"), orchestration).unwrap()
    }

    fn wait_for_no_residents(service: &ExtensionService) {
        let started = std::time::Instant::now();
        loop {
            if service.snapshot().resident_process_count == 0 {
                return;
            }
            assert!(started.elapsed() < std::time::Duration::from_secs(5));
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
}
