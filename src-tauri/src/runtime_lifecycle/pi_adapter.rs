use crate::runtime_coordinator::RuntimeTarget;
use crate::runtime_spine::{RuntimeEventInput, RuntimeEventKind};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PiEventLane {
    Semantic,
    CoalescibleProgress,
    Streaming,
    Ignored,
}

#[derive(Clone, Debug)]
pub struct PiEventContext {
    pub target: RuntimeTarget,
    pub task_id: Option<String>,
    pub agent_run_id: Option<String>,
    pub parent_run_id: Option<String>,
    pub at: u64,
}

#[derive(Clone, Debug)]
pub struct PiTranslation {
    pub event: Option<RuntimeEventInput>,
}

pub struct PiEventAdapter;

impl PiEventAdapter {
    pub fn classify(payload: &Value) -> PiEventLane {
        let event = payload.get("event").unwrap_or(payload);
        match event.get("type").and_then(Value::as_str) {
            Some(
                "agent_start"
                | "agent_end"
                | "turn_start"
                | "turn_end"
                | "auto_retry_start"
                | "auto_retry_end"
                | "tool_execution_start"
                | "tool_execution_end"
                | "auto_compaction_start"
                | "auto_compaction_end"
                | "permission_denied",
            ) => PiEventLane::Semantic,
            Some("message_update" | "tool_execution_update") => PiEventLane::CoalescibleProgress,
            Some("message_start" | "message_end") => PiEventLane::Streaming,
            Some(_) => PiEventLane::Ignored,
            None => PiEventLane::Ignored,
        }
    }

    pub fn translate(context: &PiEventContext, payload: &Value) -> PiTranslation {
        let event = payload.get("event").unwrap_or(payload);
        let raw_kind = event.get("type").and_then(Value::as_str).map(str::to_owned);
        let lane = Self::classify(payload);
        if lane != PiEventLane::Semantic {
            return PiTranslation { event: None };
        }
        let Some(raw_kind_ref) = raw_kind.as_deref() else {
            return PiTranslation { event: None };
        };
        let kind = match raw_kind_ref {
            "agent_start" => RuntimeEventKind::SessionStarted,
            "turn_start" | "auto_retry_start" => RuntimeEventKind::WorkStarted,
            "turn_end" | "auto_retry_end" => RuntimeEventKind::WorkFinished,
            "tool_execution_start" => RuntimeEventKind::BeforeTool,
            "tool_execution_end" if has_error(event) => RuntimeEventKind::ToolFailed,
            "tool_execution_end" => RuntimeEventKind::ToolFinished,
            "agent_end" => RuntimeEventKind::BeforeComplete,
            "auto_compaction_start" => RuntimeEventKind::CompactionStarted,
            "auto_compaction_end" => RuntimeEventKind::CompactionFinished,
            "permission_denied" => RuntimeEventKind::PermissionDenied,
            _ => return PiTranslation { event: None },
        };
        let tool_call_id = event
            .get("toolCallId")
            .or_else(|| event.get("callId"))
            .and_then(Value::as_str);
        let work_id = if matches!(
            kind,
            RuntimeEventKind::BeforeTool
                | RuntimeEventKind::ToolFinished
                | RuntimeEventKind::ToolFailed
        ) {
            tool_call_id.map(|call_id| match context.agent_run_id.as_deref() {
                Some(run_id) => format!("tool:{run_id}:{call_id}"),
                None => format!("tool:{}:{call_id}", context.target.instance_id),
            })
        } else {
            context.agent_run_id.clone()
        };
        let parent_work_id = if tool_call_id.is_some() {
            context.agent_run_id.clone()
        } else {
            context.parent_run_id.clone()
        };
        let encoded = serde_json::to_vec(event).unwrap_or_default();
        let source_id = event
            .get("requestId")
            .or_else(|| event.get("eventId"))
            .or_else(|| event.get("id"))
            .and_then(Value::as_str);
        let event_id = source_id
            .map(|id| format!("pi:{raw_kind_ref}:{id}"))
            .unwrap_or_else(|| {
                let source_at = event
                    .get("timestamp")
                    .and_then(Value::as_u64)
                    .unwrap_or(context.at);
                format!(
                    "pi:{raw_kind_ref}:{source_at}:{:x}",
                    Sha256::digest(encoded)
                )
            });
        PiTranslation {
            event: Some(RuntimeEventInput {
                schema_version: 2,
                source: "pi".to_owned(),
                event_id,
                kind,
                task_id: context.task_id.clone(),
                work_id,
                parent_work_id,
                at: context.at,
                payload: json!({
                    "status": raw_kind_ref,
                    "toolName": event
                        .get("toolName")
                        .or_else(|| event.get("tool"))
                        .and_then(Value::as_str),
                    "exitCode": event.get("exitCode").and_then(Value::as_i64),
                    "errorKind": event
                        .get("error")
                        .and_then(|error| error.get("type"))
                        .and_then(Value::as_str),
                }),
            }),
        }
    }
}

fn has_error(event: &Value) -> bool {
    event
        .get("error")
        .is_some_and(|value| !value.is_null() && value.as_str() != Some(""))
        || event.get("success").and_then(Value::as_bool) == Some(false)
}

#[cfg(test)]
mod tests {
    use super::{PiEventAdapter, PiEventContext, PiEventLane};
    use crate::runtime_coordinator::RuntimeTarget;
    use crate::runtime_spine::RuntimeEventKind;
    use serde_json::json;

    fn context() -> PiEventContext {
        PiEventContext {
            target: RuntimeTarget::new("workspace-a", "session-a", "runtime-a"),
            task_id: Some("task-a".into()),
            agent_run_id: Some("run-a".into()),
            parent_run_id: None,
            at: 42,
        }
    }

    #[test]
    fn streaming_deltas_do_not_become_durable_lifecycle_events() {
        for kind in ["message_update", "tool_execution_update", "message_end"] {
            let translated =
                PiEventAdapter::translate(&context(), &json!({ "event": { "type": kind } }));
            assert!(translated.event.is_none(), "{kind} became durable");
        }
        assert_eq!(
            PiEventAdapter::classify(&json!({ "event": { "type": "message_update" } })),
            PiEventLane::CoalescibleProgress
        );
    }

    #[test]
    fn agent_end_requests_completion_instead_of_claiming_completion() {
        let translated = PiEventAdapter::translate(
            &context(),
            &json!({ "event": { "type": "agent_end", "id": "end-a" } }),
        );
        let event = translated.event.unwrap();
        assert_eq!(event.kind, RuntimeEventKind::BeforeComplete);
        assert_eq!(event.work_id.as_deref(), Some("run-a"));
        assert_eq!(event.event_id, "pi:agent_end:end-a");
    }

    #[test]
    fn tool_events_have_stable_child_work_identity() {
        let translated = PiEventAdapter::translate(
            &context(),
            &json!({
                "event": {
                    "type": "tool_execution_end",
                    "toolCallId": "call-a",
                    "toolName": "bash",
                    "error": { "type": "exit" }
                }
            }),
        );
        let event = translated.event.unwrap();
        assert_eq!(event.kind, RuntimeEventKind::ToolFailed);
        assert_eq!(event.work_id.as_deref(), Some("tool:run-a:call-a"));
        assert_eq!(event.parent_work_id.as_deref(), Some("run-a"));
    }
}
