#![cfg_attr(not(test), allow(dead_code))]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionState {
    pub schema_version: u32,
    #[serde(default)]
    pub chats: Vec<ChatSession>,
    #[serde(default)]
    pub tasks: Vec<TaskRun>,
    #[serde(default)]
    pub workspaces: Vec<WorkspaceIdentity>,
    #[serde(default)]
    pub scratch_spaces: Vec<ScratchSpace>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSession {
    pub id: String,
    #[serde(default)]
    pub task_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default)]
    pub continuation_required: bool,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIdentity {
    pub id: String,
    pub source_platform: String,
    pub source_path: String,
    #[serde(default)]
    pub local_bindings: BTreeMap<String, PathBuf>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScratchSpace {
    pub id: String,
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<PathBuf>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskKind {
    Simple,
    Harness,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    Draft,
    Running,
    Suspended,
    Completed,
    Failed,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskKindRevision {
    pub sequence: u32,
    pub kind: TaskKind,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub id: String,
    pub text: String,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOverride {
    pub id: String,
    pub source: String,
    pub scope: String,
    pub changed_actions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_strategy: Option<String>,
    pub changed_gates: Vec<String>,
    pub completion_label_effect: String,
    pub started_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionEpoch {
    pub id: String,
    pub sequence: u32,
    pub status: TaskStatus,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub account_id: String,
    #[serde(default)]
    pub channel: String,
    #[serde(default)]
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped_reason: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    pub id: String,
    pub chat_id: String,
    pub kind: TaskKind,
    #[serde(default)]
    pub kind_revisions: Vec<TaskKindRevision>,
    pub goal: String,
    pub acceptance: Vec<String>,
    #[serde(default)]
    pub plan: Vec<PlanItem>,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    #[serde(default)]
    pub overrides: Vec<TaskOverride>,
    pub status: TaskStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scratch_space_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_identity_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness_ref: Option<String>,
    #[serde(default)]
    pub epochs: Vec<ExecutionEpoch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suspended_reason: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl ExecutionState {
    pub fn new() -> Self {
        Self {
            schema_version: 1,
            chats: Vec::new(),
            tasks: Vec::new(),
            workspaces: Vec::new(),
            scratch_spaces: Vec::new(),
            extra: BTreeMap::new(),
        }
    }

    pub fn from_value(value: Value) -> Result<Self, String> {
        let state: Self = serde_json::from_value(value)
            .map_err(|error| format!("invalid execution schema: {error}"))?;
        state.validate()?;
        Ok(state)
    }

    pub fn create_chat(&mut self, id: &str) -> Result<ChatSession, String> {
        let id = id.trim();
        if id.is_empty() {
            return Err("chat id is required".into());
        }
        if self.chats.iter().any(|chat| chat.id == id) {
            return Err("chat id already exists".into());
        }
        let chat = ChatSession {
            id: id.to_owned(),
            task_ids: Vec::new(),
            provider: None,
            account_id: None,
            continuation_required: false,
            extra: BTreeMap::new(),
        };
        self.chats.push(chat.clone());
        Ok(chat)
    }

    /// Attach one durable task to the formal Pi session identity learned after
    /// the first message is persisted. The provisional chat remains only when
    /// it still owns other tasks; existing formal chats are merged without
    /// replacing their history or account provenance.
    pub fn bind_task_chat(&mut self, task_id: &str, chat_id: &str) -> Result<(), String> {
        let chat_id = chat_id.trim();
        if chat_id.is_empty() {
            return Err("chat id is required".into());
        }
        let old_chat_id = self.task(task_id)?.chat_id.clone();
        if old_chat_id == chat_id {
            return Ok(());
        }
        if !self.chats.iter().any(|chat| chat.id == chat_id) {
            self.create_chat(chat_id)?;
        }
        let old_index = self
            .chats
            .iter()
            .position(|chat| chat.id == old_chat_id)
            .ok_or_else(|| "task chat does not exist".to_owned())?;
        self.chats[old_index]
            .task_ids
            .retain(|candidate| candidate != task_id);
        let destination = self
            .chats
            .iter_mut()
            .find(|chat| chat.id == chat_id)
            .expect("destination chat was created above");
        if !destination
            .task_ids
            .iter()
            .any(|candidate| candidate == task_id)
        {
            destination.task_ids.push(task_id.to_owned());
        }
        self.task_mut(task_id)?.chat_id = chat_id.to_owned();
        if self.chats[old_index].task_ids.is_empty() {
            self.chats.remove(old_index);
        }
        self.validate()
    }

    pub fn register_workspace(
        &mut self,
        source_platform: &str,
        source_path: &str,
    ) -> Result<WorkspaceIdentity, String> {
        if source_platform.trim().is_empty() || source_path.trim().is_empty() {
            return Err("workspace source platform and path are required".into());
        }
        if let Some(existing) = self.workspaces.iter().find(|workspace| {
            workspace.source_platform == source_platform && workspace.source_path == source_path
        }) {
            return Ok(existing.clone());
        }
        let workspace = WorkspaceIdentity {
            id: Uuid::new_v4().to_string(),
            source_platform: source_platform.to_owned(),
            source_path: source_path.to_owned(),
            local_bindings: BTreeMap::new(),
            extra: BTreeMap::new(),
        };
        self.workspaces.push(workspace.clone());
        Ok(workspace)
    }

    pub fn bind_workspace(
        &mut self,
        workspace_id: &str,
        machine_id: &str,
        local_path: &Path,
    ) -> Result<(), String> {
        if machine_id.trim().is_empty() {
            return Err("machine id is required".into());
        }
        let canonical = local_path.canonicalize().map_err(|error| {
            format!(
                "workspace binding must be an existing directory {}: {error}",
                local_path.display()
            )
        })?;
        if !canonical.is_dir() {
            return Err("workspace binding must be a directory".into());
        }
        let workspace = self
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.id == workspace_id)
            .ok_or_else(|| "workspace identity does not exist".to_owned())?;
        workspace
            .local_bindings
            .insert(machine_id.to_owned(), canonical);
        Ok(())
    }

    pub fn resolve_workspace(
        &self,
        workspace_id: &str,
        machine_id: &str,
    ) -> Result<PathBuf, String> {
        let workspace = self
            .workspaces
            .iter()
            .find(|workspace| workspace.id == workspace_id)
            .ok_or_else(|| "workspace identity does not exist".to_owned())?;
        let binding = workspace
            .local_bindings
            .get(machine_id)
            .ok_or_else(|| "workspace is not bound on this machine".to_owned())?;
        let canonical = binding
            .canonicalize()
            .map_err(|_| "workspace binding no longer exists".to_owned())?;
        if !canonical.is_dir() {
            return Err("workspace binding is not a directory".into());
        }
        Ok(canonical)
    }

    pub fn create_task(
        &mut self,
        chat_id: &str,
        kind: TaskKind,
        goal: &str,
        acceptance: Vec<String>,
    ) -> Result<TaskRun, String> {
        let chat = self
            .chats
            .iter_mut()
            .find(|chat| chat.id == chat_id)
            .ok_or_else(|| "chat does not exist".to_owned())?;
        let task = TaskRun {
            id: Uuid::new_v4().to_string(),
            chat_id: chat_id.to_owned(),
            kind,
            kind_revisions: vec![TaskKindRevision {
                sequence: 1,
                kind,
                reason: "task created".to_owned(),
            }],
            goal: goal.trim().to_owned(),
            acceptance,
            plan: Vec::new(),
            evidence_refs: Vec::new(),
            overrides: Vec::new(),
            status: TaskStatus::Draft,
            scratch_space_id: None,
            workspace_identity_id: None,
            harness_ref: None,
            epochs: Vec::new(),
            suspended_reason: None,
            extra: BTreeMap::new(),
        };
        chat.task_ids.push(task.id.clone());
        self.tasks.push(task.clone());
        Ok(task)
    }

    pub fn task(&self, task_id: &str) -> Result<&TaskRun, String> {
        self.tasks
            .iter()
            .find(|task| task.id == task_id)
            .ok_or_else(|| "task does not exist".to_owned())
    }

    pub fn add_plan_item(&mut self, task_id: &str, text: &str) -> Result<(), String> {
        if text.trim().is_empty() {
            return Err("plan item text is required".into());
        }
        let task = self.task_mut(task_id)?;
        task.plan.push(PlanItem {
            id: Uuid::new_v4().to_string(),
            text: text.trim().to_owned(),
            status: "pending".to_owned(),
        });
        Ok(())
    }

    pub fn add_evidence_ref(&mut self, task_id: &str, reference: &str) -> Result<(), String> {
        if reference.trim().is_empty() {
            return Err("evidence reference is required".into());
        }
        let task = self.task_mut(task_id)?;
        task.evidence_refs.push(reference.trim().to_owned());
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn add_task_override(
        &mut self,
        task_id: &str,
        source: &str,
        scope: &str,
        changed_actions: Vec<String>,
        git_strategy: Option<String>,
        changed_gates: Vec<String>,
        completion_label_effect: &str,
    ) -> Result<String, String> {
        let task = self.task_mut(task_id)?;
        if task.kind != TaskKind::Harness {
            return Err("Task Overrides apply only to Harness tasks".into());
        }
        if source.trim().is_empty() || scope.trim().is_empty() {
            return Err("Task Override source and scope are required".into());
        }
        let id = Uuid::new_v4().to_string();
        task.overrides.push(TaskOverride {
            id: id.clone(),
            source: source.to_owned(),
            scope: scope.to_owned(),
            changed_actions,
            git_strategy,
            changed_gates,
            completion_label_effect: completion_label_effect.to_owned(),
            started_at: unix_millis(),
            ended_at: None,
        });
        Ok(id)
    }

    pub fn end_task_override(
        &mut self,
        task_id: &str,
        override_id: &str,
        ended_at: u64,
    ) -> Result<(), String> {
        let override_record = self
            .task_mut(task_id)?
            .overrides
            .iter_mut()
            .find(|record| record.id == override_id)
            .ok_or_else(|| "Task Override does not exist".to_owned())?;
        override_record.ended_at = Some(ended_at);
        Ok(())
    }

    pub fn attach_workspace(
        &mut self,
        task_id: &str,
        workspace_id: &str,
        machine_id: &str,
    ) -> Result<(), String> {
        self.resolve_workspace(workspace_id, machine_id)?;
        self.task_mut(task_id)?.workspace_identity_id = Some(workspace_id.to_owned());
        Ok(())
    }

    pub fn convert_to_harness(
        &mut self,
        task_id: &str,
        machine_id: &str,
        reason: &str,
    ) -> Result<(), String> {
        let workspace_id = self
            .task(task_id)?
            .workspace_identity_id
            .clone()
            .ok_or_else(|| "task must attach a workspace before Harness conversion".to_owned())?;
        self.resolve_workspace(&workspace_id, machine_id)?;
        let task = self.task_mut(task_id)?;
        if task.kind == TaskKind::Harness {
            return Err("task is already Harness".into());
        }
        task.kind = TaskKind::Harness;
        task.kind_revisions.push(TaskKindRevision {
            sequence: task.kind_revisions.len() as u32 + 1,
            kind: TaskKind::Harness,
            reason: reason.to_owned(),
        });
        task.harness_ref = Some("builtin:harness@1".to_owned());
        Ok(())
    }

    pub fn create_harness_task(
        &mut self,
        chat_id: &str,
        goal: &str,
        acceptance: Vec<String>,
        workspace_id: &str,
        machine_id: &str,
    ) -> Result<TaskRun, String> {
        self.resolve_workspace(workspace_id, machine_id)?;
        let mut task = self.create_task(chat_id, TaskKind::Harness, goal, acceptance)?;
        task.workspace_identity_id = Some(workspace_id.to_owned());
        task.harness_ref = Some("builtin:harness@1".to_owned());
        if let Some(stored) = self.tasks.iter_mut().find(|stored| stored.id == task.id) {
            stored.workspace_identity_id = task.workspace_identity_id.clone();
            stored.harness_ref = task.harness_ref.clone();
        }
        Ok(task)
    }

    pub fn create_simple_task(
        &mut self,
        chat_id: &str,
        goal: &str,
        acceptance: Vec<String>,
        scratch_root: &Path,
    ) -> Result<TaskRun, String> {
        let mut task = self.create_task(chat_id, TaskKind::Simple, goal, acceptance)?;
        let scratch_id = Uuid::new_v4().to_string();
        let path = scratch_root.join(&scratch_id);
        if let Err(error) = std::fs::create_dir_all(&path) {
            self.tasks.retain(|candidate| candidate.id != task.id);
            if let Some(chat) = self.chats.iter_mut().find(|chat| chat.id == chat_id) {
                chat.task_ids.retain(|task_id| task_id != &task.id);
            }
            return Err(format!(
                "cannot create Scratch Space {}: {error}",
                path.display()
            ));
        }
        let scratch = ScratchSpace {
            id: scratch_id.clone(),
            task_id: task.id.clone(),
            path: Some(path),
            extra: BTreeMap::new(),
        };
        task.scratch_space_id = Some(scratch_id);
        if let Some(stored) = self.tasks.iter_mut().find(|stored| stored.id == task.id) {
            stored.scratch_space_id = task.scratch_space_id.clone();
        }
        self.scratch_spaces.push(scratch);
        Ok(task)
    }

    pub fn scratch_for_task(&self, task_id: &str) -> Result<&ScratchSpace, String> {
        self.scratch_spaces
            .iter()
            .find(|scratch| scratch.task_id == task_id)
            .ok_or_else(|| "task has no Scratch Space".to_owned())
    }

    pub fn cleanup_scratch(&mut self, task_id: &str) -> Result<(), String> {
        let index = self
            .scratch_spaces
            .iter()
            .position(|scratch| scratch.task_id == task_id)
            .ok_or_else(|| "task has no Scratch Space".to_owned())?;
        let scratch = self.scratch_spaces.remove(index);
        if let Some(path) = scratch.path {
            if path.exists() {
                std::fs::remove_dir_all(&path).map_err(|error| {
                    format!("cannot remove Scratch Space {}: {error}", path.display())
                })?;
            }
            if let Some(parent) = path.parent() {
                let is_empty = parent
                    .read_dir()
                    .map(|mut entries| entries.next().is_none())
                    .unwrap_or(false);
                if is_empty {
                    let _ = std::fs::remove_dir(parent);
                }
            }
        }
        if let Some(task) = self.tasks.iter_mut().find(|task| task.id == task_id) {
            task.scratch_space_id = None;
        }
        Ok(())
    }

    pub fn portable_value(&self) -> Value {
        let mut portable = self.clone();
        for workspace in &mut portable.workspaces {
            workspace.local_bindings.clear();
        }
        for scratch in &mut portable.scratch_spaces {
            scratch.path = None;
        }
        serde_json::to_value(portable).expect("serializing an ExecutionState cannot fail")
    }

    pub fn start_task(&mut self, task_id: &str) -> Result<(), String> {
        let task = self.task_mut(task_id)?;
        match task.status {
            TaskStatus::Draft | TaskStatus::Suspended => {}
            _ => return Err("task must be draft or suspended before start".into()),
        }
        task.status = TaskStatus::Running;
        task.suspended_reason = None;
        task.epochs.push(ExecutionEpoch {
            id: Uuid::new_v4().to_string(),
            sequence: task.epochs.len() as u32 + 1,
            status: TaskStatus::Running,
            provider: String::new(),
            account_id: String::new(),
            channel: String::new(),
            model: String::new(),
            stopped_reason: None,
            extra: BTreeMap::new(),
        });
        Ok(())
    }

    pub fn start_task_with_account(
        &mut self,
        task_id: &str,
        provider: &str,
        account_id: &str,
        channel: &str,
        model: &str,
    ) -> Result<(), String> {
        if [provider, account_id, channel, model]
            .iter()
            .any(|value| value.trim().is_empty())
        {
            return Err("provider, account, channel, and model are required".into());
        }
        if self.chats.iter().any(|chat| {
            chat.provider.as_deref() == Some(provider)
                && chat
                    .account_id
                    .as_deref()
                    .is_some_and(|active| active != account_id)
                && !chat.continuation_required
        }) {
            return Err("only one account per provider may be active".into());
        }
        let chat_id = self.task(task_id)?.chat_id.clone();
        self.start_task(task_id)?;
        let task = self.task_mut(task_id)?;
        let epoch = task.epochs.last_mut().expect("start_task creates an epoch");
        epoch.provider = provider.to_owned();
        epoch.account_id = account_id.to_owned();
        epoch.channel = channel.to_owned();
        epoch.model = model.to_owned();
        let chat = self
            .chats
            .iter_mut()
            .find(|chat| chat.id == chat_id)
            .expect("task validation guarantees chat");
        chat.provider = Some(provider.to_owned());
        chat.account_id = Some(account_id.to_owned());
        chat.continuation_required = false;
        Ok(())
    }

    pub fn disconnect_account(
        &mut self,
        provider: &str,
        account_id: &str,
    ) -> Result<Vec<String>, String> {
        let affected: Vec<String> = self
            .tasks
            .iter()
            .filter(|task| {
                task.status == TaskStatus::Running
                    && task.epochs.last().is_some_and(|epoch| {
                        epoch.provider == provider && epoch.account_id == account_id
                    })
            })
            .map(|task| task.id.clone())
            .collect();
        for task_id in &affected {
            self.suspend_task(task_id, "account disconnected")?;
        }
        for chat in &mut self.chats {
            if chat.provider.as_deref() == Some(provider)
                && chat.account_id.as_deref() == Some(account_id)
            {
                chat.continuation_required = true;
            }
        }
        Ok(affected)
    }

    pub fn handoff_account(
        &mut self,
        provider: &str,
        previous_account_id: &str,
        replacement_account_id: &str,
    ) -> Result<(), String> {
        let mut matched = false;
        for chat in &mut self.chats {
            if chat.provider.as_deref() == Some(provider)
                && chat.account_id.as_deref() == Some(previous_account_id)
            {
                chat.account_id = Some(replacement_account_id.to_owned());
                chat.continuation_required = true;
                matched = true;
            }
        }
        if !matched {
            return Err("no chats are bound to the replaced account".into());
        }
        Ok(())
    }

    pub fn continue_with_account(
        &mut self,
        task_id: &str,
        command: &str,
        account_id: &str,
        channel: &str,
        model: &str,
    ) -> Result<(), String> {
        let command = command.trim();
        if command != "继续" && !command.eq_ignore_ascii_case("continue") {
            return Err("task continuation requires an explicit localized continue command".into());
        }
        let task = self.task(task_id)?;
        if task.status != TaskStatus::Suspended {
            return Err("only a suspended task can continue".into());
        }
        let provider = task
            .epochs
            .last()
            .map(|epoch| epoch.provider.clone())
            .filter(|provider| !provider.is_empty())
            .ok_or_else(|| "suspended task has no provider provenance".to_owned())?;
        let chat = self
            .chats
            .iter()
            .find(|chat| chat.id == task.chat_id)
            .expect("task validation guarantees chat");
        if !chat.continuation_required || chat.account_id.as_deref() != Some(account_id) {
            return Err("replacement account is not assigned to this chat".into());
        }
        self.start_task_with_account(task_id, &provider, account_id, channel, model)
    }

    pub fn suspend_task(&mut self, task_id: &str, reason: &str) -> Result<(), String> {
        let task = self.task_mut(task_id)?;
        if task.status != TaskStatus::Running {
            return Err("task must be running before suspension".into());
        }
        task.status = TaskStatus::Suspended;
        task.suspended_reason = Some(reason.to_owned());
        if let Some(epoch) = task.epochs.last_mut() {
            epoch.status = TaskStatus::Suspended;
            epoch.stopped_reason = Some(reason.to_owned());
        }
        Ok(())
    }

    pub fn complete_task(&mut self, task_id: &str) -> Result<(), String> {
        let task = self.task_mut(task_id)?;
        if task.status != TaskStatus::Running {
            return Err("task must be running before completion".into());
        }
        task.status = TaskStatus::Completed;
        if let Some(epoch) = task.epochs.last_mut() {
            epoch.status = TaskStatus::Completed;
        }
        Ok(())
    }

    fn task_mut(&mut self, task_id: &str) -> Result<&mut TaskRun, String> {
        self.tasks
            .iter_mut()
            .find(|task| task.id == task_id)
            .ok_or_else(|| "task does not exist".to_owned())
    }

    fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err(format!(
                "unsupported execution schema {}",
                self.schema_version
            ));
        }
        for task in &self.tasks {
            let Some(chat) = self.chats.iter().find(|chat| chat.id == task.chat_id) else {
                return Err(format!("task {} refers to a missing chat", task.id));
            };
            if !chat.task_ids.contains(&task.id) {
                return Err(format!(
                    "chat {} does not contain task {}",
                    chat.id, task.id
                ));
            }
        }
        Ok(())
    }
}

impl Default for ExecutionState {
    fn default() -> Self {
        Self::new()
    }
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::{ExecutionState, TaskKind, TaskStatus};

    #[test]
    fn durable_task_rejects_invalid_transitions_and_round_trips_future_fields() {
        let mut state = ExecutionState::new();
        let chat = state.create_chat("chat-a").unwrap();
        let task = state
            .create_task(
                &chat.id,
                TaskKind::Harness,
                "Ship P0",
                vec!["all gates pass".into()],
            )
            .unwrap();
        state.start_task(&task.id).unwrap();
        state
            .suspend_task(&task.id, "account disconnected")
            .unwrap();
        assert_eq!(
            state.complete_task(&task.id),
            Err("task must be running before completion".into())
        );

        let mut value = serde_json::to_value(&state).unwrap();
        value["futureRootField"] = serde_json::json!({ "kept": true });
        value["tasks"][0]["futureTaskField"] = serde_json::json!(42);
        let restored = ExecutionState::from_value(value).unwrap();

        assert_eq!(restored.schema_version, 1);
        assert_eq!(restored.tasks[0].status, TaskStatus::Suspended);
        assert_eq!(restored.tasks[0].epochs.len(), 1);
        assert_eq!(restored.extra["futureRootField"]["kept"], true);
        assert_eq!(restored.tasks[0].extra["futureTaskField"], 42);
    }

    #[test]
    fn portable_workspace_identity_never_executes_an_unbound_source_path() {
        let temp = std::env::temp_dir().join(format!("picode-workspace-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let mut state = ExecutionState::new();
        let workspace = state
            .register_workspace("windows", r"D:\game\client")
            .unwrap();

        assert_eq!(
            state.resolve_workspace(&workspace.id, "linux-laptop"),
            Err("workspace is not bound on this machine".into())
        );
        state
            .bind_workspace(&workspace.id, "windows-desktop", &temp)
            .unwrap();
        assert_eq!(
            state
                .resolve_workspace(&workspace.id, "windows-desktop")
                .unwrap(),
            temp.canonicalize().unwrap()
        );

        std::fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn simple_task_uses_app_scratch_without_exporting_its_machine_path() {
        let root = std::env::temp_dir().join(format!("picode-scratch-{}", uuid::Uuid::new_v4()));
        let mut state = ExecutionState::new();
        let chat = state.create_chat("chat-simple").unwrap();
        let task = state
            .create_simple_task(&chat.id, "Answer a small question", Vec::new(), &root)
            .unwrap();
        let scratch = state.scratch_for_task(&task.id).unwrap();

        assert!(scratch.path.as_ref().unwrap().is_dir());
        assert_eq!(task.kind, TaskKind::Simple);
        assert!(!state
            .portable_value()
            .to_string()
            .contains(&root.to_string_lossy().to_string()));

        state.cleanup_scratch(&task.id).unwrap();
        assert!(!root.exists());
    }

    #[test]
    fn task_goal_is_optional_and_blank_input_is_normalized() {
        let root = std::env::temp_dir().join(format!("picode-empty-goal-{}", uuid::Uuid::new_v4()));
        let mut state = ExecutionState::new();
        let chat = state.create_chat("chat-empty-goal").unwrap();
        let task = state
            .create_simple_task(&chat.id, "   ", Vec::new(), &root)
            .unwrap();

        assert_eq!(task.goal, "");
        state.cleanup_scratch(&task.id).unwrap();
    }

    #[test]
    fn harness_task_requires_a_current_machine_binding_and_exposes_template_version() {
        let local = std::env::temp_dir().join(format!("picode-harness-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&local).unwrap();
        let mut state = ExecutionState::new();
        let chat = state.create_chat("chat-harness").unwrap();
        let workspace = state.register_workspace("linux", "/srv/game").unwrap();

        assert_eq!(
            state.create_harness_task(
                &chat.id,
                "Build the game",
                Vec::new(),
                &workspace.id,
                "windows-desktop"
            ),
            Err("workspace is not bound on this machine".into())
        );
        state
            .bind_workspace(&workspace.id, "windows-desktop", &local)
            .unwrap();
        let task = state
            .create_harness_task(
                &chat.id,
                "Build the game",
                Vec::new(),
                &workspace.id,
                "windows-desktop",
            )
            .unwrap();

        assert_eq!(task.kind, TaskKind::Harness);
        assert_eq!(task.harness_ref.as_deref(), Some("builtin:harness@1"));
        assert_eq!(
            task.workspace_identity_id.as_deref(),
            Some(workspace.id.as_str())
        );
        assert!(local.read_dir().unwrap().next().is_none());

        std::fs::remove_dir_all(local).unwrap();
    }

    #[test]
    fn simple_to_harness_conversion_appends_history_without_losing_task_state() {
        let scratch =
            std::env::temp_dir().join(format!("picode-convert-scratch-{}", uuid::Uuid::new_v4()));
        let workspace_path =
            std::env::temp_dir().join(format!("picode-convert-workspace-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&workspace_path).unwrap();
        let mut state = ExecutionState::new();
        let chat = state.create_chat("chat-convert").unwrap();
        let workspace = state
            .register_workspace("windows", r"D:\old\project")
            .unwrap();
        state
            .bind_workspace(&workspace.id, "machine", &workspace_path)
            .unwrap();
        let task = state
            .create_simple_task(
                &chat.id,
                "Continue project",
                vec!["tests pass".into()],
                &scratch,
            )
            .unwrap();
        state
            .add_plan_item(&task.id, "Inspect the project")
            .unwrap();
        state.add_evidence_ref(&task.id, "sha256:abc").unwrap();
        state.start_task(&task.id).unwrap();
        state.suspend_task(&task.id, "convert task kind").unwrap();

        state
            .attach_workspace(&task.id, &workspace.id, "machine")
            .unwrap();
        assert_eq!(state.task(&task.id).unwrap().kind, TaskKind::Simple);
        state
            .convert_to_harness(&task.id, "machine", "user selected Harness")
            .unwrap();
        let converted = state.task(&task.id).unwrap();

        assert_eq!(converted.id, task.id);
        assert_eq!(converted.kind, TaskKind::Harness);
        assert_eq!(converted.kind_revisions.len(), 2);
        assert_eq!(converted.plan[0].text, "Inspect the project");
        assert_eq!(converted.evidence_refs, vec!["sha256:abc"]);
        assert_eq!(converted.epochs.len(), 1);

        state.cleanup_scratch(&task.id).unwrap();
        std::fs::remove_dir_all(workspace_path).unwrap();
    }

    #[test]
    fn account_handoff_preserves_tasks_and_requires_localized_continue_for_a_new_epoch() {
        let scratch = std::env::temp_dir().join(format!("picode-handoff-{}", uuid::Uuid::new_v4()));
        let mut state = ExecutionState::new();
        let codex_chat = state.create_chat("codex-chat").unwrap();
        let claude_chat = state.create_chat("claude-chat").unwrap();
        let codex_task = state
            .create_simple_task(&codex_chat.id, "Codex work", Vec::new(), &scratch)
            .unwrap();
        let claude_task = state
            .create_task(&claude_chat.id, TaskKind::Simple, "Claude work", Vec::new())
            .unwrap();
        state
            .start_task_with_account(&codex_task.id, "codex", "account-a", "official", "gpt-5")
            .unwrap();
        state
            .start_task_with_account(&claude_task.id, "claude", "claude-a", "official", "sonnet")
            .unwrap();

        assert_eq!(
            state.disconnect_account("codex", "account-a").unwrap(),
            vec![codex_task.id.clone()]
        );
        state
            .handoff_account("codex", "account-a", "account-b")
            .unwrap();
        assert_eq!(state.task(&codex_task.id).unwrap().epochs.len(), 1);
        assert_eq!(
            state.task(&claude_task.id).unwrap().status,
            TaskStatus::Running
        );
        assert_eq!(
            state.continue_with_account(
                &codex_task.id,
                "not continue",
                "account-b",
                "official",
                "gpt-5"
            ),
            Err("task continuation requires an explicit localized continue command".into())
        );

        state
            .continue_with_account(&codex_task.id, "继续", "account-b", "official", "gpt-5")
            .unwrap();
        let resumed = state.task(&codex_task.id).unwrap();
        assert_eq!(resumed.status, TaskStatus::Running);
        assert_eq!(resumed.epochs.len(), 2);
        assert_eq!(resumed.epochs[1].account_id, "account-b");

        state.cleanup_scratch(&codex_task.id).unwrap();
    }

    #[test]
    fn task_override_is_visible_durable_and_scoped_to_one_harness_task() {
        let mut state = ExecutionState::new();
        let chat = state.create_chat("override-chat").unwrap();
        let task = state
            .create_task(&chat.id, TaskKind::Harness, "Use explicit TDD", Vec::new())
            .unwrap();
        let other = state
            .create_task(&chat.id, TaskKind::Harness, "Unaffected", Vec::new())
            .unwrap();

        let override_id = state
            .add_task_override(
                &task.id,
                "skill:tdd",
                "workflow",
                vec!["red-before-green".into()],
                Some("git-safe-branch".into()),
                vec!["focused-tests".into()],
                "Harness verified with overrides",
            )
            .unwrap();
        state
            .end_task_override(&task.id, &override_id, 1_234)
            .unwrap();
        let restored = ExecutionState::from_value(serde_json::to_value(&state).unwrap()).unwrap();

        assert_eq!(
            restored.task(&task.id).unwrap().overrides[0].source,
            "skill:tdd"
        );
        assert_eq!(
            restored.task(&task.id).unwrap().overrides[0].ended_at,
            Some(1_234)
        );
        assert!(restored.task(&other.id).unwrap().overrides.is_empty());
    }
}
