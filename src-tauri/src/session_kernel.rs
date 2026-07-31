#![cfg_attr(not(test), allow(dead_code))]

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    Simple,
    Harness,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDescriptor {
    pub id: String,
    #[serde(default)]
    pub title: String,
    pub workspace_id: Option<String>,
    #[serde(default = "default_session_source")]
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_session_id: Option<String>,
    pub kind: SessionKind,
    pub parent_session_id: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub archived: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<u64>,
}

fn default_session_source() -> String {
    "picode".to_owned()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub sequence: u64,
    pub event_id: String,
    pub event_type: String,
    pub at: u64,
    pub payload: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppendOutcome {
    Appended(u64),
    Duplicate(u64),
}

struct SessionRecord {
    descriptor: SessionDescriptor,
    events: Vec<SessionEvent>,
    event_sequences: HashMap<String, u64>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLoad {
    pub descriptor: SessionDescriptor,
    pub events: Vec<SessionEvent>,
    pub warnings: Vec<String>,
}

pub struct SessionKernel {
    root: PathBuf,
    payload_limit: usize,
    sessions: HashMap<String, SessionRecord>,
    index: Connection,
}

impl SessionKernel {
    pub fn open(root: &Path, payload_limit: usize) -> Result<Self, String> {
        fs::create_dir_all(root)
            .map_err(|error| format!("Cannot create session store: {error}"))?;
        let index = Connection::open(root.join("sessions.sqlite3"))
            .map_err(|error| format!("Cannot open session index: {error}"))?;
        index
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 CREATE TABLE IF NOT EXISTS sessions (
                   id TEXT PRIMARY KEY,
                   workspace_id TEXT,
                   parent_session_id TEXT,
                   updated_at INTEGER NOT NULL,
                   archived INTEGER NOT NULL,
                   deleted_at INTEGER,
                   descriptor_json TEXT NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS sessions_workspace_updated
                   ON sessions(workspace_id, updated_at DESC);
                 CREATE INDEX IF NOT EXISTS sessions_parent
                   ON sessions(parent_session_id);",
            )
            .map_err(|error| format!("Cannot migrate session index: {error}"))?;
        let mut kernel = Self {
            root: root.to_path_buf(),
            payload_limit: payload_limit.max(2),
            sessions: HashMap::new(),
            index,
        };
        for entry in
            fs::read_dir(root).map_err(|error| format!("Cannot read session store: {error}"))?
        {
            let entry = entry.map_err(|error| format!("Cannot read session entry: {error}"))?;
            if !entry.path().is_dir() {
                continue;
            }
            let metadata_path = entry.path().join("session.json");
            if !metadata_path.is_file() {
                continue;
            }
            let descriptor: SessionDescriptor = serde_json::from_slice(
                &fs::read(&metadata_path)
                    .map_err(|error| format!("Cannot read session metadata: {error}"))?,
            )
            .map_err(|error| format!("Cannot parse session metadata: {error}"))?;
            validate_id(&descriptor.id)?;
            let (events, warnings) = read_events(&entry.path().join("events.jsonl"))?;
            let event_sequences = events
                .iter()
                .map(|event| (event.event_id.clone(), event.sequence))
                .collect();
            kernel.sync_index(&descriptor)?;
            kernel.sessions.insert(
                descriptor.id.clone(),
                SessionRecord {
                    descriptor,
                    events,
                    event_sequences,
                    warnings,
                },
            );
        }
        Ok(kernel)
    }

    pub fn create(&mut self, descriptor: SessionDescriptor) -> Result<(), String> {
        validate_id(&descriptor.id)?;
        if self.sessions.contains_key(&descriptor.id) {
            return Err("Session already exists".to_owned());
        }
        let session_dir = self.root.join(&descriptor.id);
        fs::create_dir(&session_dir).map_err(|error| format!("Cannot create session: {error}"))?;
        write_json_atomic(&session_dir.join("session.json"), &descriptor)?;
        File::create(session_dir.join("events.jsonl"))
            .map_err(|error| format!("Cannot create session events: {error}"))?;
        self.sync_index(&descriptor)?;
        self.sessions.insert(
            descriptor.id.clone(),
            SessionRecord {
                descriptor,
                events: Vec::new(),
                event_sequences: HashMap::new(),
                warnings: Vec::new(),
            },
        );
        Ok(())
    }

    pub fn append(
        &mut self,
        session_id: &str,
        mut event: SessionEvent,
    ) -> Result<AppendOutcome, String> {
        validate_id(session_id)?;
        if event.event_id.trim().is_empty() {
            return Err("Event id is required".to_owned());
        }
        let actual = serde_json::to_vec(&event.payload)
            .map_err(|error| format!("Cannot encode event payload: {error}"))?
            .len();
        if actual > self.payload_limit {
            return Err(format!(
                "Event payload exceeds {} byte limit ({actual})",
                self.payload_limit
            ));
        }
        let record = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| "Unknown session".to_owned())?;
        if let Some(sequence) = record.event_sequences.get(&event.event_id) {
            return Ok(AppendOutcome::Duplicate(*sequence));
        }
        event.sequence = record
            .events
            .last()
            .map_or(1, |previous| previous.sequence.saturating_add(1));
        let encoded = serde_json::to_vec(&event)
            .map_err(|error| format!("Cannot encode session event: {error}"))?;
        let mut file = OpenOptions::new()
            .append(true)
            .open(self.root.join(session_id).join("events.jsonl"))
            .map_err(|error| format!("Cannot append session event: {error}"))?;
        file.write_all(&encoded)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_data())
            .map_err(|error| format!("Cannot persist session event: {error}"))?;
        record.descriptor.updated_at = record.descriptor.updated_at.max(event.at);
        record
            .event_sequences
            .insert(event.event_id.clone(), event.sequence);
        record.events.push(event.clone());
        write_json_atomic(
            &self.root.join(session_id).join("session.json"),
            &record.descriptor,
        )?;
        let descriptor = record.descriptor.clone();
        self.sync_index(&descriptor)?;
        Ok(AppendOutcome::Appended(event.sequence))
    }

    pub fn events_after(&self, session_id: &str, cursor: u64) -> Result<Vec<SessionEvent>, String> {
        validate_id(session_id)?;
        Ok(self
            .sessions
            .get(session_id)
            .ok_or_else(|| "Unknown session".to_owned())?
            .events
            .iter()
            .filter(|event| event.sequence > cursor)
            .cloned()
            .collect())
    }

    pub fn contains_event(&self, session_id: &str, event_id: &str) -> Result<bool, String> {
        validate_id(session_id)?;
        Ok(self
            .sessions
            .get(session_id)
            .ok_or_else(|| "Unknown session".to_owned())?
            .event_sequences
            .contains_key(event_id))
    }

    pub fn load(&self, session_id: &str) -> Result<SessionLoad, String> {
        validate_id(session_id)?;
        let record = self
            .sessions
            .get(session_id)
            .ok_or_else(|| "Unknown session".to_owned())?;
        Ok(SessionLoad {
            descriptor: record.descriptor.clone(),
            events: record.events.clone(),
            warnings: record.warnings.clone(),
        })
    }

    pub fn list(&self, include_deleted: bool) -> Vec<SessionDescriptor> {
        let mut sessions = self
            .sessions
            .values()
            .filter(|record| include_deleted || record.descriptor.deleted_at.is_none())
            .map(|record| record.descriptor.clone())
            .collect::<Vec<_>>();
        sessions.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        sessions
    }

    /// Mirrors completed Pi messages into the canonical SessionKernel. The
    /// original Pi JSONL remains Pi's runtime file; this copy gives GUI, ACP,
    /// headless, backup and imported history one durable event vocabulary.
    pub fn observe_pi_event(
        &mut self,
        external_session_id: &str,
        workspace_id: Option<&str>,
        payload: &Value,
        at: u64,
    ) -> Result<Option<String>, String> {
        let external_session_id = external_session_id.trim();
        if external_session_id.is_empty() {
            return Ok(None);
        }
        let event = payload.get("event").unwrap_or(payload);
        if event.get("type").and_then(Value::as_str) != Some("message_end") {
            return Ok(None);
        }
        let message = event
            .get("message")
            .and_then(Value::as_object)
            .ok_or_else(|| "Pi message_end is missing message".to_owned())?;
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        if !matches!(role, "user" | "assistant") {
            return Ok(None);
        }
        let digest = Sha256::digest(external_session_id.as_bytes());
        let session_id = format!("pi-{}", &format!("{digest:x}")[..32]);
        if !self.sessions.contains_key(&session_id) {
            let title = external_session_id
                .rsplit(['\\', '/'])
                .next()
                .unwrap_or("Pi session")
                .trim_end_matches(".jsonl")
                .to_owned();
            self.create(SessionDescriptor {
                id: session_id.clone(),
                title: if title.is_empty() {
                    "Pi session".to_owned()
                } else {
                    title
                },
                workspace_id: workspace_id.map(str::to_owned),
                source: "pi".to_owned(),
                external_session_id: Some(external_session_id.to_owned()),
                kind: if workspace_id.is_some() {
                    SessionKind::Harness
                } else {
                    SessionKind::Simple
                },
                parent_session_id: None,
                created_at: at,
                updated_at: at,
                archived: false,
                deleted_at: None,
            })?;
        }

        let message_id = message
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| {
                let encoded = serde_json::to_vec(message).unwrap_or_default();
                format!("message-{:x}", Sha256::digest(encoded))
            });
        let content = message.get("content").cloned().unwrap_or(Value::Null);
        let mut visible = Vec::new();
        let mut thoughts = Vec::new();
        let mut tools = Vec::new();
        collect_pi_content(&content, &mut visible, &mut thoughts, &mut tools);

        let visible_text = bounded_text(&visible.join("\n"), self.payload_limit / 2);
        if !visible_text.trim().is_empty() {
            self.append(
                &session_id,
                SessionEvent {
                    sequence: 0,
                    event_id: format!("{message_id}:visible"),
                    event_type: format!("{role}_message"),
                    at,
                    payload: serde_json::json!({ "text": visible_text }),
                },
            )?;
            if role == "user" {
                let current = self.load(&session_id)?.descriptor.title;
                if current.ends_with(".jsonl") || current.starts_with("chat") {
                    let title =
                        bounded_text(visible.first().map(String::as_str).unwrap_or("Chat"), 128);
                    if !title.trim().is_empty() {
                        self.rename(&session_id, &title)?;
                    }
                }
            }
        }
        for (index, thought) in thoughts.into_iter().enumerate() {
            self.append(
                &session_id,
                SessionEvent {
                    sequence: 0,
                    event_id: format!("{message_id}:thought:{index}"),
                    event_type: "thought".to_owned(),
                    at,
                    payload: serde_json::json!({
                        "text": bounded_text(&thought, self.payload_limit / 2),
                        "collapsed": true,
                    }),
                },
            )?;
        }
        for (index, (tool_id, tool_name)) in tools.into_iter().enumerate() {
            self.append(
                &session_id,
                SessionEvent {
                    sequence: 0,
                    event_id: format!("{message_id}:tool:{tool_id}:{index}"),
                    event_type: "tool_call".to_owned(),
                    at,
                    payload: serde_json::json!({ "toolId": tool_id, "toolName": tool_name, "collapsed": true }),
                },
            )?;
        }
        Ok(Some(session_id))
    }

    pub fn rename(&mut self, session_id: &str, title: &str) -> Result<(), String> {
        if title.trim().is_empty() || title.chars().count() > 256 {
            return Err("Session title must contain 1 to 256 characters".to_owned());
        }
        self.update_descriptor(session_id, |descriptor| {
            descriptor.title = title.trim().to_owned();
        })
    }

    pub fn archive(&mut self, session_id: &str, archived: bool) -> Result<(), String> {
        self.update_descriptor(session_id, |descriptor| descriptor.archived = archived)
    }

    pub fn soft_delete(&mut self, session_id: &str, deleted_at: u64) -> Result<(), String> {
        if deleted_at == 0 {
            return Err("Delete timestamp is required".to_owned());
        }
        self.update_descriptor(session_id, |descriptor| {
            descriptor.deleted_at = Some(deleted_at)
        })
    }

    pub fn purge(&mut self, session_id: &str, confirmation: &str) -> Result<(), String> {
        validate_id(session_id)?;
        if confirmation != session_id {
            return Err("Permanent deletion requires the exact session id".to_owned());
        }
        let record = self
            .sessions
            .get(session_id)
            .ok_or_else(|| "Unknown session".to_owned())?;
        if record.descriptor.deleted_at.is_none() {
            return Err("Session must be soft-deleted before permanent deletion".to_owned());
        }
        fs::remove_dir_all(self.root.join(session_id))
            .map_err(|error| format!("Cannot permanently delete session: {error}"))?;
        self.sessions.remove(session_id);
        self.index
            .execute("DELETE FROM sessions WHERE id = ?1", params![session_id])
            .map_err(|error| format!("Cannot purge session index: {error}"))?;
        Ok(())
    }

    pub fn fork(&mut self, source_id: &str, new_id: &str, at: u64) -> Result<(), String> {
        validate_id(source_id)?;
        validate_id(new_id)?;
        if self.sessions.contains_key(new_id) {
            return Err("Session already exists".to_owned());
        }
        let source = self
            .sessions
            .get(source_id)
            .ok_or_else(|| "Unknown session".to_owned())?;
        let mut descriptor = source.descriptor.clone();
        descriptor.id = new_id.to_owned();
        descriptor.parent_session_id = Some(source_id.to_owned());
        descriptor.created_at = at;
        descriptor.updated_at = at;
        descriptor.archived = false;
        descriptor.deleted_at = None;
        let events = source.events.clone();
        let event_sequences = source.event_sequences.clone();
        let session_dir = self.root.join(new_id);
        fs::create_dir(&session_dir).map_err(|error| format!("Cannot create fork: {error}"))?;
        write_json_atomic(&session_dir.join("session.json"), &descriptor)?;
        write_events(&session_dir.join("events.jsonl"), &events)?;
        self.sessions.insert(
            new_id.to_owned(),
            SessionRecord {
                descriptor,
                events,
                event_sequences,
                warnings: Vec::new(),
            },
        );
        let descriptor = self.sessions.get(new_id).unwrap().descriptor.clone();
        self.sync_index(&descriptor)?;
        Ok(())
    }

    pub fn rewind(&mut self, session_id: &str, sequence: u64, at: u64) -> Result<(), String> {
        validate_id(session_id)?;
        let record = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| "Unknown session".to_owned())?;
        record.events.retain(|event| event.sequence <= sequence);
        record.event_sequences = record
            .events
            .iter()
            .map(|event| (event.event_id.clone(), event.sequence))
            .collect();
        record.descriptor.updated_at = at;
        write_events(
            &self.root.join(session_id).join("events.jsonl"),
            &record.events,
        )?;
        write_json_atomic(
            &self.root.join(session_id).join("session.json"),
            &record.descriptor,
        )?;
        let descriptor = record.descriptor.clone();
        self.sync_index(&descriptor)
    }

    fn update_descriptor(
        &mut self,
        session_id: &str,
        update: impl FnOnce(&mut SessionDescriptor),
    ) -> Result<(), String> {
        validate_id(session_id)?;
        let record = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| "Unknown session".to_owned())?;
        update(&mut record.descriptor);
        write_json_atomic(
            &self.root.join(session_id).join("session.json"),
            &record.descriptor,
        )?;
        let descriptor = record.descriptor.clone();
        self.sync_index(&descriptor)
    }

    fn sync_index(&self, descriptor: &SessionDescriptor) -> Result<(), String> {
        let json = serde_json::to_string(descriptor)
            .map_err(|error| format!("Cannot encode session index record: {error}"))?;
        self.index
            .execute(
                "INSERT INTO sessions (
                   id, workspace_id, parent_session_id, updated_at, archived, deleted_at, descriptor_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                   workspace_id = excluded.workspace_id,
                   parent_session_id = excluded.parent_session_id,
                   updated_at = excluded.updated_at,
                   archived = excluded.archived,
                   deleted_at = excluded.deleted_at,
                   descriptor_json = excluded.descriptor_json",
                params![
                    descriptor.id,
                    descriptor.workspace_id,
                    descriptor.parent_session_id,
                    descriptor.updated_at,
                    descriptor.archived,
                    descriptor.deleted_at,
                    json
                ],
            )
            .map_err(|error| format!("Cannot update session index: {error}"))?;
        Ok(())
    }
}

