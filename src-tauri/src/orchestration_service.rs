use crate::orchestration::{
    route_delegation, CheckpointPackage, DelegatedWork, ModelCandidate, ModelFallback,
    RoutingDecision, RoutingEvaluations, SubagentModelPolicy, TaskGraph,
};
#[cfg(test)]
use crate::orchestration::{DelegationEnvelope, Stage};
use crate::safe_files::SafeFileStore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ManagedJobStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
    TimedOut,
    Terminated,
    TerminationUnknown,
}

impl ManagedJobStatus {
    fn terminal(self) -> bool {
        self != Self::Running
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedJobView {
    pub id: String,
    pub task_id: String,
    pub agent_run_id: String,
    pub process_id: u32,
    pub command: String,
    pub cwd: PathBuf,
    pub started_at: u64,
    pub status: ManagedJobStatus,
    pub live_tail: Vec<u8>,
    pub full_output_hash: String,
    pub artifact_path: PathBuf,
    pub exit_code: Option<i32>,
    pub termination_result: Option<String>,
}

struct RuntimeJob {
    view: ManagedJobView,
    child: Option<Arc<Mutex<Child>>>,
    process_owner: Option<Arc<ProcessOwner>>,
    hasher: Sha256,
    durable: bool,
}

/// Owns the complete process tree of a managed job. On Windows a Job Object
/// is the actual ownership boundary; dropping the final handle is configured
/// to kill any descendants that are still alive.
struct ProcessOwner {
    #[cfg(windows)]
    job: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
unsafe impl Send for ProcessOwner {}
#[cfg(windows)]
unsafe impl Sync for ProcessOwner {}

impl ProcessOwner {
    fn attach(child: &Child) -> Result<Self, String> {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            };

            // SAFETY: every handle is checked, assigned once, and owned by
            // ProcessOwner until Drop closes it.
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err(format!(
                        "create Windows Job Object: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let configured = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    std::ptr::addr_of!(limits).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if configured == 0 {
                    let error = std::io::Error::last_os_error();
                    CloseHandle(job);
                    return Err(format!("configure Windows Job Object: {error}"));
                }
                let process = child.as_raw_handle().cast();
                if AssignProcessToJobObject(job, process) == 0 {
                    let error = std::io::Error::last_os_error();
                    CloseHandle(job);
                    return Err(format!("assign process to Windows Job Object: {error}"));
                }
                Ok(Self { job })
            }
        }
        #[cfg(not(windows))]
        {
            let _ = child;
            Ok(Self {})
        }
    }

    fn terminate(&self) -> Result<(), String> {
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::JobObjects::TerminateJobObject;
            // SAFETY: the Job Object handle remains owned by this value.
            if unsafe { TerminateJobObject(self.job, 1) } == 0 {
                return Err(format!(
                    "terminate Windows Job Object: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for ProcessOwner {
    fn drop(&mut self) {
        // SAFETY: this is the sole close for the owned handle.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job);
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedState {
    schema_version: u32,
    #[serde(default)]
    jobs: Vec<ManagedJobView>,
    #[serde(default)]
    graphs: BTreeMap<String, TaskGraph>,
    #[serde(default)]
    routing_decisions: Vec<RoutingDecisionRecord>,
    #[serde(default)]
    worktrees: Vec<GitWorktreeRecord>,
    #[serde(default)]
    subagent_policy: SubagentPolicyConfiguration,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingDecisionRecord {
    pub id: String,
    pub task_id: String,
    pub parent_run_id: String,
    pub class: String,
    pub decision: RoutingDecision,
    pub recorded_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DelegationRequest {
    pub task_id: String,
    pub parent_run_id: String,
    pub work: DelegatedWork,
    pub policy: SubagentModelPolicy,
    pub qualified_models: Vec<String>,
}

#[cfg(test)]
impl DelegationRequest {
    fn read_only_fixture(task_id: &str, parent_run_id: &str) -> Self {
        let envelope = DelegationEnvelope {
            goal: "find references".into(),
            scope: vec!["src".into()],
            method: "bounded text search".into(),
            tools: ["search".to_owned(), "read".to_owned()]
                .into_iter()
                .collect(),
            permissions: ["workspace.read".to_owned()].into_iter().collect(),
            context: vec!["symbol=Player".into()],
            stop_conditions: vec!["all matches listed".into()],
            expected_result: "path and line list".into(),
        };
        Self {
            task_id: task_id.into(),
            parent_run_id: parent_run_id.into(),
            work: DelegatedWork::read_only_search("repository-search", envelope),
            policy: SubagentModelPolicy {
                candidates: vec![
                    ModelCandidate::new("cheap", 8, 10, 1, true),
                    ModelCandidate::new("capable", 10, 7, 8, true),
                ],
                fallback: ModelFallback::Ask,
            },
            qualified_models: vec!["cheap".into(), "capable".into()],
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestrationSnapshot {
    pub jobs: Vec<ManagedJobView>,
    pub graphs: BTreeMap<String, TaskGraph>,
    pub routing_decisions: Vec<RoutingDecisionRecord>,
    pub worktrees: Vec<GitWorktreeRecord>,
    pub subagent_policy: SubagentPolicyConfiguration,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentPolicyConfiguration {
    pub enabled: bool,
    pub candidates: Vec<ModelCandidate>,
    pub fallback: ModelFallback,
    pub qualified_classes: Vec<String>,
}

impl Default for SubagentPolicyConfiguration {
    fn default() -> Self {
        Self {
            enabled: false,
            candidates: Vec::new(),
            fallback: ModelFallback::DoNotDelegate,
            qualified_classes: vec![
                "repository-search".into(),
                "documentation-search".into(),
                "code-review".into(),
                "test-execution".into(),
                "implementation".into(),
                "advisory-review".into(),
            ],
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshot {
    pub repository_root: PathBuf,
    pub head: String,
    pub branch: Option<String>,
    pub status_porcelain_v2: String,
    pub dirty: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRewindPreview {
    pub repository_root: PathBuf,
    pub current_head: String,
    pub target_commit: String,
    pub dirty: bool,
    pub has_untracked: bool,
    pub changed_paths: String,
    pub state_fingerprint: String,
    pub confirmation: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HandoffRequest {
    pub task_id: String,
    pub workspace: PathBuf,
    pub summary: String,
    #[serde(default)]
    pub tests: Vec<String>,
    #[serde(default)]
    pub red_probes: Vec<String>,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    #[serde(default)]
    pub unresolved: Vec<String>,
    pub recovery: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffPackageV2 {
    pub schema_version: u32,
    pub task_id: String,
    pub authority: String,
    pub created_at: u64,
    pub git: GitSnapshot,
    pub diff_stat: String,
    pub summary: String,
    pub tests: Vec<String>,
    pub red_probes: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub unresolved: Vec<String>,
    pub recovery: String,
    pub package_path: PathBuf,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitWorktreeStatus {
    Active,
    Preserved,
    Integrated,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeRecord {
    pub id: String,
    pub task_id: String,
    pub repository_root: PathBuf,
    pub base_commit: String,
    pub branch: String,
    pub path: PathBuf,
    pub status: GitWorktreeStatus,
    pub created_at: u64,
}

pub struct OrchestrationService {
    root: PathBuf,
    tail_bytes: usize,
    jobs: Arc<Mutex<BTreeMap<String, RuntimeJob>>>,
    graphs: Arc<Mutex<BTreeMap<String, TaskGraph>>>,
    routing_decisions: Arc<Mutex<Vec<RoutingDecisionRecord>>>,
    worktrees: Arc<Mutex<BTreeMap<String, GitWorktreeRecord>>>,
    subagent_policy: Arc<Mutex<SubagentPolicyConfiguration>>,
    persistence: Arc<Mutex<()>>,
}

impl OrchestrationService {
    pub fn open(root: &Path, tail_bytes: usize) -> Result<Self, String> {
        if tail_bytes == 0 {
            return Err("background job tail limit must be positive".into());
        }
        fs::create_dir_all(root.join("artifacts"))
            .map_err(|error| format!("create orchestration store: {error}"))?;
        let state_path = root.join("state.json");
        let mut state = if state_path.exists() {
            serde_json::from_slice::<PersistedState>(
                &fs::read(&state_path)
                    .map_err(|error| format!("read orchestration state: {error}"))?,
            )
            .map_err(|error| format!("invalid orchestration state: {error}"))?
        } else {
            PersistedState {
                schema_version: 1,
                ..Default::default()
            }
        };
        if state.schema_version != 1 {
            return Err(format!(
                "unsupported orchestration state schema {}",
                state.schema_version
            ));
        }
        for job in &mut state.jobs {
            if job.status == ManagedJobStatus::Running {
                job.status = ManagedJobStatus::Terminated;
                job.termination_result = Some("process ownership unavailable after restart".into());
            }
        }
        let jobs = state
            .jobs
            .into_iter()
            .map(|view| {
                let hasher = hash_existing_artifact(&view.artifact_path);
                (
                    view.id.clone(),
                    RuntimeJob {
                        view,
                        child: None,
                        process_owner: None,
                        hasher,
                        durable: true,
                    },
                )
            })
            .collect();
        let service = Self {
            root: root.to_owned(),
            tail_bytes,
            jobs: Arc::new(Mutex::new(jobs)),
            graphs: Arc::new(Mutex::new(state.graphs)),
            routing_decisions: Arc::new(Mutex::new(state.routing_decisions)),
            worktrees: Arc::new(Mutex::new(
                state
                    .worktrees
                    .into_iter()
                    .map(|worktree| (worktree.id.clone(), worktree))
                    .collect(),
            )),
            subagent_policy: Arc::new(Mutex::new(state.subagent_policy)),
            persistence: Arc::new(Mutex::new(())),
        };
        service.persist()?;
        Ok(service)
    }

    pub fn start_job(
        &self,
        task_id: &str,
        agent_run_id: &str,
        executable: &Path,
        args: &[String],
        cwd: &Path,
        timeout: Duration,
    ) -> Result<ManagedJobView, String> {
        self.start_job_with_environment(
            task_id,
            agent_run_id,
            executable,
            args,
            cwd,
            timeout,
            &BTreeMap::new(),
        )
    }

    /// Starts one owned process without a command shell. Environment values are
    /// applied directly to the child and are deliberately excluded from every
    /// persisted view and artifact.
    #[allow(clippy::too_many_arguments)]
    pub fn start_job_with_environment(
        &self,
        task_id: &str,
        agent_run_id: &str,
        executable: &Path,
        args: &[String],
        cwd: &Path,
        timeout: Duration,
        environment: &BTreeMap<String, String>,
    ) -> Result<ManagedJobView, String> {
        if task_id.trim().is_empty() || agent_run_id.trim().is_empty() {
            return Err("background job task and Agent Run identity are required".into());
        }
        if timeout.is_zero() || timeout > Duration::from_secs(24 * 60 * 60) {
            return Err("background job timeout must be within 24 hours".into());
        }
        if args.iter().any(|arg| arg.contains('\0')) {
            return Err("background job argument contains NUL".into());
        }
        if environment.iter().any(|(name, value)| {
            name.trim().is_empty()
                || name.contains('=')
                || name.contains('\0')
                || value.contains('\0')
        }) {
            return Err("background job environment contains an invalid name or NUL".into());
        }
        let cwd = cwd
            .canonicalize()
            .map_err(|error| format!("resolve background job cwd: {error}"))?;
        let id = Uuid::new_v4().to_string();
        let artifact_path = self.root.join("artifacts").join(format!("{id}.log"));
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&artifact_path)
            .map_err(|error| format!("create background job artifact: {error}"))?;
        let mut command = Command::new(executable);
        command
            .args(args)
            .envs(environment)
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_process_group(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| format!("start background job: {error}"))?;
        let process_owner = match ProcessOwner::attach(&child) {
            Ok(owner) => Arc::new(owner),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let process_id = child.id();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let child = Arc::new(Mutex::new(child));
        let view = ManagedJobView {
            id: id.clone(),
            task_id: task_id.into(),
            agent_run_id: agent_run_id.into(),
            process_id,
            command: executable.to_string_lossy().into_owned(),
            cwd,
            started_at: unix_millis(),
            status: ManagedJobStatus::Running,
            live_tail: Vec::new(),
            full_output_hash: format!("{:x}", Sha256::digest([])),
            artifact_path,
            exit_code: None,
            termination_result: None,
        };
        self.jobs.lock().map_err(lock_error)?.insert(
            id.clone(),
            RuntimeJob {
                view: view.clone(),
                child: Some(child.clone()),
                process_owner: Some(process_owner.clone()),
                hasher: Sha256::new(),
                durable: false,
            },
        );
        self.persist()?;
        if let Some(job) = self.jobs.lock().map_err(lock_error)?.get_mut(&id) {
            job.durable = true;
        }
        let mut output_readers = Vec::new();
        if let Some(stdout) = stdout {
            output_readers.push(spawn_output_reader(
                stdout,
                self.jobs.clone(),
                self.persistence.clone(),
                self.root.clone(),
                self.tail_bytes,
                &id,
            ));
        }
        if let Some(stderr) = stderr {
            output_readers.push(spawn_output_reader(
                stderr,
                self.jobs.clone(),
                self.persistence.clone(),
                self.root.clone(),
                self.tail_bytes,
                &id,
            ));
        }
        spawn_job_monitor(
            child,
            process_owner,
            self.jobs.clone(),
            self.graphs.clone(),
            self.routing_decisions.clone(),
            self.worktrees.clone(),
            self.subagent_policy.clone(),
            self.persistence.clone(),
            self.root.clone(),
            id,
            timeout,
            output_readers,
        );
        Ok(view)
    }

    pub fn cancel_job(&self, id: &str) -> Result<ManagedJobView, String> {
        let (child, process_owner) = {
            let jobs = self.jobs.lock().map_err(lock_error)?;
            let job = jobs
                .get(id)
                .ok_or_else(|| "background job missing".to_owned())?;
            if job.view.status.terminal() {
                return Err("background job is already terminal".into());
            }
            (
                job.child
                    .clone()
                    .ok_or_else(|| "background job process is unavailable".to_owned())?,
                job.process_owner
                    .clone()
                    .ok_or_else(|| "background job process owner is unavailable".to_owned())?,
            )
        };
        let termination = terminate_process_tree(&child, &process_owner);
        let view = {
            let mut jobs = self.jobs.lock().map_err(lock_error)?;
            let job = jobs
                .get_mut(id)
                .ok_or_else(|| "background job missing".to_owned())?;
            match termination {
                Ok(()) => {
                    job.view.status = ManagedJobStatus::Cancelled;
                    job.view.termination_result = Some("owned process tree exit confirmed".into());
                }
                Err(error) => {
                    job.view.status = ManagedJobStatus::TerminationUnknown;
                    job.view.termination_result = Some(error);
                }
            }
            job.durable = false;
            job.view.clone()
        };
        self.persist()?;
        if let Some(job) = self.jobs.lock().map_err(lock_error)?.get_mut(id) {
            job.durable = true;
        }
        Ok(view)
    }

    pub fn job(&self, id: &str) -> Result<ManagedJobView, String> {
        self.jobs
            .lock()
            .map_err(lock_error)?
            .get(id)
            .map(|job| job.view.clone())
            .ok_or_else(|| "background job missing".to_owned())
    }

    pub fn write_job_stdin(&self, id: &str, input: &[u8]) -> Result<ManagedJobView, String> {
        if input.len() > 64 * 1024 {
            return Err("background job stdin exceeds the 64 KiB limit".into());
        }
        let child = {
            let jobs = self.jobs.lock().map_err(lock_error)?;
            let job = jobs
                .get(id)
                .ok_or_else(|| "background job missing".to_owned())?;
            if job.view.status.terminal() {
                return Err("background job is already terminal".into());
            }
            job.child
                .clone()
                .ok_or_else(|| "background job process is unavailable".to_owned())?
        };
        let mut child = child.lock().map_err(lock_error)?;
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| "background job stdin is unavailable".to_owned())?;
        stdin
            .write_all(input)
            .and_then(|_| stdin.flush())
            .map_err(|error| format!("write background job stdin: {error}"))?;
        drop(child);
        self.job(id)
    }

    /// Cancels every process group still owned by this service. The shutdown
    /// path uses this instead of relying on child-handle drops, which do not
    /// terminate detached descendants consistently on Windows or Unix.
    pub fn cancel_all_jobs(&self) -> Result<usize, String> {
        let ids = self
            .jobs
            .lock()
            .map_err(lock_error)?
            .values()
            .filter(|job| !job.view.status.terminal() && job.child.is_some())
            .map(|job| job.view.id.clone())
            .collect::<Vec<_>>();
        let mut cancelled = 0;
        let mut first_error = None;
        for id in ids {
            match self.cancel_job(&id) {
                Ok(_) => cancelled += 1,
                Err(error) if error.contains("already terminal") => {}
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }
        match first_error {
            Some(error) => Err(format!(
                "cancelled {cancelled} owned process groups; first failure: {error}"
            )),
            None => Ok(cancelled),
        }
    }

    pub fn wait_job(&self, id: &str, timeout: Duration) -> Result<ManagedJobView, String> {
        let started = Instant::now();
        loop {
            let job = self
                .jobs
                .lock()
                .map_err(lock_error)?
                .get(id)
                .map(|job| (job.view.clone(), job.durable))
                .ok_or_else(|| "background job missing".to_owned())?;
            if job.0.status.terminal() && job.1 {
                return Ok(job.0);
            }
            if started.elapsed() >= timeout {
                return Err("wait for background job timed out".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    pub fn snapshot(&self) -> OrchestrationSnapshot {
        let jobs = self
            .jobs
            .lock()
            .map(|jobs| jobs.values().map(|job| job.view.clone()).collect())
            .unwrap_or_default();
        let graphs = self
            .graphs
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default();
        let routing_decisions = self
            .routing_decisions
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default();
        let worktrees = self
            .worktrees
            .lock()
            .map(|value| value.values().cloned().collect())
            .unwrap_or_default();
        let subagent_policy = self
            .subagent_policy
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default();
        OrchestrationSnapshot {
            jobs,
            graphs,
            routing_decisions,
            worktrees,
            subagent_policy,
        }
    }

    pub fn set_subagent_policy(
        &self,
        policy: SubagentPolicyConfiguration,
    ) -> Result<SubagentPolicyConfiguration, String> {
        if policy.candidates.len() > 32 || policy.qualified_classes.len() > 32 {
            return Err("Subagent policy exceeds the 32-item limit".into());
        }
        if policy.candidates.iter().any(|candidate| {
            candidate.id.split_once('/').is_none()
                || candidate.capability > 10
                || candidate.quality > 10
                || candidate.cost_rank > 10
        }) {
            return Err(
                "Subagent model candidates require provider/model and scores from 0 to 10".into(),
            );
        }
        let unique_models: std::collections::BTreeSet<_> = policy
            .candidates
            .iter()
            .map(|candidate| candidate.id.as_str())
            .collect();
        let unique_classes: std::collections::BTreeSet<_> = policy
            .qualified_classes
            .iter()
            .map(String::as_str)
            .collect();
        if unique_models.len() != policy.candidates.len()
            || unique_classes.len() != policy.qualified_classes.len()
            || policy
                .qualified_classes
                .iter()
                .any(|class| class.trim().is_empty())
        {
            return Err("Subagent policy contains duplicate or empty entries".into());
        }
        *self.subagent_policy.lock().map_err(lock_error)? = policy.clone();
        self.persist()?;
        Ok(policy)
    }

    pub fn configured_subagent_policy(&self) -> SubagentPolicyConfiguration {
        self.subagent_policy
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default()
    }

    pub fn route_configured_subagent(
        &self,
        task_id: &str,
        parent_run_id: &str,
        work: &DelegatedWork,
    ) -> Result<RoutingDecision, String> {
        let configured = self.configured_subagent_policy();
        if !configured.enabled {
            return Err("Subagent delegation is disabled by the user".into());
        }
        if !configured
            .qualified_classes
            .iter()
            .any(|class| class == &work.class)
        {
            return Err("work class has not been qualified by the user policy".into());
        }
        let request = DelegationRequest {
            task_id: task_id.into(),
            parent_run_id: parent_run_id.into(),
            work: work.clone(),
            policy: SubagentModelPolicy {
                candidates: configured.candidates.clone(),
                fallback: configured.fallback,
            },
            qualified_models: configured
                .candidates
                .iter()
                .filter(|candidate| candidate.healthy)
                .map(|candidate| candidate.id.clone())
                .collect(),
        };
        self.route_subagent(&request)
    }

    pub fn save_graph(&self, graph: &TaskGraph) -> Result<(), String> {
        if graph.task_id.trim().is_empty() {
            return Err("task graph requires a task id".into());
        }
        self.graphs
            .lock()
            .map_err(lock_error)?
            .insert(graph.task_id.clone(), graph.clone());
        self.persist()
    }

    pub fn checkpoint(
        &self,
        task_id: &str,
        goal: &str,
        constraints: &[&str],
        workspace_facts: BTreeMap<String, String>,
        known_secret_values: &[String],
    ) -> Result<CheckpointPackage, String> {
        let graph = self
            .graphs
            .lock()
            .map_err(lock_error)?
            .get(task_id)
            .cloned()
            .ok_or_else(|| "task graph missing".to_owned())?;
        let checkpoint = CheckpointPackage::build(
            goal,
            constraints,
            &graph,
            workspace_facts,
            known_secret_values,
        )?;
        let path = self.root.join(format!("checkpoint-{task_id}.json"));
        atomic_json(&path, &checkpoint)?;
        Ok(checkpoint)
    }

    pub fn route_subagent(&self, request: &DelegationRequest) -> Result<RoutingDecision, String> {
        if request.task_id.trim().is_empty() || request.parent_run_id.trim().is_empty() {
            return Err("Subagent task and parent Agent Run are required".into());
        }
        let evaluations =
            RoutingEvaluations::from_qualified(&request.work.class, &request.qualified_models);
        let decision = route_delegation(&request.work, &request.policy, &evaluations)?;
        let record = RoutingDecisionRecord {
            id: Uuid::new_v4().to_string(),
            task_id: request.task_id.clone(),
            parent_run_id: request.parent_run_id.clone(),
            class: request.work.class.clone(),
            decision: decision.clone(),
            recorded_at: unix_millis(),
        };
        self.routing_decisions
            .lock()
            .map_err(lock_error)?
            .push(record);
        self.persist()?;
        Ok(decision)
    }

    pub fn git_snapshot(&self, workspace: &Path) -> Result<GitSnapshot, String> {
        let workspace = workspace
            .canonicalize()
            .map_err(|error| format!("resolve Git workspace: {error}"))?;
        let root_text = run_git(&workspace, &["rev-parse", "--show-toplevel"])?;
        let repository_root = PathBuf::from(root_text.trim())
            .canonicalize()
            .map_err(|error| format!("resolve Git repository root: {error}"))?;
        let head = run_git(&repository_root, &["rev-parse", "HEAD"])?
            .trim()
            .to_owned();
        let branch_text = run_git(&repository_root, &["branch", "--show-current"])?;
        let branch = (!branch_text.trim().is_empty()).then(|| branch_text.trim().to_owned());
        let status_porcelain_v2 = run_git(
            &repository_root,
            &[
                "status",
                "--porcelain=v2",
                "--branch",
                "--untracked-files=all",
            ],
        )?;
        let dirty = status_porcelain_v2
            .lines()
            .any(|line| !line.starts_with('#') && !line.trim().is_empty());
        Ok(GitSnapshot {
            repository_root,
            head,
            branch,
            status_porcelain_v2,
            dirty,
        })
    }

    pub fn preview_rewind(
        &self,
        workspace: &Path,
        target_ref: &str,
    ) -> Result<GitRewindPreview, String> {
        if target_ref.trim().is_empty() || target_ref.starts_with('-') {
            return Err("Git rewind target is required".to_owned());
        }
        let snapshot = self.git_snapshot(workspace)?;
        let verify = format!("{}^{{commit}}", target_ref.trim());
        let target_commit = run_git(
            &snapshot.repository_root,
            &["rev-parse", "--verify", &verify],
        )?
        .trim()
        .to_owned();
        let changed_paths = run_git(
            &snapshot.repository_root,
            &["diff", "--name-status", &target_commit, &snapshot.head],
        )?;
        let has_untracked = snapshot
            .status_porcelain_v2
            .lines()
            .any(|line| line.starts_with("? "));
        let state_fingerprint = git_state_fingerprint(&snapshot);
        Ok(GitRewindPreview {
            repository_root: snapshot.repository_root,
            current_head: snapshot.head,
            target_commit: target_commit.clone(),
            dirty: snapshot.dirty,
            has_untracked,
            changed_paths: changed_paths.chars().take(128 * 1024).collect(),
            state_fingerprint,
            confirmation: format!("REWIND {}", &target_commit[..12.min(target_commit.len())]),
        })
    }

    /// Restores tracked tree/index content from the selected commit without
    /// moving HEAD or deleting untracked files. The reversal stays visible as
    /// an ordinary reviewable Git change.
    pub fn apply_rewind(
        &self,
        preview: &GitRewindPreview,
        confirmation: &str,
    ) -> Result<GitSnapshot, String> {
        if confirmation != preview.confirmation {
            return Err("Git rewind confirmation does not match the preview".to_owned());
        }
        let current = self.preview_rewind(&preview.repository_root, &preview.target_commit)?;
        if current.state_fingerprint != preview.state_fingerprint
            || current.current_head != preview.current_head
            || current.dirty
            || current.has_untracked
        {
            return Err(
                "Git workspace changed since preview or is dirty; user changes are protected"
                    .to_owned(),
            );
        }
        run_git(
            &current.repository_root,
            &[
                "restore",
                "--source",
                &current.target_commit,
                "--staged",
                "--worktree",
                "--",
                ".",
            ],
        )?;
        self.git_snapshot(&current.repository_root)
    }

    pub fn create_handoff(&self, request: HandoffRequest) -> Result<HandoffPackageV2, String> {
        if request.task_id.is_empty()
            || request.task_id.len() > 128
            || !request
                .task_id
                .bytes()
                .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_'))
        {
            return Err("Handoff task id contains unsafe characters".to_owned());
        }
        validate_handoff_text(&request.summary, "summary", 64 * 1024)?;
        validate_handoff_text(&request.recovery, "recovery", 64 * 1024)?;
        for (label, values) in [
            ("tests", &request.tests),
            ("red probes", &request.red_probes),
            ("evidence", &request.evidence_refs),
            ("unresolved", &request.unresolved),
        ] {
            if values.len() > 256 {
                return Err(format!("Handoff {label} exceeds 256 entries"));
            }
            for value in values {
                validate_handoff_text(value, label, 8 * 1024)?;
            }
        }
        let git = self.git_snapshot(&request.workspace)?;
        let diff_stat = run_git(&git.repository_root, &["diff", "--stat", "HEAD"])?;
        let package_path = self.root.join(format!(
            "handoff-{}-{}.json",
            request.task_id,
            unix_millis()
        ));
        let package = HandoffPackageV2 {
            schema_version: 2,
            task_id: request.task_id,
            authority: "local_developer".to_owned(),
            created_at: unix_millis(),
            git,
            diff_stat: diff_stat.chars().take(128 * 1024).collect(),
            summary: request.summary,
            tests: request.tests,
            red_probes: request.red_probes,
            evidence_refs: request.evidence_refs,
            unresolved: request.unresolved,
            recovery: request.recovery,
            package_path,
        };
        atomic_json(&package.package_path, &package)?;
        Ok(package)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_safe_worktree(
        &self,
        task_id: &str,
        workspace: &Path,
        base_ref: &str,
        branch: &str,
        target: &Path,
        explicitly_authorized: bool,
    ) -> Result<GitWorktreeRecord, String> {
        if !explicitly_authorized {
            return Err("Safe Worktree creation requires explicit authorization".into());
        }
        if task_id.trim().is_empty()
            || base_ref.trim().is_empty()
            || !valid_task_branch(branch)
            || !branch.starts_with("picode/")
        {
            return Err(
                "Safe Worktree requires task, exact base ref, and a picode/* branch".into(),
            );
        }
        if target.exists() {
            return Err("Safe Worktree target already exists".into());
        }
        let snapshot = self.git_snapshot(workspace)?;
        let verify = format!("{}^{{commit}}", base_ref.trim());
        let base_commit = run_git(
            &snapshot.repository_root,
            &["rev-parse", "--verify", &verify],
        )?
        .trim()
        .to_owned();
        if base_commit.len() < 40 {
            return Err("Git base ref did not resolve to an exact commit".into());
        }
        if self
            .worktrees
            .lock()
            .map_err(lock_error)?
            .values()
            .any(|worktree| {
                worktree.branch == branch || same_physical_or_lexical(&worktree.path, target)
            })
        {
            return Err("Safe Worktree branch or path is already managed".into());
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create Safe Worktree parent: {error}"))?;
        }
        let target_text = target.to_string_lossy().into_owned();
        run_git(
            &snapshot.repository_root,
            &["worktree", "add", "-b", branch, &target_text, &base_commit],
        )?;
        let record = GitWorktreeRecord {
            id: Uuid::new_v4().to_string(),
            task_id: task_id.to_owned(),
            repository_root: snapshot.repository_root,
            base_commit,
            branch: branch.to_owned(),
            path: target
                .canonicalize()
                .map_err(|error| format!("resolve created Safe Worktree: {error}"))?,
            status: GitWorktreeStatus::Active,
            created_at: unix_millis(),
        };
        self.worktrees
            .lock()
            .map_err(lock_error)?
            .insert(record.id.clone(), record.clone());
        self.persist()?;
        Ok(record)
    }

    pub fn review_worktree(&self, id: &str) -> Result<String, String> {
        let worktree = self
            .worktrees
            .lock()
            .map_err(lock_error)?
            .get(id)
            .cloned()
            .ok_or_else(|| "Safe Worktree is not managed".to_owned())?;
        let status = run_git(&worktree.path, &["status", "--short", "--branch"])?;
        let range = format!("{}...HEAD", worktree.base_commit);
        let diff = run_git(&worktree.path, &["diff", "--stat", &range])?;
        let review = format!(
            "branch: {}\nbase: {}\n{}\n{}",
            worktree.branch, worktree.base_commit, status, diff
        );
        Ok(review.chars().take(64 * 1024).collect())
    }

    pub fn delegation_workspace(
        &self,
        task_id: &str,
        requires_write: bool,
        worktree_id: Option<&str>,
        shared_workspace: &Path,
    ) -> Result<PathBuf, String> {
        if let Some(worktree_id) = worktree_id {
            let worktree = self
                .worktrees
                .lock()
                .map_err(lock_error)?
                .get(worktree_id)
                .cloned()
                .ok_or_else(|| "Safe Worktree is not managed".to_owned())?;
            if worktree.task_id != task_id || worktree.status != GitWorktreeStatus::Active {
                return Err("Safe Worktree does not belong to the active task".to_owned());
            }
            return worktree
                .path
                .canonicalize()
                .map_err(|error| format!("resolve Safe Worktree: {error}"));
        }
        if requires_write {
            return Err(
                "Write-capable Subagent requires an explicitly authorized Safe Worktree".into(),
            );
        }
        shared_workspace
            .canonicalize()
            .map_err(|error| format!("resolve shared delegation workspace: {error}"))
    }

    fn persist(&self) -> Result<(), String> {
        persist_shared(
            &self.root,
            &self.jobs,
            &self.graphs,
            &self.routing_decisions,
            &self.worktrees,
            &self.subagent_policy,
            &self.persistence,
        )
    }
}

fn spawn_output_reader<R: Read + Send + 'static>(
    mut reader: R,
    jobs: Arc<Mutex<BTreeMap<String, RuntimeJob>>>,
    persistence: Arc<Mutex<()>>,
    root: PathBuf,
    tail_bytes: usize,
    job_id: &str,
) -> std::thread::JoinHandle<()> {
    let job_id = job_id.to_owned();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8 * 1024];
        loop {
            let count = match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => count,
            };
            if let Ok(mut jobs) = jobs.lock() {
                if let Some(job) = jobs.get_mut(&job_id) {
                    if let Ok(mut artifact) = OpenOptions::new()
                        .append(true)
                        .open(&job.view.artifact_path)
                    {
                        let _ = artifact.write_all(&buffer[..count]);
                        let _ = artifact.flush();
                    }
                    job.hasher.update(&buffer[..count]);
                    job.view.full_output_hash = format!("{:x}", job.hasher.clone().finalize());
                    job.view.live_tail.extend_from_slice(&buffer[..count]);
                    if job.view.live_tail.len() > tail_bytes {
                        let overflow = job.view.live_tail.len() - tail_bytes;
                        job.view.live_tail.drain(..overflow);
                    }
                }
            }
        }
        let _ = persist_jobs_only(&root, &jobs, &persistence);
    })
}

// The monitor receives the exact owned process plus every durable store it
// must reconcile; keeping those dependencies explicit prevents hidden globals.
#[allow(clippy::too_many_arguments)]
fn spawn_job_monitor(
    child: Arc<Mutex<Child>>,
    process_owner: Arc<ProcessOwner>,
    jobs: Arc<Mutex<BTreeMap<String, RuntimeJob>>>,
    graphs: Arc<Mutex<BTreeMap<String, TaskGraph>>>,
    decisions: Arc<Mutex<Vec<RoutingDecisionRecord>>>,
    worktrees: Arc<Mutex<BTreeMap<String, GitWorktreeRecord>>>,
    subagent_policy: Arc<Mutex<SubagentPolicyConfiguration>>,
    persistence: Arc<Mutex<()>>,
    root: PathBuf,
    job_id: String,
    timeout: Duration,
    output_readers: Vec<std::thread::JoinHandle<()>>,
) {
    std::thread::spawn(move || {
        let started = Instant::now();
        loop {
            let status = child
                .lock()
                .ok()
                .and_then(|mut child| child.try_wait().ok())
                .flatten();
            if let Some(status) = status {
                if let Ok(mut jobs) = jobs.lock() {
                    if let Some(job) = jobs.get_mut(&job_id) {
                        if job.view.status == ManagedJobStatus::Running {
                            job.view.status = if status.success() {
                                ManagedJobStatus::Completed
                            } else {
                                ManagedJobStatus::Failed
                            };
                            job.view.exit_code = status.code();
                            job.view.termination_result =
                                Some(format!("process exited with {status}"));
                        }
                        job.child = None;
                        job.process_owner = None;
                        job.durable = false;
                    }
                }
                break;
            }
            if started.elapsed() >= timeout {
                let termination = terminate_process_tree(&child, &process_owner);
                if let Ok(mut jobs) = jobs.lock() {
                    if let Some(job) = jobs.get_mut(&job_id) {
                        if job.view.status == ManagedJobStatus::Running {
                            match termination {
                                Ok(()) => {
                                    job.view.status = ManagedJobStatus::TimedOut;
                                    job.view.termination_result = Some(
                                        "background job timed out; owned process tree exit confirmed"
                                            .into(),
                                    );
                                }
                                Err(error) => {
                                    job.view.status = ManagedJobStatus::TerminationUnknown;
                                    job.view.termination_result = Some(error);
                                }
                            }
                        }
                        job.child = None;
                        job.process_owner = None;
                        job.durable = false;
                    }
                }
                break;
            }
            std::thread::sleep(Duration::from_millis(40));
        }
        for reader in output_readers {
            let _ = reader.join();
        }
        let persisted = persist_shared(
            &root,
            &jobs,
            &graphs,
            &decisions,
            &worktrees,
            &subagent_policy,
            &persistence,
        );
        if persisted.is_ok() {
            if let Ok(mut jobs) = jobs.lock() {
                if let Some(job) = jobs.get_mut(&job_id) {
                    job.durable = true;
                }
            }
        }
    });
}

fn terminate_process_tree(
    child: &Arc<Mutex<Child>>,
    process_owner: &Arc<ProcessOwner>,
) -> Result<(), String> {
    let mut child = child.lock().map_err(lock_error)?;
    let process_id = child.id();
    #[cfg(target_os = "windows")]
    let tree_signal_succeeded = process_owner.terminate().is_ok();
    #[cfg(not(target_os = "windows"))]
    let tree_signal_succeeded = {
        let status = Command::new("kill")
            .args(["-TERM", &format!("-{process_id}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        status.as_ref().is_ok_and(|status| status.success())
    };
    if !tree_signal_succeeded {
        child
            .kill()
            .map_err(|error| format!("terminate background process: {error}"))?;
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                return Err(format!(
                    "termination_unknown: process {process_id} did not confirm exit"
                ));
            }
            Err(error) => {
                return Err(format!(
                    "termination_unknown: cannot inspect process {process_id}: {error}"
                ));
            }
        }
    }
}

fn configure_process_group(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }
}

fn persist_jobs_only(
    root: &Path,
    jobs: &Arc<Mutex<BTreeMap<String, RuntimeJob>>>,
    persistence: &Arc<Mutex<()>>,
) -> Result<(), String> {
    let _persistence = persistence.lock().map_err(lock_error)?;
    let path = root.join("state.json");
    let mut state = if path.exists() {
        serde_json::from_slice::<PersistedState>(
            &fs::read(&path).map_err(|error| format!("read orchestration state: {error}"))?,
        )
        .map_err(|error| format!("invalid orchestration state: {error}"))?
    } else {
        PersistedState {
            schema_version: 1,
            ..Default::default()
        }
    };
    state.jobs = jobs
        .lock()
        .map_err(lock_error)?
        .values()
        .map(|job| job.view.clone())
        .collect();
    atomic_json(&path, &state)
}

fn persist_shared(
    root: &Path,
    jobs: &Arc<Mutex<BTreeMap<String, RuntimeJob>>>,
    graphs: &Arc<Mutex<BTreeMap<String, TaskGraph>>>,
    decisions: &Arc<Mutex<Vec<RoutingDecisionRecord>>>,
    worktrees: &Arc<Mutex<BTreeMap<String, GitWorktreeRecord>>>,
    subagent_policy: &Arc<Mutex<SubagentPolicyConfiguration>>,
    persistence: &Arc<Mutex<()>>,
) -> Result<(), String> {
    let _persistence = persistence.lock().map_err(lock_error)?;
    let state = PersistedState {
        schema_version: 1,
        jobs: jobs
            .lock()
            .map_err(lock_error)?
            .values()
            .map(|job| job.view.clone())
            .collect(),
        graphs: graphs.lock().map_err(lock_error)?.clone(),
        routing_decisions: decisions.lock().map_err(lock_error)?.clone(),
        worktrees: worktrees
            .lock()
            .map_err(lock_error)?
            .values()
            .cloned()
            .collect(),
        subagent_policy: subagent_policy.lock().map_err(lock_error)?.clone(),
    };
    atomic_json(&root.join("state.json"), &state)
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("start Git: {error}"))?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Git command failed: {}", error.trim()));
    }
    if output.stdout.len() > 1024 * 1024 || output.stderr.len() > 64 * 1024 {
        return Err("Git output exceeds configured limit".into());
    }
    String::from_utf8(output.stdout).map_err(|_| "Git output is not UTF-8".to_owned())
}

fn git_state_fingerprint(snapshot: &GitSnapshot) -> String {
    let mut hasher = Sha256::new();
    hasher.update(snapshot.repository_root.to_string_lossy().as_bytes());
    hasher.update([0]);
    hasher.update(snapshot.head.as_bytes());
    hasher.update([0]);
    hasher.update(snapshot.status_porcelain_v2.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn validate_handoff_text(value: &str, label: &str, limit: usize) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > limit {
        return Err(format!("Handoff {label} must contain 1 to {limit} bytes"));
    }
    Ok(())
}

fn valid_task_branch(branch: &str) -> bool {
    !branch.is_empty()
        && !branch.starts_with('-')
        && !branch.contains("..")
        && !branch.contains("//")
        && branch
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "/._-".contains(character))
}

fn same_physical_or_lexical(left: &Path, right: &Path) -> bool {
    let left = left.canonicalize().unwrap_or_else(|_| left.to_owned());
    let right = right.canonicalize().unwrap_or_else(|_| right.to_owned());
    #[cfg(target_os = "windows")]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(target_os = "windows"))]
    {
        left == right
    }
}

fn atomic_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("serialize orchestration state: {error}"))?;
    let store = SafeFileStore;
    if path.exists() {
        let current = store.read(path)?;
        store.write_atomic(path, &current.version, &bytes)?;
    } else {
        store.create_atomic(path, &bytes)?;
    }
    Ok(())
}

fn hash_existing_artifact(path: &Path) -> Sha256 {
    let mut hasher = Sha256::new();
    if let Ok(bytes) = fs::read(path) {
        hasher.update(bytes);
    }
    hasher
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn lock_error<T>(_error: std::sync::PoisonError<T>) -> String {
    "Orchestration Service lock is poisoned".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;

    #[test]
    #[ignore]
    fn background_job_child_fixture() {
        print!("abcdefghijklmnopqrstuvwxyz");
    }

    #[test]
    #[ignore]
    fn long_running_job_child_fixture() {
        std::thread::sleep(Duration::from_secs(30));
    }

    #[test]
    fn application_shutdown_cancels_every_owned_process_group() {
        let root = std::env::temp_dir().join(format!("picode-shutdown-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let service = OrchestrationService::open(&root, 1024).unwrap();
        let executable = std::env::current_exe().unwrap();
        for run_id in ["run-a", "run-b"] {
            service
                .start_job(
                    "task-a",
                    run_id,
                    &executable,
                    &[
                        "--ignored".into(),
                        "--exact".into(),
                        "orchestration_service::tests::long_running_job_child_fixture".into(),
                        "--nocapture".into(),
                    ],
                    &root,
                    Duration::from_secs(60),
                )
                .unwrap();
        }
        assert_eq!(service.cancel_all_jobs().unwrap(), 2);
        assert!(service
            .snapshot()
            .jobs
            .iter()
            .all(|job| job.status.terminal()));
    }

    #[test]
    fn cancel_only_reports_success_after_the_owned_process_has_exited() {
        let root = std::env::temp_dir().join(format!("picode-cancel-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let service = OrchestrationService::open(&root, 1024).unwrap();
        let executable = std::env::current_exe().unwrap();
        let job = service
            .start_job(
                "task-a",
                "run-a",
                &executable,
                &[
                    "--ignored".into(),
                    "--exact".into(),
                    "orchestration_service::tests::long_running_job_child_fixture".into(),
                    "--nocapture".into(),
                ],
                &root,
                Duration::from_secs(60),
            )
            .unwrap();

        let cancelled = service.cancel_job(&job.id).unwrap();
        assert_eq!(cancelled.status, ManagedJobStatus::Cancelled);
        assert_eq!(
            cancelled.termination_result.as_deref(),
            Some("owned process tree exit confirmed")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn background_jobs_are_owned_bounded_persisted_and_reconciled() {
        let root = std::env::temp_dir().join(format!("picode-jobs-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let service = OrchestrationService::open(&root, 12).unwrap();
        let exe = std::env::current_exe().unwrap();
        let job = service
            .start_job(
                "task-a",
                "run-a",
                &exe,
                &[
                    "--ignored".into(),
                    "--exact".into(),
                    "orchestration_service::tests::background_job_child_fixture".into(),
                    "--nocapture".into(),
                ],
                &root,
                Duration::from_secs(10),
            )
            .unwrap();
        let terminal = service.wait_job(&job.id, Duration::from_secs(10)).unwrap();
        assert_eq!(terminal.status, ManagedJobStatus::Completed);
        assert_eq!(terminal.live_tail.len(), 12);
        assert!(terminal.artifact_path.is_file());
        assert_eq!(terminal.full_output_hash.len(), 64);

        let reopened = OrchestrationService::open(&root, 12).unwrap();
        assert_eq!(
            reopened.snapshot().jobs[0].status,
            ManagedJobStatus::Completed
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn routing_accepts_bounded_writes_and_records_a_checkpoint() {
        let root = std::env::temp_dir().join(format!("picode-route-{}", uuid::Uuid::new_v4()));
        let service = OrchestrationService::open(&root, 1024).unwrap();
        let request = DelegationRequest::read_only_fixture("task-a", "run-a");
        let decision = service.route_subagent(&request).unwrap();
        assert_eq!(decision.model_id, "capable");

        let mut risky = request;
        risky.work.requires_write = true;
        assert_eq!(service.route_subagent(&risky).unwrap().model_id, "capable");

        let mut graph = TaskGraph::new("task-a");
        graph.add_stage(Stage::new("search", &[], "main")).unwrap();
        service.save_graph(&graph).unwrap();
        let checkpoint = service
            .checkpoint(
                "task-a",
                "ship",
                &["no credential values"],
                Default::default(),
                &["actual-secret".into()],
            )
            .unwrap();
        assert_eq!(checkpoint.graph.ready(), vec!["search"]);
        assert!(!serde_json::to_string(&checkpoint)
            .unwrap()
            .contains("actual-secret"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn write_delegation_cannot_share_the_parent_workspace_without_a_managed_worktree() {
        let root =
            std::env::temp_dir().join(format!("picode-write-isolation-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let service = OrchestrationService::open(&root.join("state"), 1024).unwrap();
        let error = service
            .delegation_workspace("task-a", true, None, &root)
            .unwrap_err();
        assert!(error.contains("Safe Worktree"));
        assert_eq!(
            service
                .delegation_workspace("task-a", false, None, &root)
                .unwrap(),
            root.canonicalize().unwrap()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn user_model_policy_is_durable_and_routes_qualified_bounded_work() {
        let root = std::env::temp_dir().join(format!("picode-policy-{}", uuid::Uuid::new_v4()));
        let service = OrchestrationService::open(&root, 1024).unwrap();
        service
            .set_subagent_policy(SubagentPolicyConfiguration {
                enabled: true,
                candidates: vec![ModelCandidate::new("deepseek/search", 8, 9, 1, true)],
                fallback: ModelFallback::DoNotDelegate,
                qualified_classes: vec!["repository-search".into()],
            })
            .unwrap();
        let fixture = DelegationRequest::read_only_fixture("task-a", "run-a");
        let decision = service
            .route_configured_subagent("task-a", "run-a", &fixture.work)
            .unwrap();
        assert_eq!(decision.model_id, "deepseek/search");
        let mut write = fixture.work.clone();
        write.requires_write = true;
        assert_eq!(
            service
                .route_configured_subagent("task-a", "run-a", &write)
                .unwrap()
                .model_id,
            "deepseek/search"
        );
        drop(service);
        let reopened = OrchestrationService::open(&root, 1024).unwrap();
        assert!(reopened.configured_subagent_policy().enabled);
        assert_eq!(
            reopened.configured_subagent_policy().candidates[0].id,
            "deepseek/search"
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn git_fixture() -> (PathBuf, String, String) {
        let root =
            std::env::temp_dir().join(format!("picode-git-delivery-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        run_git(&root, &["init"]).unwrap();
        run_git(&root, &["config", "user.email", "picode@example.invalid"]).unwrap();
        run_git(&root, &["config", "user.name", "Picode Test"]).unwrap();
        fs::write(root.join("game.txt"), "one\n").unwrap();
        run_git(&root, &["add", "game.txt"]).unwrap();
        run_git(&root, &["commit", "-m", "one"]).unwrap();
        let first = run_git(&root, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_owned();
        fs::write(root.join("game.txt"), "two\n").unwrap();
        run_git(&root, &["add", "game.txt"]).unwrap();
        run_git(&root, &["commit", "-m", "two"]).unwrap();
        let second = run_git(&root, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_owned();
        (root, first, second)
    }

    #[test]
    fn git_rewind_is_previewed_clean_tree_only_and_does_not_rewrite_history() {
        let (workspace, first, second) = git_fixture();
        let state = workspace.join(".git").join("picode-test-state");
        let service = OrchestrationService::open(&state, 1024).unwrap();
        fs::write(workspace.join("user-untracked.txt"), "keep\n").unwrap();
        let dirty = service.preview_rewind(&workspace, &first).unwrap();
        assert!(dirty.has_untracked);
        assert!(service
            .apply_rewind(&dirty, &dirty.confirmation)
            .unwrap_err()
            .contains("changed since preview"));
        fs::remove_file(workspace.join("user-untracked.txt")).unwrap();

        let preview = service.preview_rewind(&workspace, &first).unwrap();
        assert!(!preview.dirty);
        assert!(service.apply_rewind(&preview, "REWIND wrong").is_err());
        let result = service
            .apply_rewind(&preview, &preview.confirmation)
            .unwrap();
        assert_eq!(
            run_git(&workspace, &["rev-parse", "HEAD"]).unwrap().trim(),
            second
        );
        assert_eq!(
            fs::read_to_string(workspace.join("game.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "one\n"
        );
        assert!(result.dirty);
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn handoff_package_references_git_and_evidence_without_copying_project_files() {
        let (workspace, _first, _second) = git_fixture();
        let state = workspace.join(".git").join("picode-test-state");
        let service = OrchestrationService::open(&state, 1024).unwrap();
        let handoff = service
            .create_handoff(HandoffRequest {
                task_id: "task-a".into(),
                workspace: workspace.clone(),
                summary: "Implemented player controller".into(),
                tests: vec!["unit: pass".into()],
                red_probes: vec!["broken fixture: rejected".into()],
                evidence_refs: vec!["sha256:evidence".into()],
                unresolved: vec!["CI pending".into()],
                recovery: "Open the repository and inspect HEAD".into(),
            })
            .unwrap();
        assert_eq!(handoff.git.head.len(), 40);
        assert_eq!(handoff.authority, "local_developer");
        assert!(handoff.package_path.is_file());
        let serialized = fs::read_to_string(&handoff.package_path).unwrap();
        assert!(!serialized.contains("one\\n"));
        assert!(serialized.contains("CI pending"));
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn git_worktrees_start_from_an_exact_ref_and_are_preserved_for_review() {
        let root = std::env::temp_dir().join(format!("picode-git-{}", uuid::Uuid::new_v4()));
        let repo = root.join("repo");
        fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init"]);
        git(&["config", "user.email", "picode@example.invalid"]);
        git(&["config", "user.name", "Picode Test"]);
        fs::write(repo.join("README.md"), "baseline\n").unwrap();
        git(&["add", "README.md"]);
        git(&["commit", "-m", "baseline"]);

        let service = OrchestrationService::open(&root.join("state"), 1024).unwrap();
        let baseline = service.git_snapshot(&repo).unwrap();
        assert!(baseline.head.len() >= 40);
        let target = root.join("worktrees/task-a");
        let worktree = service
            .create_safe_worktree(
                "task-a",
                &repo,
                &baseline.head,
                "picode/task-a",
                &target,
                true,
            )
            .unwrap();
        assert_eq!(worktree.base_commit, baseline.head);
        assert_eq!(worktree.status, GitWorktreeStatus::Active);
        assert!(target.join(".git").is_file());
        assert!(service
            .review_worktree(&worktree.id)
            .unwrap()
            .contains("picode/task-a"));
        assert_eq!(
            service.snapshot().worktrees[0].status,
            GitWorktreeStatus::Active
        );
        fs::remove_dir_all(root).unwrap();
    }
}
