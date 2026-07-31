#![cfg_attr(not(test), allow(dead_code))]

use crate::runtime_coordinator::RuntimeTarget;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeEventKind {
    SessionStarted,
    PromptSubmitted,
    BeforeTool,
    ToolFinished,
    ToolFailed,
    PermissionDenied,
    WorkStarted,
    WorkUpdated,
    WorkFinished,
    BeforeComplete,
    CompactionStarted,
    CompactionFinished,
    SessionEnded,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventInput {
    #[serde(default = "runtime_event_schema")]
    pub schema_version: u32,
    #[serde(default = "runtime_event_source")]
    pub source: String,
    pub event_id: String,
    pub kind: RuntimeEventKind,
    pub task_id: Option<String>,
    pub work_id: Option<String>,
    pub parent_work_id: Option<String>,
    pub at: u64,
    pub payload: Value,
}

fn runtime_event_schema() -> u32 {
    2
}

fn runtime_event_source() -> String {
    "picode".to_owned()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedRuntimeEvent {
    pub sequence: u64,
    pub target: RuntimeTarget,
    pub input: RuntimeEventInput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordOutcome {
    Recorded,
    Duplicate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeSessionState {
    Running,
    Reconciling,
    Ended,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeSpineError {
    UnknownSession,
    DuplicateSession,
    MissingEventId,
    PayloadTooLarge { limit: usize, actual: usize },
    Persistence(String),
}

struct SessionEvents {
    target: RuntimeTarget,
    next_sequence: u64,
    events: VecDeque<RecordedRuntimeEvent>,
    event_ids: HashSet<String>,
    state: RuntimeSessionState,
}

pub struct RuntimeSpine {
    sessions: HashMap<String, SessionEvents>,
    payload_limit: usize,
    retained_events: usize,
    log_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "recordType", rename_all = "snake_case")]
enum SpineLogRecord {
    Begin { target: RuntimeTarget },
    Event { event: RecordedRuntimeEvent },
    End { target: RuntimeTarget },
}

impl RuntimeSpine {
    pub fn new(payload_limit: usize, retained_events: usize) -> Self {
        Self {
            sessions: HashMap::new(),
            payload_limit: payload_limit.max(2),
            retained_events: retained_events.max(1),
            log_path: None,
        }
    }

    pub fn open(
        root: &Path,
        payload_limit: usize,
        retained_events: usize,
    ) -> Result<Self, RuntimeSpineError> {
        fs::create_dir_all(root)
            .map_err(|error| RuntimeSpineError::Persistence(error.to_string()))?;
        let log_path = root.join("runtime-events-v2.jsonl");
        if !log_path.exists() {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&log_path)
                .map_err(|error| RuntimeSpineError::Persistence(error.to_string()))?;
        }
        let mut spine = Self::new(payload_limit, retained_events);
        spine.log_path = Some(log_path.clone());
        let bytes = fs::read(&log_path)
            .map_err(|error| RuntimeSpineError::Persistence(error.to_string()))?;
        let text = String::from_utf8_lossy(&bytes);
        let tail_uncommitted = !text.ends_with('\n');
        let lines = text.split('\n').collect::<Vec<_>>();
        for (index, line) in lines.iter().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let record = match serde_json::from_str::<SpineLogRecord>(line) {
                Ok(record) => record,
                Err(_) if tail_uncommitted && index + 1 == lines.len() => break,
                Err(error) => {
                    return Err(RuntimeSpineError::Persistence(format!(
                        "invalid committed runtime event {}: {error}",
                        index + 1
                    )));
                }
            };
            spine.replay_record(record)?;
        }
        for session in spine.sessions.values_mut() {
            if session.state == RuntimeSessionState::Running {
                session.state = RuntimeSessionState::Reconciling;
            }
        }
        Ok(spine)
    }

    pub fn begin_session(&mut self, target: RuntimeTarget) -> Result<(), RuntimeSpineError> {
        if self.sessions.contains_key(&target.instance_id)
            || self.sessions.values().any(|session| {
                session.target.workspace_id == target.workspace_id
                    && session.target.session_id == target.session_id
            })
        {
            return Err(RuntimeSpineError::DuplicateSession);
        }
        self.append_log(&SpineLogRecord::Begin {
            target: target.clone(),
        })?;
        self.sessions.insert(
            target.instance_id.clone(),
            SessionEvents {
                target,
                next_sequence: 1,
                events: VecDeque::new(),
                event_ids: HashSet::new(),
                state: RuntimeSessionState::Running,
            },
        );
        Ok(())
    }

    pub fn record(
        &mut self,
        target: &RuntimeTarget,
        input: RuntimeEventInput,
    ) -> Result<(RecordOutcome, Option<RecordedRuntimeEvent>), RuntimeSpineError> {
        if input.event_id.trim().is_empty() {
            return Err(RuntimeSpineError::MissingEventId);
        }
        let actual = serde_json::to_vec(&input.payload)
            .map_err(|_| RuntimeSpineError::PayloadTooLarge {
                limit: self.payload_limit,
                actual: usize::MAX,
            })?
            .len();
        if actual > self.payload_limit {
            return Err(RuntimeSpineError::PayloadTooLarge {
                limit: self.payload_limit,
                actual,
            });
        }
        let retained_events = self.retained_events;
        let session = self.session_mut(target)?;
        if session.event_ids.contains(&input.event_id) {
            return Ok((RecordOutcome::Duplicate, None));
        }
        let mut input = input;
        input.schema_version = 2;
        input.payload = sanitize_observation_payload(&input.payload);
        let event = RecordedRuntimeEvent {
            sequence: session.next_sequence,
            target: target.clone(),
            input,
        };
        self.append_log(&SpineLogRecord::Event {
            event: event.clone(),
        })?;
        let session = self.session_mut(target)?;
        session.next_sequence = session.next_sequence.saturating_add(1);
        session.event_ids.insert(event.input.event_id.clone());
        session.events.push_back(event.clone());
        while session.events.len() > retained_events {
            session.events.pop_front();
        }
        Ok((RecordOutcome::Recorded, Some(event)))
    }

    pub fn events_after(
        &self,
        target: &RuntimeTarget,
        sequence: u64,
    ) -> Result<Vec<RecordedRuntimeEvent>, RuntimeSpineError> {
        Ok(self
            .session(target)?
            .events
            .iter()
            .filter(|event| event.sequence > sequence)
            .cloned()
            .collect())
    }

    pub fn session_state(
        &self,
        target: &RuntimeTarget,
    ) -> Result<RuntimeSessionState, RuntimeSpineError> {
        Ok(self.session(target)?.state)
    }

    pub fn end_session(&mut self, target: &RuntimeTarget) -> Result<(), RuntimeSpineError> {
        self.session(target)?;
        self.append_log(&SpineLogRecord::End {
            target: target.clone(),
        })?;
        self.session_mut(target)?.state = RuntimeSessionState::Ended;
        Ok(())
    }

    fn replay_record(&mut self, record: SpineLogRecord) -> Result<(), RuntimeSpineError> {
        match record {
            SpineLogRecord::Begin { target } => {
                if self.sessions.contains_key(&target.instance_id) {
                    return Err(RuntimeSpineError::DuplicateSession);
                }
                self.sessions.insert(
                    target.instance_id.clone(),
                    SessionEvents {
                        target,
                        next_sequence: 1,
                        events: VecDeque::new(),
                        event_ids: HashSet::new(),
                        state: RuntimeSessionState::Running,
                    },
                );
            }
            SpineLogRecord::Event { event } => {
                let retained_events = self.retained_events;
                let session = self.session_mut(&event.target)?;
                if session.event_ids.insert(event.input.event_id.clone()) {
                    session.next_sequence =
                        session.next_sequence.max(event.sequence.saturating_add(1));
                    session.events.push_back(event);
                    while session.events.len() > retained_events {
                        session.events.pop_front();
                    }
                }
            }
            SpineLogRecord::End { target } => {
                self.session_mut(&target)?.state = RuntimeSessionState::Ended;
            }
        }
        Ok(())
    }

    fn append_log(&self, record: &SpineLogRecord) -> Result<(), RuntimeSpineError> {
        let Some(path) = &self.log_path else {
            return Ok(());
        };
        let encoded = serde_json::to_vec(record)
            .map_err(|error| RuntimeSpineError::Persistence(error.to_string()))?;
        let mut file = OpenOptions::new()
            .append(true)
            .open(path)
            .map_err(|error| RuntimeSpineError::Persistence(error.to_string()))?;
        file.write_all(&encoded)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_data())
            .map_err(|error| RuntimeSpineError::Persistence(error.to_string()))
    }

    fn session(&self, target: &RuntimeTarget) -> Result<&SessionEvents, RuntimeSpineError> {
        self.sessions
            .get(&target.instance_id)
            .filter(|session| session.target == *target)
            .ok_or(RuntimeSpineError::UnknownSession)
    }

    fn session_mut(
        &mut self,
        target: &RuntimeTarget,
    ) -> Result<&mut SessionEvents, RuntimeSpineError> {
        self.sessions
            .get_mut(&target.instance_id)
            .filter(|session| session.target == *target)
            .ok_or(RuntimeSpineError::UnknownSession)
    }
}

/// Runtime events are an observability index, not another transcript. Only
/// bounded scalar telemetry is retained; prompts, code, paths, commands,
/// reasoning, secrets, and arbitrary textual tool output belong in the
/// separately governed artifact store.
fn sanitize_observation_payload(payload: &Value) -> Value {
    const ALLOWED: &[&str] = &[
        "provider",
        "model",
        "status",
        "outcome",
        "durationms",
        "inputtokens",
        "outputtokens",
        "cachedtokens",
        "cost",
        "bytecount",
        "itemcount",
        "exitcode",
        "toolname",
        "permission",
        "workkind",
        "errorkind",
        "measurementkind",
        "shared",
        "estimated",
        "available",
        "attempt",
        "retrycount",
    ];
    let Some(object) = payload.as_object() else {
        return Value::Object(Default::default());
    };
    let filtered = object
        .iter()
        .filter(|(key, value)| {
            ALLOWED.contains(&key.to_ascii_lowercase().as_str())
                && (value.is_boolean() || value.is_number() || value.is_null() || value.is_string())
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    Value::Object(filtered)
}

#[cfg(test)]
mod tests {
    use super::{
        RecordOutcome, RuntimeEventInput, RuntimeEventKind, RuntimeSpine, RuntimeSpineError,
    };
    use crate::runtime_coordinator::RuntimeTarget;
    use serde_json::json;

    fn target() -> RuntimeTarget {
        RuntimeTarget::new("workspace-a", "session-a", "instance-a")
    }

    fn event(id: &str, value: &str) -> RuntimeEventInput {
        RuntimeEventInput {
            schema_version: 2,
            source: "test".to_owned(),
            event_id: id.to_owned(),
            kind: RuntimeEventKind::PromptSubmitted,
            task_id: Some("task-a".to_owned()),
            work_id: None,
            parent_work_id: None,
            at: 42,
            payload: json!({ "text": value }),
        }
    }

    #[test]
    fn caller_observes_ordered_idempotent_and_bounded_session_events() {
        let mut spine = RuntimeSpine::new(32, 8);
        spine.begin_session(target()).unwrap();

        let (outcome, first) = spine.record(&target(), event("event-1", "hello")).unwrap();
        assert_eq!(outcome, RecordOutcome::Recorded);
        assert_eq!(first.unwrap().sequence, 1);

        let (outcome, duplicate) = spine.record(&target(), event("event-1", "hello")).unwrap();
        assert_eq!(outcome, RecordOutcome::Duplicate);
        assert!(duplicate.is_none());

        let (_, second) = spine.record(&target(), event("event-2", "world")).unwrap();
        assert_eq!(second.unwrap().sequence, 2);
        assert_eq!(spine.events_after(&target(), 1).unwrap().len(), 1);

        let error = spine
            .record(
                &target(),
                event("event-3", "this payload is intentionally too large"),
            )
            .unwrap_err();
        assert!(matches!(error, RuntimeSpineError::PayloadTooLarge { .. }));
        assert_eq!(spine.events_after(&target(), 0).unwrap().len(), 2);
    }

    #[test]
    fn restart_replays_events_and_marks_unfinished_work_for_reconciliation() {
        let root =
            std::env::temp_dir().join(format!("picode-runtime-spine-{}", uuid::Uuid::new_v4()));
        {
            let mut spine = RuntimeSpine::open(&root, 1024, 8).unwrap();
            spine.begin_session(target()).unwrap();
            spine.record(&target(), event("event-1", "hello")).unwrap();
        }
        let mut reopened = RuntimeSpine::open(&root, 1024, 8).unwrap();
        assert_eq!(
            reopened.session_state(&target()).unwrap(),
            super::RuntimeSessionState::Reconciling
        );
        assert_eq!(reopened.events_after(&target(), 0).unwrap().len(), 1);
        assert_eq!(
            reopened
                .record(&target(), event("event-1", "hello"))
                .unwrap()
                .0,
            RecordOutcome::Duplicate
        );
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn observability_never_persists_prompt_code_path_command_reasoning_or_secret() {
        let root =
            std::env::temp_dir().join(format!("picode-runtime-private-{}", uuid::Uuid::new_v4()));
        let mut spine = RuntimeSpine::open(&root, 4096, 8).unwrap();
        spine.begin_session(target()).unwrap();
        let mut private = event("event-private", "hidden prompt");
        private.payload = json!({
            "prompt": "hidden prompt",
            "code": "let secret = 1",
            "absolutePath": "C:\\private\\project",
            "command": "dangerous --secret token",
            "reasoning": "private chain",
            "secret": "token",
            "status": "running",
            "durationMs": 8
        });
        let (_, event) = spine.record(&target(), private).unwrap();
        assert_eq!(
            event.unwrap().input.payload,
            json!({ "status": "running", "durationMs": 8 })
        );
        drop(spine);
        let persisted = std::fs::read_to_string(root.join("runtime-events-v2.jsonl")).unwrap();
        for forbidden in [
            "hidden prompt",
            "private chain",
            "dangerous --secret",
            "C:\\\\private",
            "token",
        ] {
            assert!(
                !persisted.contains(forbidden),
                "persisted private value: {forbidden}"
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