fn collect_pi_content(
    content: &Value,
    visible: &mut Vec<String>,
    thoughts: &mut Vec<String>,
    tools: &mut Vec<(String, String)>,
) {
    if let Some(text) = content.as_str() {
        visible.push(text.to_owned());
        return;
    }
    let Some(parts) = content.as_array() else {
        return;
    };
    for part in parts {
        let kind = part.get("type").and_then(Value::as_str).unwrap_or_default();
        match kind.to_ascii_lowercase().as_str() {
            "text" => {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    visible.push(text.to_owned());
                }
            }
            "thinking" | "reasoning" => {
                if let Some(text) = part
                    .get("thinking")
                    .or_else(|| part.get("text"))
                    .and_then(Value::as_str)
                {
                    thoughts.push(text.to_owned());
                }
            }
            "toolcall" | "tool_call" => {
                let id = part.get("id").and_then(Value::as_str).unwrap_or("tool");
                let name = part
                    .get("name")
                    .or_else(|| part.get("toolName"))
                    .and_then(Value::as_str)
                    .unwrap_or("tool");
                tools.push((id.to_owned(), name.to_owned()));
            }
            _ => {}
        }
    }
}

fn bounded_text(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes.min(value.len());
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[truncated]", &value[..end])
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("Session id contains unsafe characters".to_owned());
    }
    Ok(())
}

