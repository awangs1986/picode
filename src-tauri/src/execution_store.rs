#![cfg_attr(not(test), allow(dead_code))]

use crate::execution::{
    ChatSession, ExecutionState, TaskKind, TaskKindRevision, TaskRun, TaskStatus, WorkspaceIdentity,
};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MigrationFault {
    None,
    AfterStage,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LoadResult {
    pub state: ExecutionState,
    pub read_only: bool,
    pub warning: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MigrationResult {
    pub state: ExecutionState,
    pub imported: bool,
}

#[derive(Clone, Debug)]
pub struct ExecutionStore {
    root: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyDocument {
    #[serde(default)]
    sessions: Vec<LegacySession>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySession {
    id: String,
    #[serde(default = "default_goal")]
    goal: String,
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default = "default_platform")]
    platform: String,
    #[serde(default)]
    archived: bool,
}

fn default_goal() -> String {
    "Imported conversation".to_owned()
}

fn default_platform() -> String {
    "unknown".to_owned()
}

impl ExecutionStore {
    pub fn open(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root)
            .map_err(|error| format!("create execution store {}: {error}", root.display()))?;
        Ok(Self { root })
    }

    pub fn state_path(&self) -> PathBuf {
        self.root.join("execution-v1.json")
    }

    fn pending_path(&self) -> PathBuf {
        self.root.join("execution-v1.migration.pending")
    }

    pub fn load(&self) -> Result<LoadResult, String> {
        let bytes = fs::read(self.state_path()).map_err(|error| {
            format!(
                "read execution state {}: {error}",
                self.state_path().display()
            )
        })?;
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|error| format!("corrupt execution state: {error}"))?;
        let version = value
            .get("schemaVersion")
            .and_then(Value::as_u64)
            .ok_or_else(|| "execution state is missing schemaVersion".to_owned())?
            as u32;
        if version > 1 {
            let state: ExecutionState = serde_json::from_value(value)
                .map_err(|error| format!("newer execution state is unreadable: {error}"))?;
            return Ok(LoadResult {
                state,
                read_only: true,
                warning: Some(format!(
                    "newer schema {version} opened read-only; this build supports schema 1"
                )),
            });
        }
        Ok(LoadResult {
            state: ExecutionState::from_value(value)?,
            read_only: false,
            warning: None,
        })
    }

    pub fn save(&self, state: &ExecutionState) -> Result<(), String> {
        if state.schema_version != 1 {
            return Err("only execution schema 1 can be written".into());
        }
        let bytes = serde_json::to_vec_pretty(state)
            .map_err(|error| format!("serialize execution state: {error}"))?;
        atomic_commit(&self.state_path(), &bytes)
    }

    pub fn migrate_legacy(
        &self,
        source: &Path,
        fault: MigrationFault,
    ) -> Result<MigrationResult, String> {
        if self.state_path().exists() {
            return Ok(MigrationResult {
                state: self.load()?.state,
                imported: false,
            });
        }
        let source_bytes = fs::read(source)
            .map_err(|error| format!("read legacy state {}: {error}", source.display()))?;
        let legacy: LegacyDocument = serde_json::from_slice(&source_bytes)
            .map_err(|error| format!("corrupt legacy state: {error}"))?;
        let state = convert_legacy(legacy)?;
        let staged = serde_json::to_vec_pretty(&state)
            .map_err(|error| format!("serialize migrated state: {error}"))?;
        atomic_commit(&self.pending_path(), &staged)?;
        if fault == MigrationFault::AfterStage {
            return Err("migration interrupted after staging; source is unchanged".into());
        }
        atomic_commit(&self.state_path(), &staged)?;
        let _ = fs::remove_file(self.pending_path());
        Ok(MigrationResult {
            state,
            imported: true,
        })
    }
}

