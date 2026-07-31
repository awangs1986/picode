#![cfg_attr(not(test), allow(dead_code))]

use crate::execution::TaskRun;
use crate::session_kernel::{SessionDescriptor, SessionEvent, SessionKernel, SessionKind};
use crate::task_control::TaskControl;
use serde_json::json;
use std::path::Path;
use std::sync::{Arc, Mutex};

pub enum TaskTarget<'a> {
    Simple { scratch_root: &'a Path },
    Harness { workspace_id: &'a str },
}

pub struct CreateTask<'a> {
    pub chat_id: &'a str,
    pub goal: &'a str,
    pub target: TaskTarget<'a>,
    pub now: u64,
}

pub struct AccountSelection<'a> {
    pub provider: &'a str,
    pub account_id: &'a str,
    pub channel: &'a str,
    pub model: &'a str,
}

pub enum TaskTransition<'a> {
    Start(AccountSelection<'a>),
    Continue {
        command: &'a str,
        account: AccountSelection<'a>,
    },
}

pub struct TaskExperienceService {
    control: Arc<Mutex<TaskControl>>,
    sessions: Arc<Mutex<SessionKernel>>,
}

impl TaskExperienceService {
    pub fn new(control: Arc<Mutex<TaskControl>>, sessions: Arc<Mutex<SessionKernel>>) -> Self {
        Self { control, sessions }
    }

    pub fn create(&self, request: &CreateTask<'_>) -> Result<TaskRun, String> {
        let (kind, workspace_id) = match request.target {
            TaskTarget::Simple { .. } => (SessionKind::Simple, None),
            TaskTarget::Harness { workspace_id } => (SessionKind::Harness, Some(workspace_id)),
        };
        let created_session = self.ensure_session(
            request.chat_id,
            request.goal,
            kind,
            workspace_id,
            request.now,
        )?;
        let task_result = {
            let mut control = self
                .control
                .lock()
                .map_err(|_| "Task Control lock is poisoned".to_owned())?;
            match request.target {
                TaskTarget::Simple { scratch_root } => {
                    control.create_simple(request.chat_id, request.goal, scratch_root)
                }
                TaskTarget::Harness { workspace_id } => {
                    control.create_harness(request.chat_id, request.goal, workspace_id)
                }
            }
        };
        let task = match task_result {
            Ok(task) => task,
            Err(error) => {
                return Err(self.rollback_creation(
                    request.chat_id,
                    created_session,
                    request.now,
                    error,
                ));
            }
        };
        let task_kind = match request.target {
            TaskTarget::Simple { .. } => "simple",
            TaskTarget::Harness { .. } => "harness",
        };
        self.sessions
            .lock()
            .map_err(|_| "Session Kernel lock is poisoned".to_owned())?
            .append(
                request.chat_id,
                SessionEvent {
                    sequence: 0,
                    event_id: format!("task:{}:created", task.id),
                    event_type: "task_created".into(),
                    at: request.now,
                    payload: json!({
                        "taskId": task.id,
                        "taskKind": task_kind,
                        "workspaceId": workspace_id,
                    }),
                },
            )?;
        Ok(task)
    }

    pub fn transition(
        &self,
        task_id: &str,
        transition: &TaskTransition<'_>,
        now: u64,
    ) -> Result<(), String> {
        let chat_id = {
            let mut control = self
                .control
                .lock()
                .map_err(|_| "Task Control lock is poisoned".to_owned())?;
            let chat_id = control.task_chat_id(task_id)?;
            match transition {
                TaskTransition::Start(account) => control.start_task(
                    task_id,
                    account.provider,
                    account.account_id,
                    account.channel,
                    account.model,
                )?,
                TaskTransition::Continue { command, account } => control.continue_task(
                    task_id,
                    command,
                    account.provider,
                    account.account_id,
                    account.channel,
                    account.model,
                )?,
            }
            chat_id
        };
        let (event_type, account) = match transition {
            TaskTransition::Start(account) => ("task_started", account),
            TaskTransition::Continue { account, .. } => ("task_continued", account),
        };
        self.append_task_event(
            &chat_id,
            task_id,
            event_type,
            now,
            json!({
                "provider": account.provider,
                "accountId": account.account_id,
                "channel": account.channel,
                "model": account.model,
            }),
        )
    }

    fn append_task_event(
        &self,
        chat_id: &str,
        task_id: &str,
        event_type: &str,
        now: u64,
        details: serde_json::Value,
    ) -> Result<(), String> {
        self.sessions
            .lock()
            .map_err(|_| "Session Kernel lock is poisoned".to_owned())?
            .append(
                chat_id,
                SessionEvent {
                    sequence: 0,
                    event_id: format!("task:{task_id}:{event_type}:{now}"),
                    event_type: event_type.into(),
                    at: now,
                    payload: json!({ "taskId": task_id, "details": details }),
                },
            )?;
        Ok(())
    }