fn read_events(path: &Path) -> Result<(Vec<SessionEvent>, Vec<String>), String> {
    if !path.is_file() {
        return Ok((Vec::new(), Vec::new()));
    }
    let bytes = fs::read(path).map_err(|error| format!("Cannot open session events: {error}"))?;
    let text = String::from_utf8_lossy(&bytes);
    let tail_is_uncommitted = !text.ends_with('\n');
    let mut events = Vec::new();
    let mut warnings = Vec::new();
    let lines = text.split('\n').collect::<Vec<_>>();
    for (index, line) in lines.iter().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<SessionEvent>(line) {
            Ok(event) => events.push(event),
            Err(_) if tail_is_uncommitted && index + 1 == lines.len() => {
                warnings.push("truncated event tail ignored".to_owned());
            }
            Err(error) => {
                return Err(format!(
                    "Cannot parse committed session event {}: {error}",
                    index + 1
                ));
            }
        }
    }
    Ok((events, warnings))
}

fn write_events(path: &Path, events: &[SessionEvent]) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    let mut file = File::create(&temporary)
        .map_err(|error| format!("Cannot create session event rewrite: {error}"))?;
    for event in events {
        serde_json::to_writer(&mut file, event)
            .map_err(|error| format!("Cannot encode session event: {error}"))?;
        file.write_all(b"\n")
            .map_err(|error| format!("Cannot write session event: {error}"))?;
    }
    file.sync_data()
        .map_err(|error| format!("Cannot sync session events: {error}"))?;
    fs::rename(&temporary, path).map_err(|error| format!("Cannot publish session events: {error}"))
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    let encoded = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Cannot encode session metadata: {error}"))?;
    fs::write(&temporary, encoded)
        .map_err(|error| format!("Cannot write session metadata: {error}"))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("Cannot publish session metadata: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{AppendOutcome, SessionDescriptor, SessionEvent, SessionKernel, SessionKind};
    use serde_json::json;
    use std::fs;

    fn descriptor() -> SessionDescriptor {
        SessionDescriptor {
            id: "session-a".to_owned(),
            title: "Session A".to_owned(),
            workspace_id: Some("workspace-a".to_owned()),
            source: "picode".to_owned(),
            external_session_id: None,
            kind: SessionKind::Harness,
            parent_session_id: None,
            created_at: 10,
            updated_at: 10,
            archived: false,
            deleted_at: None,
        }
    }

    fn event() -> SessionEvent {
        SessionEvent {
            sequence: 0,
            event_id: "request-a".to_owned(),
            event_type: "user_message".to_owned(),
            at: 11,
            payload: json!({ "text": "continue" }),
        }
    }

    #[test]
    fn caller_can_resume_from_cursor_without_replaying_a_duplicate_request() {
        let root =
            std::env::temp_dir().join(format!("picode-session-kernel-{}", uuid::Uuid::new_v4()));
        {
            let mut kernel = SessionKernel::open(&root, 1024).unwrap();
            kernel.create(descriptor()).unwrap();
            assert_eq!(
                kernel.append("session-a", event()).unwrap(),
                AppendOutcome::Appended(1)
            );
        }

        let mut reopened = SessionKernel::open(&root, 1024).unwrap();
        assert_eq!(reopened.events_after("session-a", 0).unwrap().len(), 1);
        assert_eq!(
            reopened.append("session-a", event()).unwrap(),
            AppendOutcome::Duplicate(1)
        );
        assert!(reopened.events_after("session-a", 1).unwrap().is_empty());
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn caller_recovers_a_truncated_tail_but_rejects_corruption_in_committed_history() {
        let root =
            std::env::temp_dir().join(format!("picode-session-tail-{}", uuid::Uuid::new_v4()));
        {
            let mut kernel = SessionKernel::open(&root, 1024).unwrap();
            kernel.create(descriptor()).unwrap();
            kernel.append("session-a", event()).unwrap();
        }
        let events_path = root.join("session-a").join("events.jsonl");
        use std::io::Write as _;
        std::fs::OpenOptions::new()
            .append(true)
            .open(&events_path)
            .unwrap()
            .write_all(b"{\"sequence\":2")
            .unwrap();

        let recovered = SessionKernel::open(&root, 1024).unwrap();
        let loaded = recovered.load("session-a").unwrap();
        assert_eq!(loaded.events.len(), 1);
        assert_eq!(loaded.warnings, vec!["truncated event tail ignored"]);

        fs::write(&events_path, b"{bad}\n{bad-again}\n").unwrap();
        assert!(SessionKernel::open(&root, 1024)
            .err()
            .unwrap()
            .contains("committed session event"));
        drop(recovered);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn caller_can_list_fork_archive_soft_delete_and_explicitly_purge() {
        let root =
            std::env::temp_dir().join(format!("picode-session-life-{}", uuid::Uuid::new_v4()));
        let mut kernel = SessionKernel::open(&root, 1024).unwrap();
        kernel.create(descriptor()).unwrap();
        kernel.append("session-a", event()).unwrap();
        kernel.rename("session-a", "Playable build").unwrap();
        kernel.archive("session-a", true).unwrap();
        kernel.fork("session-a", "session-b", 20).unwrap();

        assert_eq!(kernel.list(false).len(), 2);
        assert_eq!(kernel.load("session-b").unwrap().events.len(), 1);
        kernel.soft_delete("session-a", 30).unwrap();
        assert_eq!(kernel.list(false).len(), 1);
        assert_eq!(kernel.list(true).len(), 2);
        assert!(kernel.purge("session-a", "wrong-confirmation").is_err());
        kernel.purge("session-a", "session-a").unwrap();
        assert!(kernel.load("session-a").is_err());
        drop(kernel);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pi_message_events_share_one_canonical_session_without_promoting_tools_or_thoughts_to_chat() {
        let root = std::env::temp_dir().join(format!("picode-session-pi-{}", uuid::Uuid::new_v4()));
        let mut kernel = SessionKernel::open(&root, 64 * 1024).unwrap();
        let external = "C:\\Users\\me\\.pi\\agent\\sessions\\project\\chat.jsonl";
        kernel
            .observe_pi_event(
                external,
                Some("workspace-a"),
                &json!({
                    "type": "event",
                    "event": {
                        "type": "message_end",
                        "message": {
                            "id": "assistant-1",
                            "role": "assistant",
                            "content": [
                                { "type": "thinking", "thinking": "private reasoning" },
                                { "type": "text", "text": "Implemented the fix." },
                                { "type": "toolCall", "id": "tool-1", "name": "bash", "arguments": { "command": "secret" } }
                            ]
                        }
                    }
                }),
                42,
            )
            .unwrap();
        let descriptor = kernel
            .list(false)
            .into_iter()
            .find(|candidate| candidate.external_session_id.as_deref() == Some(external))
            .unwrap();
        let loaded = kernel.load(&descriptor.id).unwrap();
        assert_eq!(loaded.descriptor.source, "pi");
        assert_eq!(
            loaded
                .events
                .iter()
                .filter(|event| event.event_type == "assistant_message")
                .count(),
            1
        );
        assert_eq!(
            loaded
                .events
                .iter()
                .filter(|event| event.event_type == "thought")
                .count(),
            1
        );
        assert_eq!(
            loaded
                .events
                .iter()
                .filter(|event| event.event_type == "tool_call")
                .count(),
            1
        );
        assert_eq!(loaded.events[0].payload["text"], "Implemented the fix.");
        assert_eq!(loaded.events[1].payload["collapsed"], true);
        assert!(loaded.events[2].payload.get("arguments").is_none());

        kernel
            .observe_pi_event(
                external,
                Some("workspace-a"),
                &json!({
                    "event": {
                        "type": "message_end",
                        "message": { "id": "assistant-1", "role": "assistant", "content": [{ "type": "text", "text": "Implemented the fix." }] }
                    }
                }),
                43,
            )
            .unwrap();
        assert_eq!(kernel.load(&descriptor.id).unwrap().events.len(), 3);
        drop(kernel);
        fs::remove_dir_all(root).unwrap();
    }
}
