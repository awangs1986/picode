#![cfg_attr(not(test), allow(dead_code))]

use crate::orchestration_service::{ManagedJobStatus, ManagedJobView, OrchestrationService};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
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
}

impl WorkManager {
    pub fn new(commands: Arc<OrchestrationService>) -> Self {
        Self {
            commands,
            external: Mutex::new(BTreeMap::new()),
        }
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
        self.status(work_id)
    }

    pub fn cancel(&self, work_id: &str) -> Result<WorkHandle, String> {
        if self.commands.job(work_id).is_ok() {
            return self.commands.cancel_job(work_id).map(command_handle);
        }
        let mut external = self.external.lock().map_err(lock_error)?;
        let handle = external
            .get_mut(work_id)
            .ok_or_else(|| "work handle missing".to_owned())?;
        if handle.status != WorkStatus::Running {
            return Err("work handle is already terminal".to_owned());
        }
        handle.status = WorkStatus::TerminationUnknown;
        handle.termination_result =
            Some("termination_unknown: external owner must confirm exit".to_owned());
        Ok(handle.clone())
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
    use super::{StartCommand, WorkKind, WorkManager, WorkStatus};
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
}
