#![cfg_attr(not(test), allow(dead_code))]

use crate::extension_manager::ExtensionManager;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookConfig {
    pub id: String,
    pub event: String,
    pub executable: String,
    #[serde(default)]
    pub arguments: Vec<String>,
    pub cwd: String,
    pub timeout_ms: u64,
    #[serde(default)]
    pub fail_open: bool,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub trusted: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HookState {
    Skipped,
    Passed,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HookPoint {
    BeforeTool,
    AfterTool,
    Stop,
    SubagentStop,
}

impl HookPoint {
    fn event_name(self) -> &'static str {
        match self {
            Self::BeforeTool => "before_tool",
            Self::AfterTool => "after_tool",
            Self::Stop => "stop",
            Self::SubagentStop => "subagent_stop",
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookRequest {
    pub point: HookPoint,
    pub task_id: String,
    pub run_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookInvocation {
    pub point: HookPoint,
    pub outcomes: Vec<HookOutcome>,
    pub continue_work: bool,
    /// Hooks can veto or advise, but only CompletionEngine can verify a task.
    pub completion_authority: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookOutcome {
    pub hook_id: String,
    pub state: HookState,
    pub work_id: Option<String>,
    pub verification_allowed: bool,
    pub message: String,
}

impl HookOutcome {
    pub fn skipped(hook_id: &str, message: &str) -> Self {
        Self {
            hook_id: hook_id.into(),
            state: HookState::Skipped,
            work_id: None,
            verification_allowed: false,
            message: message.into(),
        }
    }

    pub fn failed(hook_id: &str, work_id: Option<String>, message: &str) -> Self {
        Self {
            hook_id: hook_id.into(),
            state: HookState::Failed,
            work_id,
            verification_allowed: false,
            message: message.into(),
        }
    }
}

/// Compatibility façade for hook call sites. It owns no state: all discovery,
/// enablement, trust and process facts live in ExtensionManager.
pub struct HookManager {
    extensions: Arc<ExtensionManager>,
}

impl HookManager {
    pub fn new(extensions: Arc<ExtensionManager>) -> Self {
        Self { extensions }
    }

    pub fn install(&self, config: HookConfig) -> Result<(), String> {
        self.extensions.install_hook(config)
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        self.extensions.set_hook_enabled(id, enabled)
    }

    pub fn set_trusted(&self, id: &str, trusted: bool) -> Result<(), String> {
        self.extensions.set_hook_trusted(id, trusted)
    }

    pub fn invoke(
        &self,
        event: &str,
        task_id: &str,
        run_id: &str,
    ) -> Result<Vec<HookOutcome>, String> {
        self.extensions.invoke_hooks(event, task_id, run_id)
    }

    pub fn invoke_point(&self, request: &HookRequest) -> Result<HookInvocation, String> {
        let outcomes = self.invoke(
            request.point.event_name(),
            &request.task_id,
            &request.run_id,
        )?;
        let continue_work = outcomes.iter().all(|outcome| {
            outcome.state != HookState::Failed || outcome.message.contains("may continue")
        });
        Ok(HookInvocation {
            point: request.point,
            outcomes,
            continue_work,
            completion_authority: false,
        })
    }

    pub fn list(&self) -> Result<Vec<HookConfig>, String> {
        self.extensions.hooks()
    }
}

#[cfg(test)]
mod tests {
    use super::{HookConfig, HookManager, HookPoint, HookRequest, HookState};
    use crate::extension_manager::ExtensionManager;
    use crate::orchestration_service::OrchestrationService;
    use crate::work_manager::WorkManager;
    use std::fs;
    use std::sync::Arc;

    #[test]
    #[ignore]
    fn failing_hook_fixture() {
        panic!("controlled hook failure");
    }

    #[test]
    fn disabled_and_untrusted_hooks_are_zero_process_and_fail_open_never_verifies() {
        let root = std::env::temp_dir().join(format!("picode-hooks-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let orchestration = Arc::new(OrchestrationService::open(&root.join("jobs"), 1024).unwrap());
        let work = Arc::new(WorkManager::new(orchestration));
        let extensions =
            Arc::new(ExtensionManager::open(&root.join("extensions"), work.clone()).unwrap());
        let hooks = HookManager::new(extensions);
        hooks
            .install(HookConfig {
                id: "stop-check".into(),
                event: "before_complete".into(),
                executable: std::env::current_exe()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                arguments: vec![
                    "--ignored".into(),
                    "--exact".into(),
                    "hook_manager::tests::failing_hook_fixture".into(),
                    "--nocapture".into(),
                ],
                cwd: root.to_string_lossy().into_owned(),
                timeout_ms: 5_000,
                fail_open: true,
                enabled: true,
                trusted: true,
            })
            .unwrap();
        assert!(work.snapshot().unwrap().is_empty());
        hooks.set_enabled("stop-check", true).unwrap();
        let untrusted = hooks.invoke("before_complete", "task-a", "run-a").unwrap();
        assert_eq!(untrusted[0].state, HookState::Failed);
        assert!(!untrusted[0].verification_allowed);
        hooks.set_trusted("stop-check", true).unwrap();
        let failed = hooks.invoke("before_complete", "task-a", "run-a").unwrap();
        assert_eq!(failed[0].state, HookState::Failed);
        assert!(!failed[0].verification_allowed);
        assert!(failed[0].message.contains("verification is blocked"));
        drop(hooks);
        drop(work);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn typed_hook_points_are_advisory_and_never_upgrade_completion_authority() {
        let root = std::env::temp_dir().join(format!("picode-hook-point-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let orchestration = Arc::new(OrchestrationService::open(&root.join("jobs"), 1024).unwrap());
        let work = Arc::new(WorkManager::new(orchestration));
        let extensions =
            Arc::new(ExtensionManager::open(&root.join("extensions"), work.clone()).unwrap());
        let hooks = HookManager::new(extensions);
        hooks
            .install(HookConfig {
                id: "stop-advice".into(),
                event: "stop".into(),
                executable: "unused".into(),
                arguments: Vec::new(),
                cwd: root.to_string_lossy().into_owned(),
                timeout_ms: 1_000,
                fail_open: true,
                enabled: false,
                trusted: false,
            })
            .unwrap();

        let result = hooks
            .invoke_point(&HookRequest {
                point: HookPoint::Stop,
                task_id: "task-a".into(),
                run_id: "run-a".into(),
            })
            .unwrap();

        assert_eq!(result.point, HookPoint::Stop);
        assert!(result.continue_work);
        assert!(!result.completion_authority);
        assert_eq!(result.outcomes[0].state, HookState::Skipped);
        drop(hooks);
        drop(work);
        fs::remove_dir_all(root).unwrap();
    }
}
