#![cfg_attr(not(test), allow(dead_code))]

use crate::orchestration_service::{ManagedJobStatus, ManagedJobView, OrchestrationService};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkKind {
    Agent,
    Command,
    PersistentShell,
    Server,
    Monitor,
    Subagent,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
    TimedOut,
    Terminated,
    TerminationUnknown,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkHandle {
    pub id: String,
    pub owner_task_id: String,
    pub owner_run_id: String,
    pub parent_work_id: Option<String>,
    pub kind: WorkKind,
    pub status: WorkStatus,
    pub process_id: Option<u32>,
    pub started_at: u64,
    pub bounded_output: Vec<u8>,
    pub output_artifact: Option<String>,
    pub termination_result: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartCommand {
    pub task_id: String,
    pub run_id: String,
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: String,
    pub timeout_ms: u64,
}

pub struct WorkManager {
    commands: Arc<OrchestrationService>,
    external: Mutex<BTreeMap<String, WorkHandle>>,
    external_changed: Condvar,
    external_canceller: Mutex<Option<ExternalCanceller>>,
}

type ExternalCanceller = Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

impl WorkManager {
    pub fn new(commands: Arc<OrchestrationService>) -> Self {
        Self {
            commands,
            external: Mutex::new(BTreeMap::new()),
            external_changed: Condvar::new(),
            external_canceller: Mutex::new(None),
        }
    }

    pub fn set_external_canceller(&self, canceller: ExternalCanceller) -> Result<(), String> {
        *self.external_canceller.lock().map_err(lock_error)? = Some(canceller);
        Ok(())
    }

    pub fn start_command(&self, request: &StartCommand) -> Result<WorkHandle, String> {
        let timeout = Duration::from_millis(request.timeout_ms);
        let view = self.commands.start_job(
            &request.task_id,
            &request.run_id,
            Path::new(&request.executable),
            &request.args,
            Path::new(&request.cwd),
            timeout,
        )?;
        Ok(command_handle(view))
    }

    pub fn status(&self, work_id: &str) -> Result<WorkHandle, String> {
        if let Ok(view) = self.commands.job(work_id) {
            return Ok(command_handle(view));
        }
        self.external
            .lock()
            .map_err(lock_error)?
            .get(work_id)
            .cloned()
            .ok_or_else(|| "work handle missing".to_owned())
    }

    pub fn wait(&self, work_id: &str, timeout: Duration) -> Result<WorkHandle, String> {
        if self.commands.job(work_id).is_ok() {
            return self.commands.wait_job(work_id, timeout).map(command_handle);
        }
        let deadline = std::time::Instant::now() + timeout;
        let mut external = self.external.lock().map_err(lock_error)?;
        loop {
            let handle = external
                .get(work_id)
                .cloned()
                .ok_or_else(|| "work handle missing".to_owned())?;
            if handle.status != WorkStatus::Running {
                return Ok(handle);
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                return Ok(handle);
            }
            let remaining = deadline.saturating_duration_since(now);
            let (next, _) = self
                .external_changed
                .wait_timeout(external, remaining)
                .map_err(lock_error)?;
            external = next;
        }
    }

    pub fn cancel(&self, work_id: &str) -> Result<WorkHandle, String> {
        if self.commands.job(work_id).is_ok() {
            return self.commands.cancel_job(work_id).map(command_handle);
        }
        let current = self
            .external
            .lock()
            .map_err(lock_error)?
            .get(work_id)
            .cloned()
            .ok_or_else(|| "work handle missing".to_owned())?;
        if current.status != WorkStatus::Running {
            return Err("work handle is already terminal".to_owned());
        }
        let canceller = self
            .external_canceller
            .lock()
            .map_err(lock_error)?
            .clone()
            .ok_or_else(|| "external work owner has no cancellation adapter".to_owned())?;
        canceller(work_id)?;
        let observed = self.wait(work_id, Duration::from_secs(5))?;
        if observed.status != WorkStatus::Running {
            return Ok(observed);
        }
        let mut external = self.external.lock().map_err(lock_error)?;
        let handle = external
            .get_mut(work_id)
            .ok_or_else(|| "work handle missing".to_owned())?;
        handle.status = WorkStatus::TerminationUnknown;
        handle.termination_result = Some(
            "termination_unknown: cancellation was sent but terminal state was not observed"
                .to_owned(),
        );
        let result = handle.clone();
        drop(external);
        self.external_changed.notify_all();
        Ok(result)
    }

    pub fn upsert_external(&self, handle: WorkHandle) -> Result<(), String> {
        if handle.id.trim().is_empty()
            || handle.owner_task_id.trim().is_empty()
            || handle.owner_run_id.trim().is_empty()
            || handle.kind == WorkKind::Command
        {
            return Err("external work identity and non-command kind are required".to_owned());
        }
        self.external
            .lock()
            .map_err(lock_error)?
            .insert(handle.id.clone(), handle);
        self.external_changed.notify_all();
        Ok(())
    }

    pub fn snapshot(&self) -> Result<Vec<WorkHandle>, String> {
        let mut handles = self
            .commands
            .snapshot()
            .jobs
            .into_iter()
            .map(command_handle)
            .collect::<Vec<_>>();
        handles.extend(self.external.lock().map_err(lock_error)?.values().cloned());
        handles.sort_by_key(|handle| handle.started_at);
        Ok(handles)
    }
}

fn command_handle(view: ManagedJobView) -> WorkHandle {
    WorkHandle {
        id: view.id,
        owner_task_id: view.task_id,
        owner_run_id: view.agent_run_id,
        parent_work_id: None,
        kind: WorkKind::Command,
        status: match view.status {
            ManagedJobStatus::Running => WorkStatus::Running,
            ManagedJobStatus::Completed => WorkStatus::Completed,
            ManagedJobStatus::Failed => WorkStatus::Failed,
            ManagedJobStatus::Cancelled => WorkStatus::Cancelled,
            ManagedJobStatus::TimedOut => WorkStatus::TimedOut,
            ManagedJobStatus::Terminated => WorkStatus::Terminated,
            ManagedJobStatus::TerminationUnknown => WorkStatus::TerminationUnknown,
        },
        process_id: Some(view.process_id),
        started_at: view.started_at,
        bounded_output: view.live_tail,
        output_artifact: Some(view.artifact_path.to_string_lossy().into_owned()),
        termination_result: view.termination_result,
    }
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    "work manager state unavailable".to_owned()
}

#[cfg(test)]
mod tests {
    use super::{StartCommand, WorkHandle, WorkKind, WorkManager, WorkStatus};
    use crate::orchestration_service::OrchestrationService;
    use std::fs;
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    #[ignore]
    fn command_fixture() {
        print!("work-manager-output");
    }

    #[test]
    fn caller_uses_one_handle_for_start_wait_output_and_owner_lookup() {
        let root =
            std::env::temp_dir().join(format!("picode-work-manager-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let service = Arc::new(OrchestrationService::open(&root, 10).unwrap());
        let manager = WorkManager::new(service);
        let executable = std::env::current_exe().unwrap();
        let work = manager
            .start_command(&StartCommand {
                task_id: "task-a".into(),
                run_id: "run-a".into(),
                executable: executable.to_string_lossy().into_owned(),
                args: vec![
                    "--ignored".into(),
                    "--exact".into(),
                    "work_manager::tests::command_fixture".into(),
                    "--nocapture".into(),
                ],
                cwd: root.to_string_lossy().into_owned(),
                timeout_ms: 10_000,
            })
            .unwrap();
        assert_eq!(work.kind, WorkKind::Command);
        assert_eq!(work.owner_task_id, "task-a");

        let finished = manager.wait(&work.id, Duration::from_secs(10)).unwrap();
        assert_eq!(finished.status, WorkStatus::Completed);
        assert_eq!(finished.bounded_output.len(), 10);
        let artifact = fs::read_to_string(finished.output_artifact.as_ref().unwrap()).unwrap();
        assert!(artifact.contains("work-manager-output"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn external_wait_observes_owner_updates_and_cancel_uses_the_owner_adapter() {
        let root =
            std::env::temp_dir().join(format!("picode-work-external-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let service = Arc::new(OrchestrationService::open(&root, 1024).unwrap());
        let manager = Arc::new(WorkManager::new(service));
        manager
            .upsert_external(WorkHandle {
                id: "agent-a".into(),
                owner_task_id: "task-a".into(),
                owner_run_id: "agent-a".into(),
                parent_work_id: None,
                kind: WorkKind::Agent,
                status: WorkStatus::Running,
                process_id: Some(42),
                started_at: 1,
                bounded_output: Vec::new(),
                output_artifact: None,
                termination_result: None,
            })
            .unwrap();
        let owner = manager.clone();
        manager
            .set_external_canceller(Arc::new(move |id| {
                let mut terminal = owner.status(id)?;
                terminal.status = WorkStatus::Cancelled;
                terminal.termination_result = Some("owner confirmed cancellation".into());
                owner.upsert_external(terminal)
            }))
            .unwrap();

        let cancelled = manager.cancel("agent-a").unwrap();
        assert_eq!(cancelled.status, WorkStatus::Cancelled);
        assert_eq!(
            manager
                .wait("agent-a", Duration::from_millis(10))
                .unwrap()
                .status,
            WorkStatus::Cancelled
        );
        fs::remove_dir_all(root).unwrap();
    }
}
