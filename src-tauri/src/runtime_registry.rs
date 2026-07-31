#![cfg_attr(not(test), allow(dead_code))]

use crate::resource_sampler::NormalizedUsage;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentRunState {
    Starting,
    Running,
    ModelWait,
    ToolWait,
    UserWait,
    PermissionWait,
    SuspectedStall,
    Unresponsive,
    Completed,
    Failed,
    Cancelled,
    Terminated,
}

impl AgentRunState {
    pub(crate) fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::Terminated
        )
    }

    fn is_known_wait(self) -> bool {
        matches!(
            self,
            Self::ModelWait | Self::ToolWait | Self::UserWait | Self::PermissionWait
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MetricAttribution {
    ProcessOwned,
    Shared,
    Estimated,
    ProviderReported,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSample {
    pub at: u64,
    pub cpu_percent: f32,
    pub memory_bytes: u64,
    pub uptime_ms: u64,
    pub attribution: MetricAttribution,
}

impl ResourceSample {
    pub fn shared(at: u64, cpu_percent: f32, memory_bytes: u64, uptime_ms: u64) -> Self {
        Self {
            at,
            cpu_percent,
            memory_bytes,
            uptime_ms,
            attribution: MetricAttribution::Shared,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HealthSignals {
    pub process_alive: bool,
    pub control_probe_ok: bool,
    pub now: u64,
    pub stall_after_ms: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    pub id: String,
    pub chat_id: String,
    pub task_id: String,
    pub epoch_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continues_from: Option<String>,
    pub provider: String,
    pub account_id: String,
    pub model: String,
    pub process_id: u32,
    #[serde(default)]
    pub source_port: u16,
    pub state: AgentRunState,
    pub current_action: String,
    pub started_at: u64,
    pub last_progress_at: u64,
    #[serde(default)]
    pub samples: Vec<ResourceSample>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<NormalizedUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub termination_result: Option<String>,
}

#[derive(Clone, Debug)]
pub struct StartAgentRun {
    chat_id: String,
    task_id: String,
    epoch_id: String,
    parent_id: Option<String>,
    continues_from: Option<String>,
    provider: String,
    account_id: String,
    model: String,
    process_id: u32,
    source_port: u16,
}

impl StartAgentRun {
    #[allow(clippy::too_many_arguments)]
    pub fn main(
        chat_id: &str,
        task_id: &str,
        epoch_id: &str,
        provider: &str,
        account_id: &str,
        model: &str,
        process_id: u32,
    ) -> Self {
        Self::new(
            chat_id, task_id, epoch_id, None, provider, account_id, model, process_id,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn child(
        chat_id: &str,
        task_id: &str,
        epoch_id: &str,
        parent_id: &str,
        provider: &str,
        account_id: &str,
        model: &str,
        process_id: u32,
    ) -> Self {
        Self::new(
            chat_id,
            task_id,
            epoch_id,
            Some(parent_id.to_owned()),
            provider,
            account_id,
            model,
            process_id,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn new(
        chat_id: &str,
        task_id: &str,
        epoch_id: &str,
        parent_id: Option<String>,
        provider: &str,
        account_id: &str,
        model: &str,
        process_id: u32,
    ) -> Self {
        Self {
            chat_id: chat_id.to_owned(),
            task_id: task_id.to_owned(),
            epoch_id: epoch_id.to_owned(),
            parent_id,
            continues_from: None,
            provider: provider.to_owned(),
            account_id: account_id.to_owned(),
            model: model.to_owned(),
            process_id,
            source_port: 0,
        }
    }

    pub fn on_port(mut self, source_port: u16) -> Self {
        self.source_port = source_port;
        self
    }

    pub fn continues_from(mut self, run_id: Option<String>) -> Self {
        self.continues_from = run_id;
        self
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRegistry {
    pub runs: Vec<AgentRun>,
}

impl AgentRunRegistry {
    pub fn start(&mut self, request: StartAgentRun) -> Result<AgentRun, String> {
        if [
            request.chat_id.as_str(),
            request.task_id.as_str(),
            request.epoch_id.as_str(),
            request.provider.as_str(),
            request.account_id.as_str(),
            request.model.as_str(),
        ]
        .iter()
        .any(|value| value.trim().is_empty())
            || request.process_id == 0
        {
            return Err("Agent Run identity and process are required".into());
        }
        if let Some(parent_id) = request.parent_id.as_deref() {
            let parent = self
                .get(parent_id)
                .ok_or_else(|| "parent Agent Run does not exist".to_owned())?;
            if parent.task_id != request.task_id {
                return Err("child Agent Run must belong to its parent task".into());
            }
        }
        if let Some(previous_id) = request.continues_from.as_deref() {
            let previous = self
                .get(previous_id)
                .ok_or_else(|| "continued Agent Run does not exist".to_owned())?;
            if previous.task_id != request.task_id || !previous.state.is_terminal() {
                return Err(
                    "continued Agent Run must be terminal and belong to the same task".into(),
                );
            }
        }
        let now = unix_millis();
        let run = AgentRun {
            id: Uuid::new_v4().to_string(),
            chat_id: request.chat_id,
            task_id: request.task_id,
            epoch_id: request.epoch_id,
            parent_id: request.parent_id,
            continues_from: request.continues_from,
            provider: request.provider,
            account_id: request.account_id,
            model: request.model,
            process_id: request.process_id,
            source_port: request.source_port,
            state: AgentRunState::Running,
            current_action: "starting".to_owned(),
            started_at: now,
            last_progress_at: now,
            samples: Vec::new(),
            usage: None,
            termination_result: None,
        };
        self.runs.push(run.clone());
        Ok(run)
    }

    pub fn get(&self, id: &str) -> Option<&AgentRun> {
        self.runs.iter().find(|run| run.id == id)
    }

    pub fn wait(&mut self, id: &str, state: AgentRunState, action: &str) -> Result<(), String> {
        if !matches!(
            state,
            AgentRunState::ModelWait
                | AgentRunState::ToolWait
                | AgentRunState::UserWait
                | AgentRunState::PermissionWait
        ) {
            return Err("wait state must name the blocking reason".into());
        }
        let run = self.run_mut(id)?;
        if run.state.is_terminal() {
            return Err("terminal Agent Run cannot wait".into());
        }
        run.state = state;
        run.current_action = action.to_owned();
        Ok(())
    }

    pub fn progress(&mut self, id: &str, action: &str, at: u64) -> Result<(), String> {
        let run = self.run_mut(id)?;
        if run.state.is_terminal() {
            return Err("terminal Agent Run cannot report progress".into());
        }
        run.state = AgentRunState::Running;
        run.current_action = action.to_owned();
        run.last_progress_at = at;
        Ok(())
    }

    pub fn finish(
        &mut self,
        id: &str,
        state: AgentRunState,
        result: &str,
        at: u64,
    ) -> Result<(), String> {
        if !state.is_terminal() {
            return Err("Agent Run finish requires a terminal state".into());
        }
        let run = self.run_mut(id)?;
        if run.state.is_terminal() {
            return Err("Agent Run is already terminal".into());
        }
        run.state = state;
        run.current_action = "finished".to_owned();
        run.last_progress_at = at;
        run.termination_result = Some(result.to_owned());
        Ok(())
    }

    pub fn record_sample(&mut self, id: &str, sample: ResourceSample) -> Result<(), String> {
        const MAX_SAMPLES: usize = 120;
        let run = self.run_mut(id)?;
        run.samples.push(sample);
        if run.samples.len() > MAX_SAMPLES {
            let overflow = run.samples.len() - MAX_SAMPLES;
            run.samples.drain(..overflow);
        }
        Ok(())
    }

    pub fn record_usage(&mut self, id: &str, usage: NormalizedUsage) -> Result<(), String> {
        self.run_mut(id)?.usage = Some(usage);
        Ok(())
    }

    pub fn assess_health(&mut self, id: &str, signals: HealthSignals) -> Result<(), String> {
        let run = self.run_mut(id)?;
        if run.state.is_terminal() {
            return Ok(());
        }
        if !signals.process_alive || !signals.control_probe_ok {
            run.state = AgentRunState::Unresponsive;
            run.current_action = "control probe unavailable".to_owned();
            return Ok(());
        }
        if run.state.is_known_wait() {
            return Ok(());
        }
        if signals.now.saturating_sub(run.last_progress_at) >= signals.stall_after_ms {
            run.state = AgentRunState::SuspectedStall;
            run.current_action = "no progress signal within threshold".to_owned();
        } else {
            run.state = AgentRunState::Running;
        }
        Ok(())
    }

    pub fn reconcile_after_restart<F>(&mut self, process_alive: F, at: u64)
    where
        F: Fn(u32) -> bool,
    {
        for run in &mut self.runs {
            if !run.state.is_terminal() && !process_alive(run.process_id) {
                run.state = AgentRunState::Terminated;
                run.current_action = "process unavailable after restart".to_owned();
                run.last_progress_at = at;
                run.termination_result = Some("process not alive".to_owned());
            }
        }
    }

    fn run_mut(&mut self, id: &str) -> Result<&mut AgentRun, String> {
        self.runs
            .iter_mut()
            .find(|run| run.id == id)
            .ok_or_else(|| "Agent Run does not exist".to_owned())
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
    use super::{AgentRunRegistry, AgentRunState, StartAgentRun};

    #[test]
    fn registry_tracks_agent_identity_and_reconciles_dead_processes_without_pid_ambiguity() {
        let mut registry = AgentRunRegistry::default();
        let main = registry
            .start(StartAgentRun::main(
                "chat-a",
                "task-a",
                "epoch-a",
                "codex",
                "account-a",
                "gpt-5",
                4_200,
            ))
            .unwrap();
        let child = registry
            .start(StartAgentRun::child(
                "chat-a",
                "task-a",
                "epoch-a",
                &main.id,
                "deepseek",
                "account-d",
                "search",
                4_200,
            ))
            .unwrap();

        registry
            .wait(&child.id, AgentRunState::ToolWait, "searching files")
            .unwrap();
        registry
            .progress(&main.id, "editing execution.rs", 1_010)
            .unwrap();
        registry.reconcile_after_restart(|pid| pid != 4_200, 1_100);

        assert_eq!(
            registry.get(&main.id).unwrap().state,
            AgentRunState::Terminated
        );
        assert_eq!(
            registry.get(&child.id).unwrap().state,
            AgentRunState::Terminated
        );
        assert_eq!(
            registry.get(&child.id).unwrap().parent_id.as_deref(),
            Some(main.id.as_str())
        );
        assert_ne!(main.id, child.id);
    }

    #[test]
    fn samples_are_bounded_and_wait_reasons_prevent_false_stall_diagnosis() {
        let mut registry = AgentRunRegistry::default();
        let run = registry
            .start(StartAgentRun::main(
                "chat", "task", "epoch", "codex", "account", "gpt-5", 9_100,
            ))
            .unwrap();
        for index in 0..150 {
            registry
                .record_sample(
                    &run.id,
                    super::ResourceSample::shared(index, 0.0, 256 * 1024 * 1024, index),
                )
                .unwrap();
        }
        registry
            .wait(&run.id, AgentRunState::ModelWait, "provider response")
            .unwrap();
        registry
            .assess_health(
                &run.id,
                super::HealthSignals {
                    process_alive: true,
                    control_probe_ok: true,
                    now: 50_000,
                    stall_after_ms: 1_000,
                },
            )
            .unwrap();

        let observed = registry.get(&run.id).unwrap();
        assert_eq!(observed.samples.len(), 120);
        assert_eq!(observed.samples[0].at, 30);
        assert_eq!(
            observed.samples[0].attribution,
            super::MetricAttribution::Shared
        );
        assert_eq!(observed.state, AgentRunState::ModelWait);

        registry.progress(&run.id, "no known wait", 1).unwrap();
        registry
            .assess_health(
                &run.id,
                super::HealthSignals {
                    process_alive: true,
                    control_probe_ok: true,
                    now: 50_000,
                    stall_after_ms: 1_000,
                },
            )
            .unwrap();
        assert_eq!(
            registry.get(&run.id).unwrap().state,
            AgentRunState::SuspectedStall
        );
        assert!(registry.get(&run.id).unwrap().termination_result.is_none());
    }

    #[test]
    fn usage_is_attached_to_the_exact_agent_run_with_provider_attribution() {
        let mut registry = AgentRunRegistry::default();
        let run = registry
            .start(StartAgentRun::main(
                "chat", "task", "epoch", "codex", "account", "gpt-5", 9_100,
            ))
            .unwrap();
        let usage =
            crate::resource_sampler::normalize_usage(crate::resource_sampler::ProviderUsage {
                requests: Some(1),
                input_tokens: Some(20),
                output_tokens: Some(5),
                cost_micros: None,
            });
        registry.record_usage(&run.id, usage.clone()).unwrap();
        assert_eq!(registry.get(&run.id).unwrap().usage.as_ref(), Some(&usage));
    }
}
