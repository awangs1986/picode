#![cfg_attr(not(test), allow(dead_code))]

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    Allow,
    Ask,
    Deny,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyRule {
    pub id: String,
    pub action: String,
    pub scope: String,
    pub decision: Decision,
}

impl PolicyRule {
    pub fn ask(id: &str, action: &str, scope: &str) -> Self {
        Self::new(id, action, scope, Decision::Ask)
    }

    pub fn deny(id: &str, action: &str, scope: &str) -> Self {
        Self::new(id, action, scope, Decision::Deny)
    }

    fn new(id: &str, action: &str, scope: &str, decision: Decision) -> Self {
        Self {
            id: id.to_owned(),
            action: action.to_owned(),
            scope: scope.to_owned(),
            decision,
        }
    }

    fn matches(&self, request: &ActionRequest) -> bool {
        (self.action == "*" || self.action == request.action)
            && (self.scope == "*" || self.scope == request.scope)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionRequest {
    pub action: String,
    pub scope: String,
}

impl ActionRequest {
    pub fn new(action: &str, scope: &str) -> Self {
        Self {
            action: action.to_owned(),
            scope: scope.to_owned(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationDecision {
    pub decision: Decision,
    pub provenance: String,
    pub scope: String,
}

#[derive(Clone, Debug)]
struct SessionGrant {
    action: String,
    scope: String,
    expires_at: u64,
    provenance: String,
}

pub struct AuthorizationEngine {
    rules: Vec<PolicyRule>,
    grants: Vec<SessionGrant>,
}

impl AuthorizationEngine {
    pub fn new(rules: Vec<PolicyRule>) -> Self {
        Self {
            rules,
            grants: Vec::new(),
        }
    }

    pub fn grant_session(&mut self, action: &str, scope: &str, expires_at: u64, provenance: &str) {
        self.grants
            .retain(|grant| !(grant.action == action && grant.scope == scope));
        self.grants.push(SessionGrant {
            action: action.to_owned(),
            scope: scope.to_owned(),
            expires_at,
            provenance: provenance.to_owned(),
        });
    }

    pub fn evaluate(&self, request: &ActionRequest, now: u64) -> AuthorizationDecision {
        if let Some(grant) = self.grants.iter().find(|grant| {
            grant.action == request.action && grant.scope == request.scope && now < grant.expires_at
        }) {
            return AuthorizationDecision {
                decision: Decision::Allow,
                provenance: grant.provenance.clone(),
                scope: request.scope.clone(),
            };
        }
        if let Some(rule) = self.rules.iter().find(|rule| rule.matches(request)) {
            return AuthorizationDecision {
                decision: rule.decision,
                provenance: rule.id.clone(),
                scope: request.scope.clone(),
            };
        }
        AuthorizationDecision {
            decision: Decision::Ask,
            provenance: "default-ask".to_owned(),
            scope: request.scope.clone(),
        }
    }

    pub fn execute<T, F>(
        &self,
        request: &ActionRequest,
        now: u64,
        operation: F,
    ) -> Result<T, String>
    where
        F: FnOnce() -> Result<T, String>,
    {
        let decision = self.evaluate(request, now);
        match decision.decision {
            Decision::Allow => operation(),
            Decision::Ask => Err(format!(
                "action requires confirmation by {}",
                decision.provenance
            )),
            Decision::Deny => Err(format!("action denied by {}", decision.provenance)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ActionRequest, AuthorizationEngine, Decision, PolicyRule};

    #[test]
    fn one_authorization_surface_expires_session_grants_and_never_partially_runs_denied_actions() {
        let mut engine = AuthorizationEngine::new(vec![
            PolicyRule::ask("workspace-write", "write", "workspace:game"),
            PolicyRule::deny("destructive-default", "destructive", "*"),
        ]);
        engine.grant_session("write", "workspace:game", 100, "user-confirmed");

        let allowed = engine.evaluate(&ActionRequest::new("write", "workspace:game"), 99);
        assert_eq!(allowed.decision, Decision::Allow);
        assert_eq!(allowed.provenance, "user-confirmed");
        let expired = engine.evaluate(&ActionRequest::new("write", "workspace:game"), 100);
        assert_eq!(expired.decision, Decision::Ask);
        assert_eq!(expired.provenance, "workspace-write");

        let mut executed = false;
        let result = engine.execute(
            &ActionRequest::new("destructive", "workspace:game"),
            99,
            || {
                executed = true;
                Ok::<_, String>(())
            },
        );
        assert_eq!(result, Err("action denied by destructive-default".into()));
        assert!(!executed);
    }
}
