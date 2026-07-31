#![cfg_attr(not(test), allow(dead_code))]

use crate::session_kernel::{
    AppendOutcome, SessionDescriptor, SessionEvent, SessionKernel, SessionKind,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

pub const ACP_PROTOCOL_VERSION: u32 = 1;
pub const PICODE_ACP_EXTENSION_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AcpRuntimeAction {
    Prompt {
        session_id: String,
        request_id: String,
        message: String,
    },
    Cancel {
        session_id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpResponse {
    pub id: Value,
    pub result: Value,
    pub actions: Vec<AcpRuntimeAction>,
}

#[derive(Clone)]
pub struct AcpAdapter {
    sessions: Arc<Mutex<SessionKernel>>,
}

impl AcpAdapter {
    pub fn new(sessions: Arc<Mutex<SessionKernel>>) -> Self {
        Self { sessions }
    }

    pub fn handle(&self, request: &Value, now: u64) -> Result<AcpResponse, String> {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| "ACP method is required".to_owned())?;
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Session Kernel lock is poisoned".to_owned())?;
        let (result, actions) = match method {
            "initialize" => (
                json!({
                    "protocolVersion": ACP_PROTOCOL_VERSION,
                    "agentInfo": { "name": "Picode", "version": env!("CARGO_PKG_VERSION") },
                    "capabilities": {
                        "loadSession": true,
                        "listSessions": true,
                        "promptCapabilities": { "image": false, "embeddedContext": true },
                        "picode": {
                            "version": PICODE_ACP_EXTENSION_VERSION,
                            "features": ["harness", "workHandles", "evidence", "resourceSnapshot", "backup"]
                        }
                    }
                }),
                Vec::new(),
            ),
            "session/new" => {
                let session_id = params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| Uuid::new_v4().to_string());
                let kind = match params.get("kind").and_then(Value::as_str) {
                    Some("harness") => SessionKind::Harness,
                    Some("simple") | None => SessionKind::Simple,
                    Some(_) => return Err("ACP session kind must be simple or harness".to_owned()),
                };
                let workspace_id = params
                    .get("workspaceId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if kind == SessionKind::Harness && workspace_id.is_none() {
                    return Err("Harness ACP session requires workspaceId".to_owned());
                }
                sessions.create(SessionDescriptor {
                    id: session_id.clone(),
                    title: params
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("New session")
                        .to_owned(),
                    workspace_id,
                    source: "picode".to_owned(),
                    external_session_id: None,
                    kind,
                    parent_session_id: None,
                    created_at: now,
                    updated_at: now,
                    archived: false,
                    deleted_at: None,
                })?;
                (json!({ "sessionId": session_id }), Vec::new())
            }
            "session/list" => {
                let include_deleted = params
                    .get("includeDeleted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                (
                    json!({ "sessions": sessions.list(include_deleted) }),
                    Vec::new(),
                )
            }
            "session/load" => {
                let session_id = required_string(&params, "sessionId")?;
                let cursor = params.get("cursor").and_then(Value::as_u64).unwrap_or(0);
                let loaded = sessions.load(session_id)?;
                let events = loaded
                    .events
                    .into_iter()
                    .filter(|event| event.sequence > cursor)
                    .collect::<Vec<_>>();
                (
                    json!({
                        "session": loaded.descriptor,
                        "updates": events,
                        "warnings": loaded.warnings,
                    }),
                    Vec::new(),
                )
            }
            "session/prompt" => {
                let session_id = required_string(&params, "sessionId")?;
                let request_id = required_string(&params, "requestId")?;
                let message = required_string(&params, "message")?;
                if message.trim().is_empty() {
                    return Err("ACP prompt message cannot be empty".to_owned());
                }
                let outcome = sessions.append(
                    session_id,
                    SessionEvent {
                        sequence: 0,
                        event_id: request_id.to_owned(),
                        event_type: "user_message".to_owned(),
                        at: now,
                        payload: json!({ "text": message }),
                    },
                )?;
                let actions = if matches!(outcome, AppendOutcome::Appended(_)) {
                    vec![AcpRuntimeAction::Prompt {
                        session_id: session_id.to_owned(),
                        request_id: request_id.to_owned(),
                        message: message.to_owned(),
                    }]
                } else {
                    Vec::new()
                };
                (
                    json!({
                        "accepted": matches!(outcome, AppendOutcome::Appended(_)),
                        "duplicate": matches!(outcome, AppendOutcome::Duplicate(_)),
                        "sequence": match outcome {
                            AppendOutcome::Appended(sequence) | AppendOutcome::Duplicate(sequence) => sequence,
                        }
                    }),
                    actions,
                )
            }
            "session/cancel" => {
                let session_id = required_string(&params, "sessionId")?;
                sessions.load(session_id)?;
                (
                    json!({ "accepted": true }),
                    vec![AcpRuntimeAction::Cancel {
                        session_id: session_id.to_owned(),
                    }],
                )
            }
            "session/fork" => {
                let source_id = required_string(&params, "sessionId")?;
                let new_id = params
                    .get("newSessionId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| Uuid::new_v4().to_string());
                sessions.fork(source_id, &new_id, now)?;
                (json!({ "sessionId": new_id }), Vec::new())
            }
            "session/rename" => {
                let session_id = required_string(&params, "sessionId")?;
                let title = required_string(&params, "title")?;
                sessions.rename(session_id, title)?;
                (json!({ "updated": true }), Vec::new())
            }
            "session/archive" => {
                let session_id = required_string(&params, "sessionId")?;
                let archived = params
                    .get("archived")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| "ACP archived is required".to_owned())?;
                sessions.archive(session_id, archived)?;
                (json!({ "updated": true, "archived": archived }), Vec::new())
            }
            "session/delete" => {
                let session_id = required_string(&params, "sessionId")?;
                sessions.soft_delete(session_id, now)?;
                (json!({ "deleted": true, "recoverable": true }), Vec::new())
            }
            "session/purge" => {
                let session_id = required_string(&params, "sessionId")?;
                let confirmation = required_string(&params, "confirmation")?;
                sessions.purge(session_id, confirmation)?;
                (json!({ "purged": true }), Vec::new())
            }
            "session/rewind" => {
                let session_id = required_string(&params, "sessionId")?;
                let sequence = params
                    .get("sequence")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| "ACP rewind sequence is required".to_owned())?;
                let confirmation = required_string(&params, "confirmation")?;
                if confirmation != session_id {
                    return Err("ACP rewind requires the exact session id".to_owned());
                }
                sessions.rewind(session_id, sequence, now)?;
                (json!({ "rewound": true, "sequence": sequence }), Vec::new())
            }
            "session/update" => {
                let session_id = required_string(&params, "sessionId")?;
                let event_id = required_string(&params, "eventId")?;
                let event_type = required_string(&params, "eventType")?;
                if !matches!(
                    event_type,
                    "assistant_message"
                        | "thought"
                        | "tool_call"
                        | "tool_result"
                        | "plan"
                        | "usage"
                        | "permission"
                ) {
                    return Err("Unsupported ACP session update type".to_owned());
                }
                let payload = params.get("payload").cloned().unwrap_or(Value::Null);
                let outcome = sessions.append(
                    session_id,
                    SessionEvent {
                        sequence: 0,
                        event_id: event_id.to_owned(),
                        event_type: event_type.to_owned(),
                        at: now,
                        payload,
                    },
                )?;
                (
                    json!({
                        "accepted": matches!(outcome, AppendOutcome::Appended(_)),
                        "duplicate": matches!(outcome, AppendOutcome::Duplicate(_)),
                    }),
                    Vec::new(),
                )
            }
            _ => return Err(format!("Unsupported ACP method: {method}")),
        };
        Ok(AcpResponse {
            id,
            result,
            actions,
        })
    }
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("ACP {key} is required"))
}