fn convert_legacy(legacy: LegacyDocument) -> Result<ExecutionState, String> {
    let mut state = ExecutionState::new();
    let mut sessions = legacy.sessions;
    sessions.sort_by(|left, right| left.id.cmp(&right.id));
    for session in sessions {
        if session.id.trim().is_empty() {
            return Err("legacy session id is required".into());
        }
        let chat_id = format!("legacy-chat-{}", stable_id(&session.id));
        let task_id = format!("legacy-task-{}", stable_id(&session.id));
        let mut chat_extra = BTreeMap::new();
        chat_extra.insert("archived".to_owned(), Value::Bool(session.archived));
        state.chats.push(ChatSession {
            id: chat_id.clone(),
            task_ids: vec![task_id.clone()],
            provider: None,
            account_id: None,
            continuation_required: false,
            extra: chat_extra,
        });
        let workspace_identity_id = session.workspace.map(|source_path| {
            let id = format!(
                "legacy-workspace-{}",
                stable_id(&format!("{}:{source_path}", session.platform))
            );
            if !state.workspaces.iter().any(|workspace| workspace.id == id) {
                state.workspaces.push(WorkspaceIdentity {
                    id: id.clone(),
                    source_platform: session.platform.clone(),
                    source_path,
                    local_bindings: BTreeMap::new(),
                    extra: BTreeMap::new(),
                });
            }
            id
        });
        state.tasks.push(TaskRun {
            id: task_id,
            chat_id,
            kind: TaskKind::Simple,
            kind_revisions: vec![TaskKindRevision {
                sequence: 1,
                kind: TaskKind::Simple,
                reason: "legacy Super Agent import".to_owned(),
            }],
            goal: session.goal,
            acceptance: Vec::new(),
            plan: Vec::new(),
            evidence_refs: Vec::new(),
            overrides: Vec::new(),
            status: TaskStatus::Suspended,
            scratch_space_id: None,
            workspace_identity_id,
            harness_ref: None,
            epochs: Vec::new(),
            suspended_reason: Some("imported task requires explicit continuation".to_owned()),
            extra: BTreeMap::new(),
        });
    }
    ExecutionState::from_value(
        serde_json::to_value(state).map_err(|error| format!("validate migrated state: {error}"))?,
    )
}

fn stable_id(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn atomic_commit(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    let mut file = File::create(&temporary)
        .map_err(|error| format!("create staged file {}: {error}", temporary.display()))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("write staged file {}: {error}", temporary.display()))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("commit execution state {}: {error}", path.display()))?;
    if let Some(parent) = path.parent() {
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ExecutionStore, MigrationFault};
    use std::fs;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn temp_dir(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("picode-execution-store-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn migration_is_transactional_repeatable_and_preserves_legacy_source() {
        let root = temp_dir("migration");
        let legacy = root.join("super-agent.json");
        let original = r#"{
          "sessions": [
            {"id":"chat-a","goal":"ship it","workspace":"D:\\game","platform":"windows","archived":true}
          ]
        }"#;
        fs::write(&legacy, original).unwrap();
        let store = ExecutionStore::open(root.join("state")).unwrap();

        let interrupted = store
            .migrate_legacy(&legacy, MigrationFault::AfterStage)
            .unwrap_err();
        assert!(interrupted.contains("interrupted"));
        assert!(!store.state_path().exists());
        assert_eq!(fs::read_to_string(&legacy).unwrap(), original);

        let first = store.migrate_legacy(&legacy, MigrationFault::None).unwrap();
        let second = store.migrate_legacy(&legacy, MigrationFault::None).unwrap();
        assert!(first.imported);
        assert!(!second.imported);
        assert_eq!(first.state, second.state);
        assert_eq!(first.state.chats.len(), 1);
        assert_eq!(first.state.chats[0].extra["archived"], true);
        assert_eq!(fs::read_to_string(&legacy).unwrap(), original);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_or_future_data_never_overwrites_committed_state() {
        let root = temp_dir("corrupt");
        let legacy = root.join("legacy.json");
        fs::write(&legacy, "not json").unwrap();
        let store = ExecutionStore::open(root.join("state")).unwrap();
        assert!(store.migrate_legacy(&legacy, MigrationFault::None).is_err());
        assert!(!store.state_path().exists());

        fs::write(
            store.state_path(),
            r#"{"schemaVersion":99,"chats":[],"tasks":[],"workspaces":[],"scratchSpaces":[]}"#,
        )
        .unwrap();
        let loaded = store.load().unwrap();
        assert!(loaded.read_only);
        assert!(loaded.warning.unwrap().contains("newer schema"));
        assert_eq!(loaded.state.schema_version, 99);

        fs::remove_dir_all(root).unwrap();
    }
}
