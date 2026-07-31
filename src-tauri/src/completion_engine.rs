#![cfg_attr(not(test), allow(dead_code))]

use crate::harness::GateValidityResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateOutcome {
    pub gate_id: String,
    pub candidate_passed: bool,
    pub flaky: bool,
    pub validity: GateValidityResult,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionLevel {
    HarnessIncomplete,
    LocallyVerified,
    HarnessVerified,
    CiVerified,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionDecision {
    pub level: CompletionLevel,
    pub blockers: Vec<String>,
    pub flaky: bool,
    pub may_continue: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CiAttestation {
    pub trusted_adapter: bool,
    pub candidate_fingerprint: String,
    pub verified_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionRequest {
    pub gates: Vec<GateOutcome>,
    pub ci_attestation: Option<CiAttestation>,
    pub stop_attempt: u32,
    pub max_stop_attempts: u32,
}

pub struct CompletionEngine;

impl CompletionEngine {
    pub fn evaluate(gates: &[GateOutcome], ci_verified: bool) -> CompletionDecision {
        if gates.is_empty() {
            return CompletionDecision {
                level: CompletionLevel::HarnessIncomplete,
                blockers: vec!["Harness has no applicable Completion Gate".to_owned()],
                flaky: false,
                may_continue: true,
            };
        }
        let flaky = gates.iter().any(|gate| gate.flaky);
        let failed: Vec<String> = gates
            .iter()
            .filter(|gate| !gate.candidate_passed)
            .map(|gate| format!("{}: candidate did not pass", gate.gate_id))
            .collect();
        if !failed.is_empty() {
            return CompletionDecision {
                level: CompletionLevel::HarnessIncomplete,
                blockers: failed,
                flaky,
                may_continue: true,
            };
        }
        let invalid: Vec<String> = gates
            .iter()
            .filter(|gate| !gate.validity.red_capable)
            .map(|gate| format!("{}: {}", gate.gate_id, gate.validity.reason))
            .collect();
        if !invalid.is_empty() {
            return CompletionDecision {
                level: CompletionLevel::LocallyVerified,
                blockers: invalid,
                flaky,
                may_continue: false,
            };
        }
        CompletionDecision {
            level: if ci_verified {
                CompletionLevel::CiVerified
            } else {
                CompletionLevel::HarnessVerified
            },
            blockers: Vec::new(),
            flaky,
            may_continue: false,
        }
    }

    pub fn evaluate_request(request: &CompletionRequest) -> CompletionDecision {
        let mut decision = Self::evaluate(&request.gates, false);
        decision.may_continue = decision.level == CompletionLevel::HarnessIncomplete
            && request.stop_attempt < request.max_stop_attempts;
        if let Some(attestation) = &request.ci_attestation {
            if decision.level == CompletionLevel::HarnessVerified {
                if !attestation.trusted_adapter {
                    decision
                        .blockers
                        .push("untrusted CI adapter cannot issue ci_verified".to_owned());
                } else if attestation.candidate_fingerprint != attestation.verified_fingerprint {
                    decision
                        .blockers
                        .push("CI result belongs to a different candidate".to_owned());
                } else {
                    decision.level = CompletionLevel::CiVerified;
                }
            }
        }
        decision
    }
}

#[cfg(test)]
mod tests {
    use super::{CompletionEngine, CompletionLevel, GateOutcome};
    use crate::harness::{ActionExecution, GateValidityResult};

    fn passing_gate(validity: GateValidityResult) -> GateOutcome {
        GateOutcome {
            gate_id: "test".to_owned(),
            candidate_passed: true,
            flaky: false,
            validity,
        }
    }

    #[test]
    fn caller_cannot_claim_harness_verification_until_the_gate_proves_it_can_red() {
        let missing = CompletionEngine::evaluate(
            &[passing_gate(GateValidityResult::missing_probe("test"))],
            false,
        );
        assert_eq!(missing.level, CompletionLevel::LocallyVerified);
        assert_eq!(
            missing.blockers,
            vec!["test: gate has no declared controlled red probe"]
        );

        let red_capable = CompletionEngine::evaluate(
            &[passing_gate(GateValidityResult::from_probe(
                "test",
                "break-test",
                &ActionExecution {
                    action_id: "break-test".to_owned(),
                    exit_code: Some(1),
                    timed_out: false,
                    stdout: String::new(),
                    stderr: "expected failure".to_owned(),
                    output_truncated: false,
                    duration_ms: 5,
                },
            ))],
            false,
        );
        assert_eq!(red_capable.level, CompletionLevel::HarnessVerified);
        assert!(red_capable.blockers.is_empty());
    }

    #[test]
    fn untrusted_ci_and_exhausted_stop_retries_cannot_upgrade_completion() {
        let gate = passing_gate(GateValidityResult::from_probe(
            "test",
            "break-test",
            &ActionExecution {
                action_id: "break-test".to_owned(),
                exit_code: Some(1),
                timed_out: false,
                stdout: String::new(),
                stderr: "expected failure".to_owned(),
                output_truncated: false,
                duration_ms: 5,
            },
        ));
        let decision = CompletionEngine::evaluate_request(&super::CompletionRequest {
            gates: vec![gate],
            ci_attestation: Some(super::CiAttestation {
                trusted_adapter: false,
                candidate_fingerprint: "tree-a".into(),
                verified_fingerprint: "tree-a".into(),
            }),
            stop_attempt: 3,
            max_stop_attempts: 3,
        });
        assert_eq!(decision.level, CompletionLevel::HarnessVerified);
        assert!(!decision.may_continue);
        assert!(decision
            .blockers
            .iter()
            .any(|item| item.contains("untrusted CI")));
    }
}