#[cfg(test)]
mod tests {
    use super::{AcpAdapter, AcpRuntimeAction};
    use crate::session_kernel::SessionKernel;
    use serde_json::json;
    use std::fs;
    use std::sync::{Arc, Mutex};

    #[test]
    fn duplicate_acp_prompt_is_persisted_and_dispatched_exactly_once() {
        let root = std::env::temp_dir().join(format!("picode-acp-{}", uuid::Uuid::new_v4()));
        let sessions = Arc::new(Mutex::new(SessionKernel::open(&root, 4096).unwrap()));
        let adapter = AcpAdapter::new(sessions.clone());
        adapter
            .handle(
                &json!({
                    "id": 1,
                    "method": "session/new",
                    "params": { "sessionId": "session-a", "kind": "simple" }
                }),
                10,
            )
            .unwrap();
        let prompt = json!({
            "id": 2,
            "method": "session/prompt",
            "params": { "sessionId": "session-a", "requestId": "request-a", "message": "continue" }
        });
        let first = adapter.handle(&prompt, 11).unwrap();
        let duplicate = adapter.handle(&prompt, 12).unwrap();

        assert!(matches!(
            first.actions.as_slice(),
            [AcpRuntimeAction::Prompt { .. }]
        ));
        assert!(duplicate.actions.is_empty());
        assert_eq!(duplicate.result["duplicate"], true);
        let loaded = adapter
            .handle(
                &json!({ "id": 3, "method": "session/load", "params": { "sessionId": "session-a", "cursor": 0 } }),
                13,
            )
            .unwrap();
        assert_eq!(loaded.result["updates"].as_array().unwrap().len(), 1);
        drop(adapter);
        drop(sessions);
        fs::remove_dir_all(root).unwrap();
    }
}