    fn ensure_session(
        &self,
        chat_id: &str,
        goal: &str,
        kind: SessionKind,
        workspace_id: Option<&str>,
        now: u64,
    ) -> Result<bool, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Session Kernel lock is poisoned".to_owned())?;
        if sessions.load(chat_id).is_ok() {
            return Ok(false);
        }
        sessions.create(SessionDescriptor {
            id: chat_id.to_owned(),
            title: if goal.trim().is_empty() {
                "New task".into()
            } else {
                goal.trim().into()
            },
            workspace_id: workspace_id.map(str::to_owned),
            source: "picode".into(),
            external_session_id: None,
            kind,
            parent_session_id: None,
            created_at: now,
            updated_at: now,
            archived: false,
            deleted_at: None,
        })?;
        Ok(true)
    }

    fn rollback_creation(
        &self,
        chat_id: &str,
        created_session: bool,
        now: u64,
        original_error: String,
    ) -> String {
        if !created_session {
            return original_error;
        }
        let rollback = self
            .sessions
            .lock()
            .map_err(|_| "Session Kernel lock is poisoned".to_owned())
            .and_then(|mut sessions| {
                sessions.soft_delete(chat_id, now.max(1))?;
                sessions.purge(chat_id, chat_id)
            });
        match rollback {
            Ok(()) => original_error,
            Err(rollback_error) => format!(
                "{original_error}; Task Experience could not remove its empty session: {rollback_error}"
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AccountSelection, CreateTask, TaskExperienceService, TaskTarget, TaskTransition};
    use crate::session_kernel::SessionKernel;
    use crate::task_control::TaskControl;
    use std::sync::{Arc, Mutex};

    #[test]
    fn one_create_interface_records_the_task_in_the_canonical_session_stream() {
        let root =
            std::env::temp_dir().join(format!("picode-task-experience-{}", uuid::Uuid::new_v4()));
        let control = Arc::new(Mutex::new(
            TaskControl::open(&root.join("tasks"), "machine").unwrap(),
        ));
        let sessions = Arc::new(Mutex::new(
            SessionKernel::open(&root.join("sessions"), 4096).unwrap(),
        ));
        let experience = TaskExperienceService::new(control.clone(), sessions.clone());

        let task = experience
            .create(&CreateTask {
                chat_id: "chat-a",
                goal: "Discuss architecture",
                target: TaskTarget::Simple {
                    scratch_root: &root.join("scratch"),
                },
                now: 10,
            })
            .unwrap();

        assert_eq!(
            control.lock().unwrap().snapshot().execution.tasks[0].id,
            task.id
        );
        let loaded = sessions.lock().unwrap().load("chat-a").unwrap();
        assert_eq!(loaded.events.len(), 1);
        assert_eq!(loaded.events[0].event_type, "task_created");
        assert_eq!(loaded.events[0].payload["taskId"], task.id);
        drop(experience);
        drop(control);
        drop(sessions);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn start_and_continue_are_visible_in_the_same_session_event_stream() {
        let root = std::env::temp_dir().join(format!("picode-task-flow-{}", uuid::Uuid::new_v4()));
        let control = Arc::new(Mutex::new(
            TaskControl::open(&root.join("tasks"), "machine").unwrap(),
        ));
        let sessions = Arc::new(Mutex::new(
            SessionKernel::open(&root.join("sessions"), 4096).unwrap(),
        ));
        let experience = TaskExperienceService::new(control.clone(), sessions.clone());
        let task = experience
            .create(&CreateTask {
                chat_id: "chat-a",
                goal: "Discuss architecture",
                target: TaskTarget::Simple {
                    scratch_root: &root.join("scratch"),
                },
                now: 10,
            })
            .unwrap();

        experience
            .transition(
                &task.id,
                &TaskTransition::Start(AccountSelection {
                    provider: "codex",
                    account_id: "account-a",
                    channel: "openai",
                    model: "gpt-5.6",
                }),
                20,
            )
            .unwrap();
        control
            .lock()
            .unwrap()
            .handoff_account("codex", "account-a", "account-b")
            .unwrap();
        experience
            .transition(
                &task.id,
                &TaskTransition::Continue {
                    command: "继续",
                    account: AccountSelection {
                        provider: "codex",
                        account_id: "account-b",
                        channel: "openai",
                        model: "gpt-5.6",
                    },
                },
                30,
            )
            .unwrap();

        let loaded = sessions.lock().unwrap().load("chat-a").unwrap();
        assert_eq!(
            loaded
                .events
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>(),
            ["task_created", "task_started", "task_continued"]
        );
        drop(experience);
        drop(control);
        drop(sessions);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_task_creation_does_not_leave_an_orphan_session() {
        let root =
            std::env::temp_dir().join(format!("picode-task-atomic-{}", uuid::Uuid::new_v4()));
        let control = Arc::new(Mutex::new(
            TaskControl::open(&root.join("tasks"), "machine").unwrap(),
        ));
        let sessions = Arc::new(Mutex::new(
            SessionKernel::open(&root.join("sessions"), 4096).unwrap(),
        ));
        let experience = TaskExperienceService::new(control, sessions.clone());

        let error = experience
            .create(&CreateTask {
                chat_id: "chat-orphan",
                goal: "Build",
                target: TaskTarget::Harness {
                    workspace_id: "missing-workspace",
                },
                now: 10,
            })
            .unwrap_err();

        assert!(error.contains("workspace"));
        assert!(sessions.lock().unwrap().load("chat-orphan").is_err());
        drop(experience);
        drop(sessions);
        std::fs::remove_dir_all(root).unwrap();
    }
}
