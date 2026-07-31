#![cfg_attr(not(test), allow(dead_code))]

use crate::execution::TaskKind;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuidanceMode {
    Lean,
    Adaptive,
    Guided,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuidanceLevel {
    Lean,
    Structured,
    Guided,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanDecision {
    Direct,
    RequestApproval,
    Required,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelGuidanceProfile {
    pub evaluated_autonomy: u8,
    pub tool_reliability: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuidanceSignal {
    Ambiguity,
    GateFailure,
    RepeatedError,
    ContextOmission,
    UserRequestedPlanning,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuidanceRequest {
    pub task_kind: TaskKind,
    pub mode: GuidanceMode,
    pub model: ModelGuidanceProfile,
    #[serde(default)]
    pub signals: Vec<GuidanceSignal>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuidanceDecision {
    pub level: GuidanceLevel,
    pub plan: PlanDecision,
    pub assurance_required: bool,
    pub prompt_sections: Vec<String>,
    pub reasons: Vec<String>,
}

pub struct GuidancePolicy;

impl GuidancePolicy {
    pub fn decide(request: &GuidanceRequest) -> GuidanceDecision {
        let ambiguity = request.signals.contains(&GuidanceSignal::Ambiguity);
        let gate_failure = request.signals.contains(&GuidanceSignal::GateFailure);
        let repeated_error = request.signals.contains(&GuidanceSignal::RepeatedError);
        let context_omission = request.signals.contains(&GuidanceSignal::ContextOmission);
        let user_requested_planning = request
            .signals
            .contains(&GuidanceSignal::UserRequestedPlanning);
        let needs_model_support =
            request.model.evaluated_autonomy < 70 || request.model.tool_reliability < 70;
        let (level, plan, prompt_sections, reasons) = match request.mode {
            GuidanceMode::Guided => (
                GuidanceLevel::Guided,
                PlanDecision::Required,
                vec!["plan".into(), "checklist".into()],
                vec!["guided_mode".into()],
            ),
            GuidanceMode::Adaptive if user_requested_planning => (
                GuidanceLevel::Structured,
                PlanDecision::Required,
                vec!["plan".into()],
                vec!["user_requested_planning".into()],
            ),
            GuidanceMode::Adaptive if repeated_error && context_omission => (
                GuidanceLevel::Guided,
                PlanDecision::RequestApproval,
                vec![
                    "plan".into(),
                    "context_recovery".into(),
                    "task_checklist".into(),
                ],
                vec!["repeated_error".into(), "context_omission".into()],
            ),
            GuidanceMode::Adaptive if ambiguity => (
                GuidanceLevel::Structured,
                PlanDecision::RequestApproval,
                vec!["plan".into()],
                vec!["ambiguity".into()],
            ),
            GuidanceMode::Adaptive if gate_failure => (
                GuidanceLevel::Structured,
                PlanDecision::Direct,
                vec!["validation_recovery".into()],
                vec!["gate_failure".into()],
            ),
            GuidanceMode::Adaptive if needs_model_support => (
                GuidanceLevel::Structured,
                PlanDecision::Direct,
                vec!["task_checklist".into()],
                vec!["evaluated_model_support".into()],
            ),
            GuidanceMode::Lean | GuidanceMode::Adaptive => (
                GuidanceLevel::Lean,
                PlanDecision::Direct,
                Vec::new(),
                Vec::new(),
            ),
        };
        GuidanceDecision {
            level,
            plan,
            assurance_required: request.task_kind == TaskKind::Harness,
            prompt_sections,
            reasons,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        GuidanceLevel, GuidanceMode, GuidancePolicy, GuidanceRequest, GuidanceSignal,
        ModelGuidanceProfile, PlanDecision,
    };
    use crate::execution::TaskKind;

    #[test]
    fn capable_model_starts_lean_without_losing_harness_assurance() {
        let decision = GuidancePolicy::decide(&GuidanceRequest {
            task_kind: TaskKind::Harness,
            mode: GuidanceMode::Adaptive,
            model: ModelGuidanceProfile {
                evaluated_autonomy: 95,
                tool_reliability: 95,
            },
            signals: Vec::new(),
        });

        assert_eq!(decision.level, GuidanceLevel::Lean);
        assert_eq!(decision.plan, PlanDecision::Direct);
        assert!(decision.assurance_required);
        assert!(decision.prompt_sections.is_empty());
    }

    #[test]
    fn adaptive_guidance_requests_plan_approval_only_after_real_ambiguity() {
        let decision = GuidancePolicy::decide(&GuidanceRequest {
            task_kind: TaskKind::Harness,
            mode: GuidanceMode::Adaptive,
            model: ModelGuidanceProfile {
                evaluated_autonomy: 95,
                tool_reliability: 95,
            },
            signals: vec![GuidanceSignal::Ambiguity],
        });

        assert_eq!(decision.level, GuidanceLevel::Structured);
        assert_eq!(decision.plan, PlanDecision::RequestApproval);
        assert_eq!(decision.prompt_sections, vec!["plan"]);
        assert_eq!(decision.reasons, vec!["ambiguity"]);
    }

    #[test]
    fn gate_failure_adds_recovery_guidance_without_forcing_a_new_plan() {
        let decision = GuidancePolicy::decide(&GuidanceRequest {
            task_kind: TaskKind::Harness,
            mode: GuidanceMode::Adaptive,
            model: ModelGuidanceProfile {
                evaluated_autonomy: 95,
                tool_reliability: 95,
            },
            signals: vec![GuidanceSignal::GateFailure],
        });

        assert_eq!(decision.level, GuidanceLevel::Structured);
        assert_eq!(decision.plan, PlanDecision::Direct);
        assert_eq!(decision.prompt_sections, vec!["validation_recovery"]);
        assert_eq!(decision.reasons, vec!["gate_failure"]);
        assert!(decision.assurance_required);
    }

    #[test]
    fn evaluated_lower_autonomy_adds_a_checklist_but_not_mandatory_planning() {
        let decision = GuidancePolicy::decide(&GuidanceRequest {
            task_kind: TaskKind::Harness,
            mode: GuidanceMode::Adaptive,
            model: ModelGuidanceProfile {
                evaluated_autonomy: 55,
                tool_reliability: 70,
            },
            signals: Vec::new(),
        });

        assert_eq!(decision.level, GuidanceLevel::Structured);
        assert_eq!(decision.plan, PlanDecision::Direct);
        assert_eq!(decision.prompt_sections, vec!["task_checklist"]);
        assert_eq!(decision.reasons, vec!["evaluated_model_support"]);
    }

    #[test]
    fn repeated_error_and_context_omission_escalate_to_guided_adjustment() {
        let decision = GuidancePolicy::decide(&GuidanceRequest {
            task_kind: TaskKind::Harness,
            mode: GuidanceMode::Adaptive,
            model: ModelGuidanceProfile {
                evaluated_autonomy: 95,
                tool_reliability: 95,
            },
            signals: vec![
                GuidanceSignal::RepeatedError,
                GuidanceSignal::ContextOmission,
            ],
        });

        assert_eq!(decision.level, GuidanceLevel::Guided);
        assert_eq!(decision.plan, PlanDecision::RequestApproval);
        assert_eq!(
            decision.prompt_sections,
            vec!["plan", "context_recovery", "task_checklist"]
        );
        assert_eq!(decision.reasons, vec!["repeated_error", "context_omission"]);
    }

    #[test]
    fn explicit_user_planning_request_is_honored_without_changing_assurance_policy() {
        let decision = GuidancePolicy::decide(&GuidanceRequest {
            task_kind: TaskKind::Simple,
            mode: GuidanceMode::Adaptive,
            model: ModelGuidanceProfile {
                evaluated_autonomy: 99,
                tool_reliability: 99,
            },
            signals: vec![GuidanceSignal::UserRequestedPlanning],
        });
        assert_eq!(decision.level, GuidanceLevel::Structured);
        assert_eq!(decision.plan, PlanDecision::Required);
        assert_eq!(decision.prompt_sections, ["plan"]);
        assert!(!decision.assurance_required);
    }
}
