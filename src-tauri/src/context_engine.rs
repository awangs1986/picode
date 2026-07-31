#![cfg_attr(not(test), allow(dead_code))]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextItemKind {
    UserGoal,
    TaskState,
    Conversation,
    ToolResult,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextItem {
    pub id: String,
    pub kind: ContextItemKind,
    pub token_cost: u32,
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FitRung {
    Verbatim,
    OldToolResultsRemoved,
    OldConversationRemoved,
    Emergency,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextPlan {
    pub included: Vec<ContextItem>,
    pub artifact_ids: Vec<String>,
    pub tokens_before: u32,
    pub tokens_after: u32,
    pub rung: FitRung,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredArtifact {
    pub id: String,
    pub bytes: usize,
    pub redacted: bool,
}

pub struct ContextEngine {
    artifact_root: PathBuf,
    artifact_limit: usize,
}

impl ContextEngine {
    pub fn open(root: &Path, artifact_limit: usize) -> Result<Self, String> {
        if artifact_limit == 0 {
            return Err("Artifact limit must be greater than zero".to_owned());
        }
        let artifact_root = root.join("artifacts");
        fs::create_dir_all(&artifact_root)
            .map_err(|error| format!("Cannot create context artifact store: {error}"))?;
        Ok(Self {
            artifact_root,
            artifact_limit,
        })
    }

    pub fn prepare_turn(&self, items: &[ContextItem], budget: u32) -> Result<ContextPlan, String> {
        let mut plan = prepare_plan(items, budget)?;
        let removed_ids = std::mem::take(&mut plan.artifact_ids);
        for item_id in removed_ids {
            let item = items
                .iter()
                .find(|item| item.id == item_id)
                .ok_or_else(|| "Context plan referenced a missing item".to_owned())?;
            plan.artifact_ids
                .push(self.store_artifact(&item.content, &[])?.id);
        }
        Ok(plan)
    }

    pub fn store_artifact(
        &self,
        content: &str,
        declared_secrets: &[String],
    ) -> Result<StoredArtifact, String> {
        let mut redacted_content = content.to_owned();
        let mut redacted = false;
        for secret in declared_secrets.iter().filter(|secret| !secret.is_empty()) {
            if redacted_content.contains(secret) {
                redacted_content = redacted_content.replace(secret, "[REDACTED]");
                redacted = true;
            }
        }
        let bytes = redacted_content.len();
        if bytes > self.artifact_limit {
            return Err(format!(
                "Context artifact exceeds {} byte limit ({bytes})",
                self.artifact_limit
            ));
        }
        let id = format!("{:x}", Sha256::digest(redacted_content.as_bytes()));
        let path = self.artifact_root.join(format!("{id}.bin"));
        if !path.exists() {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|error| format!("Cannot create context artifact: {error}"))?;
            file.write_all(redacted_content.as_bytes())
                .and_then(|_| file.sync_data())
                .map_err(|error| format!("Cannot persist context artifact: {error}"))?;
        }
        Ok(StoredArtifact {
            id,
            bytes,
            redacted,
        })
    }

    pub fn fetch_artifact(&self, id: &str) -> Result<String, String> {
        if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Artifact id is invalid".to_owned());
        }
        let bytes = fs::read(self.artifact_root.join(format!("{id}.bin")))
            .map_err(|error| format!("Cannot read context artifact: {error}"))?;
        if bytes.len() > self.artifact_limit {
            return Err("Stored context artifact exceeds the configured limit".to_owned());
        }
        String::from_utf8(bytes).map_err(|_| "Context artifact is not UTF-8".to_owned())
    }
}

fn prepare_plan(items: &[ContextItem], budget: u32) -> Result<ContextPlan, String> {
    if budget == 0 {
        return Err("Context budget must be greater than zero".to_owned());
    }
    let tokens_before = token_sum(items);
    if tokens_before <= budget {
        return Ok(ContextPlan {
            included: items.to_vec(),
            artifact_ids: Vec::new(),
            tokens_before,
            tokens_after: tokens_before,
            rung: FitRung::Verbatim,
        });
    }

    let protected_tokens = items
        .iter()
        .filter(|item| {
            matches!(
                item.kind,
                ContextItemKind::UserGoal | ContextItemKind::TaskState
            )
        })
        .map(|item| item.token_cost)
        .fold(0u32, u32::saturating_add);
    if protected_tokens > budget {
        return Err(format!(
            "Required goal and task state need {protected_tokens} tokens but budget is {budget}"
        ));
    }

    let mut keep = vec![true; items.len()];
    let mut tokens_after = tokens_before;
    let mut artifacts = Vec::new();
    let mut rung = FitRung::OldToolResultsRemoved;
    remove_until_fit(
        items,
        &mut keep,
        &mut tokens_after,
        budget,
        ContextItemKind::ToolResult,
        &mut artifacts,
    );
    if tokens_after > budget {
        rung = FitRung::OldConversationRemoved;
        remove_until_fit(
            items,
            &mut keep,
            &mut tokens_after,
            budget,
            ContextItemKind::Conversation,
            &mut artifacts,
        );
    }
    if tokens_after > budget {
        return Err("Context cannot fit without removing required goal or task state".to_owned());
    }
    Ok(ContextPlan {
        included: items
            .iter()
            .zip(keep)
            .filter(|(_, keep)| *keep)
            .map(|(item, _)| item.clone())
            .collect(),
        artifact_ids: artifacts,
        tokens_before,
        tokens_after,
        rung,
    })
}

fn token_sum(items: &[ContextItem]) -> u32 {
    items
        .iter()
        .map(|item| item.token_cost)
        .fold(0u32, u32::saturating_add)
}

fn remove_until_fit(
    items: &[ContextItem],
    keep: &mut [bool],
    tokens_after: &mut u32,
    budget: u32,
    kind: ContextItemKind,
    artifacts: &mut Vec<String>,
) {
    for (index, item) in items.iter().enumerate() {
        if *tokens_after <= budget {
            return;
        }
        if keep[index] && item.kind == kind {
            keep[index] = false;
            *tokens_after = tokens_after.saturating_sub(item.token_cost);
            artifacts.push(item.id.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ContextEngine, ContextItem, ContextItemKind, FitRung};

    fn item(id: &str, kind: ContextItemKind, token_cost: u32) -> ContextItem {
        ContextItem {
            id: id.to_owned(),
            kind,
            token_cost,
            content: format!("content-{id}"),
        }
    }

    #[test]
    fn caller_keeps_current_goal_and_task_state_before_old_tool_output() {
        let root = std::env::temp_dir().join(format!("picode-context-{}", uuid::Uuid::new_v4()));
        let engine = ContextEngine::open(&root, 1024).unwrap();
        let plan = engine
            .prepare_turn(
                &[
                    item("old-tool", ContextItemKind::ToolResult, 8),
                    item("old-chat", ContextItemKind::Conversation, 4),
                    item("goal", ContextItemKind::UserGoal, 3),
                    item("task", ContextItemKind::TaskState, 2),
                ],
                10,
            )
            .unwrap();

        assert_eq!(
            plan.included
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["old-chat", "goal", "task"]
        );
        assert_eq!(plan.artifact_ids.len(), 1);
        assert_eq!(
            engine.fetch_artifact(&plan.artifact_ids[0]).unwrap(),
            "content-old-tool"
        );
        assert_eq!((plan.tokens_before, plan.tokens_after), (17, 9));
        assert_eq!(plan.rung, FitRung::OldToolResultsRemoved);
        drop(engine);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn artifact_store_redacts_declared_secrets_and_rejects_oversized_fetches() {
        let root = std::env::temp_dir().join(format!("picode-artifact-{}", uuid::Uuid::new_v4()));
        let engine = ContextEngine::open(&root, 32).unwrap();
        let artifact = engine
            .store_artifact("token=cpa_secret build output", &["cpa_secret".into()])
            .unwrap();
        assert_eq!(
            engine.fetch_artifact(&artifact.id).unwrap(),
            "token=[REDACTED] build output"
        );
        assert!(engine
            .store_artifact(&"x".repeat(33), &[])
            .unwrap_err()
            .contains("limit"));
        drop(engine);
        std::fs::remove_dir_all(root).unwrap();
    }
}
