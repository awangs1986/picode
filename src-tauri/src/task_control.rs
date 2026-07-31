#![cfg_attr(not(test), allow(dead_code))]

use crate::execution::{ExecutionState, TaskKind, TaskRun, TaskStatus, WorkspaceIdentity};
use crate::execution_store::ExecutionStore;
use crate::runtime_registry::{
    AgentRun, AgentRunRegistry, AgentRunState, HealthSignals, ResourceSample, StartAgentRun,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskControlSnapshot {
    pub execution: ExecutionState,
    pub agent_runs: Vec<AgentRun>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptActivation {
    pub task_id: String,
    pub chat_id: String,
    pub epoch_id: String,
    pub source_port: u16,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCancelTarget {
    pub run_id: String,
    pub source_port: u16,
    pub process_id: u32,
}

#[derive(Clone, Debug)]
pub struct RuntimeEventContext {
    pub task_id: String,
    pub parent_id: Option<String>,
    pub active_run: Option<AgentRun>,
}

#[derive(Clone, Debug)]
struct RuntimeRoute {
    task_id: String,
    chat_id: String,
    parent_id: Option<String>,
    provider: Option<String>,
    account_id: Option<String>,
    model: Option<String>,
}

pub struct TaskControl {
    root: PathBuf,
    machine_id: String,
    store: ExecutionStore,
    execution: ExecutionState,
    registry: AgentRunRegistry,
    runtime_routes: BTreeMap<u16, RuntimeRoute>,
}

impl TaskControl {
    pub fn open(root: &Path, machine_id: &str) -> Result<Self, String> {
        if machine_id.trim().is_empty() {
            return Err("machine id is required".into());
        }
        fs::create_dir_all(root).map_err(|error| format!("create Task Control root: {error}"))?;
        let store = ExecutionStore::open(root.join("execution"))?;
        let execution = if store.state_path().exists() {
            store.load()?.state
        } else {
            ExecutionState::new()
        };
        let registry_path = root.join("agent-runs.json");
        let registry = if registry_path.exists() {
            serde_json::from_slice(
                &fs::read(&registry_path)
                    .map_err(|error| format!("read Agent Run registry: {error}"))?,
            )
            .map_err(|error| format!("corrupt Agent Run registry: {error}"))?
        } else {
            AgentRunRegistry::default()
        };
        let mut control = Self {
            root: root.to_owned(),
            machine_id: machine_id.into(),
            store,
            execution,
            registry,
            runtime_routes: BTreeMap::new(),
        };
        control
            .registry
            .reconcile_after_restart(|_| false, unix_millis());
        control.persist()?;
        Ok(control)
    }

    pub fn snapshot(&self) -> TaskControlSnapshot {
        TaskControlSnapshot {
            execution: self.execution.clone(),
            agent_runs: self.registry.runs.clone(),
        }
    }

    pub fn task_workspace(&self, task_id: &str) -> Result<PathBuf, String> {
        let task = self.execution.task(task_id)?;
        let workspace_id = task
            .workspace_identity_id
            .as_deref()
            .ok_or_else(|| "Harness Task has no Workspace Identity".to_owned())?;
        self.execution
            .resolve_workspace(workspace_id, &self.machine_id)
    }

    pub fn task_working_dir(&self, task_id: &str) -> Result<PathBuf, String> {
        let task = self.execution.task(task_id)?;
        if task.workspace_identity_id.is_some() {
            return self.task_workspace(task_id);
        }
        let scratch_id = task
            .scratch_space_id
            .as_deref()
            .ok_or_else(|| "task has neither a Workspace Identity nor Scratch Space".to_owned())?;
        self.execution
            .scratch_spaces
            .iter()
            .find(|scratch| scratch.id == scratch_id)
            .and_then(|scratch| scratch.path.clone())
            .ok_or_else(|| "task Scratch Space is unavailable".to_owned())
    }

    pub fn validate_agent_run(&self, run_id: &str, task_id: &str) -> Result<(), String> {
        let run = self
            .registry
            .get(run_id)
            .ok_or_else(|| "Agent Run does not exist".to_owned())?;
        if run.task_id != task_id {
            return Err("Agent Run belongs to another task".into());
        }
        if run.state.is_terminal() {
            return Err("Agent Run is terminal".into());
        }
        Ok(())
    }

    pub fn validate_delegation_parent(&self, run_id: &str, task_id: &str) -> Result<(), String> {
        self.validate_agent_run(run_id, task_id)?;
        if self
            .registry
            .get(run_id)
            .is_some_and(|run| run.parent_id.is_some())
        {
            return Err("nested Subagents are disabled by default".into());
        }
        Ok(())
    }

    pub fn validate_task_port(&self, task_id: &str, source_port: u16) -> Result<(), String> {
        let route = self
            .runtime_routes
            .get(&source_port)
            .ok_or_else(|| "Pi port is not bound to an active task".to_owned())?;
        if route.task_id != task_id {
            return Err("Pi port belongs to another task".into());
        }
        Ok(())
    }

    pub fn task_kind(&self, task_id: &str) -> Result<TaskKind, String> {
        Ok(self.execution.task(task_id)?.kind)
    }

    pub fn task_chat_id(&self, task_id: &str) -> Result<String, String> {
        Ok(self.execution.task(task_id)?.chat_id.clone())
    }

    pub fn runtime_event_context(&self, source_port: u16) -> Option<RuntimeEventContext> {
        let route = self.runtime_routes.get(&source_port)?;
        let active_run = self
            .registry
            .runs
            .iter()
            .rev()
            .find(|run| {
                run.task_id == route.task_id
                    && run.source_port == source_port
                    && !run.state.is_terminal()
            })
            .cloned();
        Some(RuntimeEventContext {
            task_id: route.task_id.clone(),
            parent_id: route.parent_id.clone(),
            active_run,
        })
    }

    pub fn complete_task(&mut self, task_id: &str) -> Result<(), String> {
        if self.execution.task(task_id)?.status == TaskStatus::Completed {
            return Ok(());
        }
        self.execution.complete_task(task_id)?;
        self.persist()
    }

    /// Records an explicitly invoked imported workflow as a visible Harness
    /// override. Simple Tasks deliberately have no Harness contract to
    /// override, so their explicit activation is tracked by ExtensionService.
    pub fn add_import_override(
        &mut self,
        task_id: &str,
        source: &str,
        scope: &str,
    ) -> Result<Option<String>, String> {
        if self.execution.task(task_id)?.kind == TaskKind::Simple {
            return Ok(None);
        }
        let id = self.execution.add_task_override(
            task_id,
            source,
            scope,
            vec!["explicit imported workflow".into()],
            None,
            Vec::new(),
            "Harness verified with overrides",
        )?;
        self.persist()?;
        Ok(Some(id))
    }

    pub fn record_evidence_ref(&mut self, task_id: &str, evidence_id: &str) -> Result<(), String> {
        if evidence_id.trim().is_empty() {
            return Err("evidence id is required".into());
        }
        let task = self
            .execution
            .tasks
            .iter_mut()
            .find(|task| task.id == task_id)
            .ok_or_else(|| "task does not exist".to_owned())?;
        if !task.evidence_refs.iter().any(|id| id == evidence_id) {
            task.evidence_refs.push(evidence_id.to_owned());
        }
        self.persist()
    }

    pub fn create_simple(
        &mut self,
        chat_id: &str,
        goal: &str,
        scratch_root: &Path,
    ) -> Result<TaskRun, String> {
        self.ensure_chat(chat_id)?;
        let task = self
            .execution
            .create_simple_task(chat_id, goal, Vec::new(), scratch_root)?;
        self.persist()?;
        Ok(task)
    }

    pub fn register_workspace(
        &mut self,
        source_platform: &str,
        source_path: &str,
        local_path: Option<&Path>,
    ) -> Result<WorkspaceIdentity, String> {
        let workspace = self
            .execution
            .register_workspace(source_platform, source_path)?;
        if let Some(path) = local_path {
            self.execution
                .bind_workspace(&workspace.id, &self.machine_id, path)?;
        }
        self.persist()?;
        Ok(workspace)
    }

    pub fn bind_workspace(&mut self, workspace_id: &str, local_path: &Path) -> Result<(), String> {
        self.execution
            .bind_workspace(workspace_id, &self.machine_id, local_path)?;
        self.persist()
    }

    pub fn create_harness(
        &mut self,
        chat_id: &str,
        goal: &str,
        workspace_id: &str,
    ) -> Result<TaskRun, String> {
        self.ensure_chat(chat_id)?;
        let task = self.execution.create_harness_task(
            chat_id,
            goal,
            Vec::new(),
            workspace_id,
            &self.machine_id,
        )?;
        self.persist()?;
        Ok(task)
    }

    pub fn start_task(
        &mut self,
        task_id: &str,
        provider: &str,
        account_id: &str,
        channel: &str,
        model: &str,
    ) -> Result<(), String> {
        self.execution
            .start_task_with_account(task_id, provider, account_id, channel, model)?;
        self.persist()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn activate_prompt(
        &mut self,
        task_id: &str,
        chat_id: &str,
        provider: &str,
        account_id: &str,
        channel: &str,
        model: &str,
        source_port: u16,
        user_confirmed_continue: bool,
    ) -> Result<PromptActivation, String> {
        if source_port == 0 {
            return Err("a live Pi source port is required".into());
        }
        self.execution.bind_task_chat(task_id, chat_id)?;
        match self.execution.task(task_id)?.status {
            TaskStatus::Draft => self
                .execution
                .start_task_with_account(task_id, provider, account_id, channel, model)?,
            TaskStatus::Suspended if user_confirmed_continue => self
                .execution
                .continue_with_account(task_id, "continue", account_id, channel, model)?,
            TaskStatus::Suspended => {
                return Err("suspended task requires an explicit continue command".into())
            }
            TaskStatus::Running => {
                let epoch = self
                    .execution
                    .task(task_id)?
                    .epochs
                    .last()
                    .ok_or_else(|| "running task has no Execution Epoch".to_owned())?;
                if epoch.provider != provider || epoch.account_id != account_id {
                    return Err("running task is bound to a different provider account".into());
                }
            }
            TaskStatus::Completed | TaskStatus::Failed => {
                return Err("terminal task cannot accept a prompt".into())
            }
        }
        let task = self.execution.task(task_id)?;
        let epoch_id = task
            .epochs
            .last()
            .map(|epoch| epoch.id.clone())
            .ok_or_else(|| "task has no active Execution Epoch".to_owned())?;
        self.runtime_routes.insert(
            source_port,
            RuntimeRoute {
                task_id: task_id.to_owned(),
                chat_id: chat_id.to_owned(),
                parent_id: None,
                provider: None,
                account_id: None,
                model: None,
            },
        );
        self.persist()?;
        Ok(PromptActivation {
            task_id: task_id.to_owned(),
            chat_id: chat_id.to_owned(),
            epoch_id,
            source_port,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn activate_subagent_runtime(
        &mut self,
        task_id: &str,
        parent_id: &str,
        source_port: u16,
        provider: &str,
        account_id: &str,
        model: &str,
    ) -> Result<String, String> {
        if source_port == 0
            || [task_id, parent_id, provider, account_id, model]
                .iter()
                .any(|value| value.trim().is_empty())
        {
            return Err("Subagent runtime identity is incomplete".into());
        }
        let parent = self
            .registry
            .get(parent_id)
            .ok_or_else(|| "parent Agent Run does not exist".to_owned())?;
        if parent.task_id != task_id || parent.state.is_terminal() {
            return Err("Subagent parent must be active and belong to the same task".into());
        }
        let task = self.execution.task(task_id)?;
        if task.status != TaskStatus::Running {
            return Err("Subagent task must be running".into());
        }
        let chat_id = task.chat_id.clone();
        self.runtime_routes.insert(
            source_port,
            RuntimeRoute {
                task_id: task_id.to_owned(),
                chat_id: chat_id.clone(),
                parent_id: Some(parent_id.to_owned()),
                provider: Some(provider.to_owned()),
                account_id: Some(account_id.to_owned()),
                model: Some(model.to_owned()),
            },
        );
        self.persist()?;
        Ok(chat_id)
    }

    pub fn observe_pi_event(
        &mut self,
        source_port: u16,
        process_id: u32,
        session_id: Option<&str>,
        payload: &Value,
    ) -> Result<Option<AgentRun>, String> {
        let Some(mut route) = self.runtime_routes.get(&source_port).cloned() else {
            return Ok(None);
        };
        if process_id == 0 {
            return Err("Pi process identity is required".into());
        }
        if let Some(session_id) = session_id.map(str::trim).filter(|value| !value.is_empty()) {
            if route.chat_id != session_id {
                self.execution.bind_task_chat(&route.task_id, session_id)?;
                route.chat_id = session_id.to_owned();
                self.runtime_routes.insert(source_port, route.clone());
            }
        }
        let event = payload.get("event").unwrap_or(payload);
        let Some(kind) = event.get("type").and_then(Value::as_str) else {
            return Ok(None);
        };
        let active_id = self
            .registry
            .runs
            .iter()
            .rev()
            .find(|run| {
                run.task_id == route.task_id
                    && run.source_port == source_port
                    && !run.state.is_terminal()
            })
            .map(|run| run.id.clone());
        let observed = match kind {
            "agent_start" => {
                if let Some(active_id) = active_id {
                    self.registry.get(&active_id).cloned()
                } else {
                    let task = self.execution.task(&route.task_id)?;
                    let epoch = task
                        .epochs
                        .last()
                        .ok_or_else(|| "task has no active Execution Epoch".to_owned())?;
                    let provider = route.provider.as_deref().unwrap_or(&epoch.provider);
                    let account_id = route.account_id.as_deref().unwrap_or(&epoch.account_id);
                    let model = route.model.as_deref().unwrap_or(&epoch.model);
                    let continues_from = self
                        .registry
                        .runs
                        .iter()
                        .rev()
                        .find(|run| {
                            run.task_id == route.task_id
                                && run.parent_id == route.parent_id
                                && run.state.is_terminal()
                        })
                        .map(|run| run.id.clone());
                    let request = if let Some(parent_id) = route.parent_id.as_deref() {
                        StartAgentRun::child(
                            &route.chat_id,
                            &route.task_id,
                            &epoch.id,
                            parent_id,
                            provider,
                            account_id,
                            model,
                            process_id,
                        )
                    } else {
                        StartAgentRun::main(
                            &route.chat_id,
                            &route.task_id,
                            &epoch.id,
                            provider,
                            account_id,
                            model,
                            process_id,
                        )
                    }
                    .on_port(source_port)
                    .continues_from(continues_from);
                    Some(self.registry.start(request)?)
                }
            }
            "turn_start" | "auto_retry_start" => {
                if let Some(id) = active_id.as_deref() {
                    self.registry
                        .wait(id, AgentRunState::ModelWait, "provider response")?;
                }
                None
            }
            "tool_execution_start" => {
                if let Some(id) = active_id.as_deref() {
                    let action = event
                        .get("toolName")
                        .or_else(|| event.get("tool"))
                        .and_then(Value::as_str)
                        .unwrap_or("tool execution");
                    self.registry.wait(id, AgentRunState::ToolWait, action)?;
                }
                None
            }
            "message_update" | "tool_execution_update" | "tool_execution_end" | "turn_end" => {
                if let Some(id) = active_id.as_deref() {
                    self.registry.progress(id, kind, unix_millis())?;
                }
                None
            }
            "agent_end" => {
                let mut finished = None;
                if let Some(id) = active_id.as_deref() {
                    let failed = event.get("error").is_some_and(|value| !value.is_null())
                        || event.get("success").and_then(Value::as_bool) == Some(false);
                    self.registry.finish(
                        id,
                        if failed {
                            AgentRunState::Failed
                        } else {
                            AgentRunState::Completed
                        },
                        if failed {
                            "Pi agent failed"
                        } else {
                            "Pi agent completed"
                        },
                        unix_millis(),
                    )?;
                    finished = self.registry.get(id).cloned();
                }
                finished
            }
            _ => None,
        };
        self.persist()?;
        Ok(observed)
    }

    pub fn cancel_target(&self, run_id: &str) -> Result<AgentCancelTarget, String> {
        let run = self
            .registry
            .get(run_id)
            .ok_or_else(|| "Agent Run does not exist".to_owned())?;
        if run.state.is_terminal() {
            return Err("terminal Agent Run cannot be cancelled".into());
        }
        if run.source_port == 0 {
            return Err("Agent Run has no exact Pi source port".into());
        }
        Ok(AgentCancelTarget {
            run_id: run.id.clone(),
            source_port: run.source_port,
            process_id: run.process_id,
        })
    }

    pub fn sample_agent(
        &mut self,
        run_id: &str,
        sample: Option<ResourceSample>,
        process_owned: bool,
        at: u64,
    ) -> Result<(), String> {
        let Some(run) = self.registry.get(run_id) else {
            return Err("Agent Run does not exist".into());
        };
        if run.state.is_terminal() {
            return Ok(());
        }
        if !process_owned {
            self.registry.finish(
                run_id,
                AgentRunState::Terminated,
                "Pi process is no longer owned by this host",
                at,
            )?;
        } else {
            if let Some(sample) = sample {
                self.registry.record_sample(run_id, sample)?;
            }
            self.registry.assess_health(
                run_id,
                HealthSignals {
                    process_alive: true,
                    control_probe_ok: true,
                    now: at,
                    stall_after_ms: 120_000,
                },
            )?;
        }
        self.persist()
    }

    pub fn deactivate_account(
        &mut self,
        provider: &str,
        account_id: &str,
    ) -> Result<Vec<String>, String> {
        let affected = self.execution.disconnect_account(provider, account_id)?;
        let now = unix_millis();
        let active_runs: Vec<String> = self
            .registry
            .runs
            .iter()
            .filter(|run| {
                run.provider == provider && run.account_id == account_id && !run.state.is_terminal()
            })
            .map(|run| run.id.clone())
            .collect();
        for run_id in active_runs {
            self.registry.finish(
                &run_id,
                AgentRunState::Terminated,
                "provider account deactivated",
                now,
            )?;
        }
        self.persist()?;
        Ok(affected)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn start_agent(
        &mut self,
        task_id: &str,
        epoch_id: &str,
        provider: &str,
        account_id: &str,
        model: &str,
        process_id: u32,
        parent_id: Option<&str>,
    ) -> Result<AgentRun, String> {
        let task = self.execution.task(task_id)?;
        let request = match parent_id {
            Some(parent) => StartAgentRun::child(
                &task.chat_id,
                task_id,
                epoch_id,
                parent,
                provider,
                account_id,
                model,
                process_id,
            ),
            None => StartAgentRun::main(
                &task.chat_id,
                task_id,
                epoch_id,
                provider,
                account_id,
                model,
                process_id,
            ),
        };
        let run = self.registry.start(request)?;
        self.persist()?;
        Ok(run)
    }

    pub fn cancel_agent(&mut self, run_id: &str, reason: &str) -> Result<(), String> {
        self.registry
            .finish(run_id, AgentRunState::Cancelled, reason, unix_millis())?;
        self.persist()
    }

    pub fn handoff_account(
        &mut self,
        provider: &str,
        previous_account: &str,
        replacement_account: &str,
    ) -> Result<(), String> {
        self.deactivate_account(provider, previous_account)?;
        self.execution
            .handoff_account(provider, previous_account, replacement_account)?;
        self.persist()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn continue_task(
        &mut self,
        task_id: &str,
        command: &str,
        provider: &str,
        account_id: &str,
        channel: &str,
        model: &str,
    ) -> Result<(), String> {
        let task_provider = self
            .execution
            .task(task_id)?
            .epochs
            .last()
            .map(|epoch| epoch.provider.as_str())
            .unwrap_or_default();
        if task_provider != provider {
            return Err("replacement provider must match the suspended task".into());
        }
        self.execution
            .continue_with_account(task_id, command, account_id, channel, model)?;
        self.persist()
    }

    fn ensure_chat(&mut self, chat_id: &str) -> Result<(), String> {
        if !self.execution.chats.iter().any(|chat| chat.id == chat_id) {
            self.execution.create_chat(chat_id)?;
        }
        Ok(())
    }

    fn persist(&self) -> Result<(), String> {
        self.store.save(&self.execution)?;
        let encoded = serde_json::to_vec_pretty(&self.registry)
            .map_err(|error| format!("serialize Agent Run registry: {error}"))?;
        atomic_write(&self.root.join("agent-runs.json"), &encoded)
    }
}

fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, content).map_err(|error| format!("write staged task state: {error}"))?;
    fs::rename(&temporary, path).map_err(|error| format!("commit task state: {error}"))
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    #[test]
    fn public_task_control_persists_task_and_targets_exact_agent_run() {
        let root = std::env::temp_dir().join(format!("picode-task-control-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let mut control = TaskControl::open(&root, "machine-a").unwrap();
        let simple = control
            .create_simple("chat-a", "Discuss design", &root.join("scratch"))
            .unwrap();
        assert_eq!(simple.kind, crate::execution::TaskKind::Simple);
        let run = control
            .start_agent(
                &simple.id,
                "epoch-a",
                "codex",
                "account-a",
                "gpt-5",
                4_200,
                None,
            )
            .unwrap();
        control.cancel_agent(&run.id, "user cancelled").unwrap();
        assert_eq!(
            control.snapshot().agent_runs[0].state,
            crate::runtime_registry::AgentRunState::Cancelled
        );
        drop(control);

        let restored = TaskControl::open(&root, "machine-a").unwrap();
        assert_eq!(
            restored.snapshot().execution.tasks[0].goal,
            "Discuss design"
        );
        assert_eq!(restored.snapshot().agent_runs[0].id, run.id);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn harness_creation_requires_binding_and_account_handoff_waits_for_continue() {
        let root = std::env::temp_dir().join(format!("picode-task-control-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("workspace")).unwrap();
        let mut control = TaskControl::open(&root, "machine-a").unwrap();
        let workspace = control
            .register_workspace("windows", "D:\\old", None)
            .unwrap();
        assert!(control
            .create_harness("chat-a", "Build game", &workspace.id)
            .is_err());
        control
            .bind_workspace(&workspace.id, &root.join("workspace"))
            .unwrap();
        let task = control
            .create_harness("chat-a", "Build game", &workspace.id)
            .unwrap();
        control
            .start_task(&task.id, "codex", "account-a", "openai", "gpt-5")
            .unwrap();
        control
            .handoff_account("codex", "account-a", "account-b")
            .unwrap();
        assert!(control
            .continue_task(
                &task.id,
                "not continue",
                "codex",
                "account-b",
                "openai",
                "gpt-5"
            )
            .is_err());
        control
            .continue_task(&task.id, "继续", "codex", "account-b", "openai", "gpt-5")
            .unwrap();
        assert_eq!(control.snapshot().execution.tasks[0].epochs.len(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restart_recovery_keeps_only_observably_live_processes_running() {
        let root = std::env::temp_dir().join(format!("picode-task-control-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let mut control = TaskControl::open(&root, "machine-a").unwrap();
        let task = control
            .create_simple("chat-a", "Recover", &root.join("scratch"))
            .unwrap();
        let live = control
            .start_agent(
                &task.id,
                "epoch-a",
                "codex",
                "account-a",
                "gpt-5",
                std::process::id(),
                None,
            )
            .unwrap();
        drop(control);
        let restored = TaskControl::open(&root, "machine-a").unwrap();
        assert_eq!(
            restored
                .snapshot()
                .agent_runs
                .iter()
                .find(|run| run.id == live.id)
                .unwrap()
                .state,
            crate::runtime_registry::AgentRunState::Terminated,
            "a restarted host must not adopt a process merely because its PID still exists",
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn prompt_and_pi_events_drive_one_exact_runtime_run() {
        let root = std::env::temp_dir().join(format!("picode-task-control-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let mut control = TaskControl::open(&root, "machine-a").unwrap();
        let task = control
            .create_simple(
                "pending-chat",
                "Trace the real Pi run",
                &root.join("scratch"),
            )
            .unwrap();

        let activation = control
            .activate_prompt(
                &task.id,
                "pending-chat",
                "codex",
                "account-a",
                "openai-codex",
                "gpt-5",
                47_821,
                false,
            )
            .unwrap();
        assert_eq!(activation.task_id, task.id);

        let run = control
            .observe_pi_event(
                47_821,
                12_345,
                Some("D:/project/session-a.jsonl"),
                &serde_json::json!({ "type": "agent_start" }),
            )
            .unwrap()
            .expect("agent_start creates a visible Agent Run");
        assert_eq!(run.source_port, 47_821);
        assert_eq!(run.process_id, 12_345);
        assert_eq!(run.chat_id, "D:/project/session-a.jsonl");

        control
            .observe_pi_event(
                47_821,
                12_345,
                Some("D:/project/session-a.jsonl"),
                &serde_json::json!({ "type": "tool_execution_start", "toolName": "bash" }),
            )
            .unwrap();
        let observed = control
            .snapshot()
            .agent_runs
            .into_iter()
            .find(|candidate| candidate.id == run.id)
            .unwrap();
        assert_eq!(
            observed.state,
            crate::runtime_registry::AgentRunState::ToolWait
        );
        assert_eq!(observed.current_action, "bash");

        let ended = control
            .observe_pi_event(
                47_821,
                12_345,
                Some("D:/project/session-a.jsonl"),
                &serde_json::json!({ "type": "agent_end" }),
            )
            .unwrap()
            .expect("agent_end closes the current Agent Run");
        let continued = control
            .observe_pi_event(
                47_821,
                12_345,
                Some("D:/project/session-a.jsonl"),
                &serde_json::json!({ "type": "agent_start" }),
            )
            .unwrap()
            .expect("a later turn creates a new Agent Run");
        assert_ne!(continued.id, ended.id);
        assert_eq!(continued.continues_from.as_deref(), Some(ended.id.as_str()));

        control
            .activate_subagent_runtime(
                &task.id,
                &continued.id,
                47_822,
                "deepseek",
                "account-b",
                "deepseek-search",
            )
            .unwrap();
        let child = control
            .observe_pi_event(
                47_822,
                12_346,
                None,
                &serde_json::json!({ "type": "agent_start" }),
            )
            .unwrap()
            .expect("Subagent start creates an attributed child run");
        assert_eq!(child.parent_id.as_deref(), Some(continued.id.as_str()));
        assert_eq!(child.model, "deepseek-search");

        let cancel = control.cancel_target(&continued.id).unwrap();
        assert_eq!(cancel.source_port, 47_821);
        assert_eq!(cancel.process_id, 12_345);
        fs::remove_dir_all(root).unwrap();
    }
}
