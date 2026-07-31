use crate::completion_engine::{
    CompletionDecision, CompletionEngine, CompletionRequest, GateOutcome,
};
use crate::harness::HarnessProfile;
use crate::harness_service::HarnessService;
use crate::hook_manager::{HookManager, HookState};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::Mutex;

pub struct CompletionCoordinator {
    attempts: Mutex<HashMap<String, u32>>,
    max_attempts: u32,
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::CompletionCoordinator;
    use crate::completion_engine::CompletionLevel;
    use crate::extension_manager::ExtensionManager;
    use crate::harness::{ActionKind, ActionRisk, CompletionGate, HarnessAction, HarnessProfile};
    use crate::harness_service::HarnessService;
    use crate::hook_manager::HookManager;
    use crate::orchestration_service::OrchestrationService;
    use crate::work_manager::WorkManager;
    use std::fs;
    use std::sync::Arc;

    #[test]
    #[ignore]
    fn passing_gate_fixture() {}

    #[test]
    #[ignore]
    fn failing_red_probe_fixture() {
        panic!("controlled red probe");
    }

    #[tokio::test]
    async fn confirmed_harness_is_evaluated_automatically_with_its_red_probe() {
        let root = std::env::temp_dir().join(format!(
            "picode-completion-coordinator-{}",
            uuid::Uuid::new_v4()
        ));
        let workspace = root.join("workspace");
        fs::create_dir_all(workspace.join(".picode")).unwrap();
        let executable = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let test_args = |name: &str| {
            vec![
                "--ignored".into(),
                "--exact".into(),
                name.into(),
                "--nocapture".into(),
            ]
        };
        let profile = HarnessProfile {
            schema_version: 1,
            actions: vec![
                HarnessAction {
                    id: "test".into(),
                    kind: ActionKind::Shell,
                    program: executable.clone(),
                    args: test_args("completion_coordinator::tests::passing_gate_fixture"),
                    parameters: Vec::new(),
                    cwd: ".".into(),
                    timeout_ms: 10_000,
                    risk: ActionRisk::ReadOnly,
                    depends_on: Vec::new(),
                },
                HarnessAction {
                    id: "break-test".into(),
                    kind: ActionKind::Shell,
                    program: executable,
                    args: test_args("completion_coordinator::tests::failing_red_probe_fixture"),
                    parameters: Vec::new(),
                    cwd: ".".into(),
                    timeout_ms: 10_000,
                    risk: ActionRisk::ReadOnly,
                    depends_on: Vec::new(),
                },
            ],
            gates: vec![CompletionGate {
                id: "gate.test".into(),
                action_id: "test".into(),
                path_prefixes: Vec::new(),
                red_probe_action_id: Some("break-test".into()),
            }],
            slots: Vec::new(),
        };
        fs::write(
            workspace.join(".picode").join("harness.jsonc"),
            serde_json::to_vec_pretty(&profile).unwrap(),
        )
        .unwrap();
        let orchestration =
            Arc::new(OrchestrationService::open(&root.join("orchestration"), 4096).unwrap());
        let work = Arc::new(WorkManager::new(orchestration));
        let extensions = Arc::new(ExtensionManager::open(&root.join("extensions"), work).unwrap());
        let hooks = HookManager::new(extensions);
        let harness = HarnessService::new(root.join("harness"), Some([7; 32])).unwrap();
        let decision = CompletionCoordinator::new(2)
            .evaluate("task-a", "run-a", &workspace, &harness, &hooks)
            .await
            .unwrap();
        assert_eq!(decision.level, CompletionLevel::HarnessVerified);
        assert!(decision.blockers.is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}

impl CompletionCoordinator {
    pub fn new(max_attempts: u32) -> Self {
        Self {
            attempts: Mutex::new(HashMap::new()),
            max_attempts: max_attempts.max(1),
        }
    }

    pub async fn evaluate(
        &self,
        task_id: &str,
        run_id: &str,
        workspace: &Path,
        harness: &HarnessService,
        hooks: &HookManager,
    ) -> Result<CompletionDecision, String> {
        let review = harness.review(task_id, workspace)?;
        let Some(profile) = review.profile else {
            return Err("Harness Task has no confirmed Harness Profile".to_owned());
        };
        let hook_outcomes = hooks.invoke("before_complete", task_id, run_id)?;
        let mut blockers = hook_outcomes
            .iter()
            .filter(|outcome| outcome.state == HookState::Failed)
            .map(|outcome| format!("hook {}: {}", outcome.hook_id, outcome.message))
            .collect::<Vec<_>>();
        let mut gates = Vec::new();
        for gate in &profile.gates {
            match self
                .evaluate_gate(task_id, workspace, &profile, gate, harness)
                .await
            {
                Ok(outcome) => gates.push(outcome),
                Err(error) => blockers.push(format!("{}: {error}", gate.id)),
            }
        }
        let stop_attempt = *self
            .attempts
            .lock()
            .map_err(|_| "Completion attempt state is poisoned".to_owned())?
            .get(task_id)
            .unwrap_or(&0);
        let mut decision = CompletionEngine::evaluate_request(&CompletionRequest {
            gates,
            ci_attestation: None,
            stop_attempt,
            max_stop_attempts: self.max_attempts,
        });
        if !blockers.is_empty() {
            decision.level = crate::completion_engine::CompletionLevel::HarnessIncomplete;
            decision.blockers.extend(blockers);
            decision.may_continue = stop_attempt < self.max_attempts;
        }
        let verified = matches!(
            decision.level,
            crate::completion_engine::CompletionLevel::HarnessVerified
                | crate::completion_engine::CompletionLevel::CiVerified
        );
        let mut attempts = self
            .attempts
            .lock()
            .map_err(|_| "Completion attempt state is poisoned".to_owned())?;
        if verified {
            attempts.remove(task_id);
        } else {
            attempts.insert(task_id.to_owned(), stop_attempt.saturating_add(1));
        }
        Ok(decision)
    }

    async fn evaluate_gate(
        &self,
        task_id: &str,
        workspace: &Path,
        profile: &HarnessProfile,
        gate: &crate::harness::CompletionGate,
        harness: &HarnessService,
    ) -> Result<GateOutcome, String> {
        if !profile
            .actions
            .iter()
            .any(|action| action.id == gate.action_id)
        {
            return Err("Gate action is missing from the confirmed Profile".to_owned());
        }
        let candidate = harness
            .run_action(task_id, workspace, &gate.action_id, &BTreeMap::new(), false)
            .await?;
        let validity = harness
            .validate_gate(task_id, workspace, &gate.id, false)
            .await?;
        Ok(GateOutcome {
            gate_id: gate.id.clone(),
            candidate_passed: candidate.passed,
            flaky: false,
            validity: validity.validity,
        })
    }
}
