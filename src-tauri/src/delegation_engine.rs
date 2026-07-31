#![cfg_attr(not(test), allow(dead_code))]

use crate::orchestration::{
    route_delegation, DelegatedWork, RoutingDecision, RoutingEvaluations, SubagentModelPolicy,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DelegationRuntime {
    PicodeTask,
    PiSubagents,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DelegationIsolation {
    SharedReadOnly,
    SafeWorktree,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationPlan {
    pub runtime: DelegationRuntime,
    pub isolation: DelegationIsolation,
    pub routing: RoutingDecision,
    pub requires_parent_review: bool,
    pub effective_tools: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationOptions {
    pub advanced_workflow: bool,
    pub current_depth: u32,
    pub max_depth: u32,
    pub parent_tools: Vec<String>,
    #[serde(default)]
    pub parent_permissions: Vec<String>,
}

pub struct DelegationEngine;

impl DelegationEngine {
    pub fn plan(
        work: &DelegatedWork,
        policy: &SubagentModelPolicy,
        evaluations: &RoutingEvaluations,
        advanced_workflow: bool,
    ) -> Result<DelegationPlan, String> {
        Self::plan_with_options(
            work,
            policy,
            evaluations,
            &DelegationOptions {
                advanced_workflow,
                current_depth: 0,
                max_depth: 1,
                parent_tools: work.envelope.tools.iter().cloned().collect(),
                parent_permissions: work.envelope.permissions.iter().cloned().collect(),
            },
        )
    }

    pub fn plan_with_options(
        work: &DelegatedWork,
        policy: &SubagentModelPolicy,
        evaluations: &RoutingEvaluations,
        options: &DelegationOptions,
    ) -> Result<DelegationPlan, String> {
        if options.current_depth >= options.max_depth {
            return Err("Subagent nesting budget is exhausted".to_owned());
        }
        let parent_tools = options
            .parent_tools
            .iter()
            .collect::<std::collections::BTreeSet<_>>();
        if work
            .envelope
            .tools
            .iter()
            .any(|tool| !parent_tools.contains(tool))
        {
            return Err("Subagent cannot expand the parent tool capability".to_owned());
        }
        let parent_permissions = options
            .parent_permissions
            .iter()
            .collect::<std::collections::BTreeSet<_>>();
        if work
            .envelope
            .permissions
            .iter()
            .any(|permission| !parent_permissions.contains(permission))
        {
            return Err("Subagent cannot expand the parent permission capability".to_owned());
        }
        let routing = route_delegation(work, policy, evaluations)?;
        Ok(DelegationPlan {
            runtime: if options.advanced_workflow {
                DelegationRuntime::PiSubagents
            } else {
                DelegationRuntime::PicodeTask
            },
            isolation: if work.requires_write {
                DelegationIsolation::SafeWorktree
            } else {
                DelegationIsolation::SharedReadOnly
            },
            routing,
            requires_parent_review: true,
            effective_tools: work.envelope.tools.iter().cloned().collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{DelegationEngine, DelegationIsolation, DelegationRuntime};
    use crate::orchestration::{
        DelegatedWork, DelegationEnvelope, ModelCandidate, ModelFallback, RoutingEvaluations,
        SubagentModelPolicy,
    };
    use std::collections::BTreeSet;

    #[test]
    fn caller_gets_pi_subagents_and_a_safe_worktree_for_qualified_writes() {
        let work = DelegatedWork {
            class: "implementation".to_owned(),
            envelope: DelegationEnvelope {
                goal: "implement parser".to_owned(),
                scope: vec!["src/parser.rs".to_owned()],
                method: "small verified patch".to_owned(),
                tools: BTreeSet::from(["read".to_owned(), "edit".to_owned()]),
                permissions: BTreeSet::from(["workspace.write".to_owned()]),
                context: vec!["parser contract".to_owned()],
                stop_conditions: vec!["focused tests pass".to_owned()],
                expected_result: "patch and test evidence".to_owned(),
            },
            requires_write: true,
            uses_secret: false,
            destructive: false,
            ambiguous: false,
            independently_verifiable: true,
            context_bytes: 2048,
        };
        let policy = SubagentModelPolicy {
            candidates: vec![ModelCandidate::new(
                "codex/account-a/gpt-5.6",
                10,
                10,
                3,
                true,
            )],
            fallback: ModelFallback::Ask,
        };
        let evaluations =
            RoutingEvaluations::qualified("implementation", &["codex/account-a/gpt-5.6"]);

        let plan = DelegationEngine::plan(&work, &policy, &evaluations, true).unwrap();
        assert_eq!(plan.runtime, DelegationRuntime::PiSubagents);
        assert_eq!(plan.isolation, DelegationIsolation::SafeWorktree);
        assert_eq!(plan.routing.model_id, "codex/account-a/gpt-5.6");
        assert!(plan.requires_parent_review);
    }

    #[test]
    fn child_cannot_expand_parent_tools_or_bypass_the_default_depth_limit() {
        let mut work = {
            let envelope = DelegationEnvelope {
                goal: "inspect".into(),
                scope: vec!["src".into()],
                method: "read".into(),
                tools: BTreeSet::from(["read".to_owned(), "edit".to_owned()]),
                permissions: BTreeSet::from(["workspace.read".to_owned()]),
                context: vec!["symbol".into()],
                stop_conditions: vec!["listed".into()],
                expected_result: "report".into(),
            };
            DelegatedWork::read_only_search("repository-search", envelope)
        };
        let policy = SubagentModelPolicy {
            candidates: vec![ModelCandidate::new("codex/a/cheap", 8, 8, 1, true)],
            fallback: ModelFallback::Ask,
        };
        let evaluations = RoutingEvaluations::qualified("repository-search", &["codex/a/cheap"]);
        let options = super::DelegationOptions {
            advanced_workflow: false,
            current_depth: 0,
            max_depth: 1,
            parent_tools: vec!["read".into()],
            parent_permissions: vec!["workspace.read".into()],
        };
        assert!(
            DelegationEngine::plan_with_options(&work, &policy, &evaluations, &options)
                .unwrap_err()
                .contains("expand")
        );
        work.envelope.tools.remove("edit");
        let exhausted = super::DelegationOptions {
            current_depth: 1,
            ..options
        };
        assert!(
            DelegationEngine::plan_with_options(&work, &policy, &evaluations, &exhausted)
                .unwrap_err()
                .contains("exhausted")
        );
    }
}
