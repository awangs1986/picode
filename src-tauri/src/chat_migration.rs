use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use percent_encoding::percent_decode_str;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const MAX_SCANS: usize = 8;
const MAX_SCAN_CANDIDATES: usize = 5_000;
const MAX_SOURCE_FILE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_RECORD_TEXT_BYTES: usize = 8 * 1024 * 1024;
const PREVIEW_FULL_FILE_BYTES: u64 = 96 * 1024;
const PREVIEW_HEAD_BYTES: usize = 256 * 1024;
const PREVIEW_FIRST_RECORD_INITIAL_CAPACITY: usize = 32 * 1024;
const PREVIEW_TAIL_BYTES: u64 = 64 * 1024;
const CURSOR_PREVIEW_RANGE_SQL: &str = "SELECT value FROM cursorDiskKV
     WHERE key >= ?1 AND key < ?2
       AND CASE WHEN json_valid(value) THEN
         COALESCE(json_type(value, '$.text') = 'text', 0)
         OR COALESCE(json_type(value, '$.richText') = 'text', 0)
       ELSE 0 END
     ORDER BY rowid DESC";
const CURSOR_RECORDS_RANGE_SQL: &str =
    "SELECT rowid, value FROM cursorDiskKV WHERE key >= ?1 AND key < ?2 ORDER BY rowid";
const CONTEXT_PAGE_RECORD_LIMIT: usize = 100;
const CONTEXT_PAGE_TEXT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatImportCandidate {
    pub id: String,
    pub source: String,
    pub title: String,
    pub original_workspace: Option<String>,
    pub workspace_group_id: String,
    pub archived: bool,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub last_message_snippet: Option<String>,
    pub file_size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportGroup {
    pub id: String,
    pub source: String,
    pub original_workspace: Option<String>,
    pub candidate_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMigrationScan {
    pub scan_id: String,
    pub candidates: Vec<ChatImportCandidate>,
    pub workspace_groups: Vec<WorkspaceImportGroup>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedChat {
    pub candidate_id: String,
    pub source: String,
    pub title: String,
    pub session_file: String,
    pub workspace_path: String,
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub chats: Vec<ImportedChat>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatDeletionResult {
    pub deleted: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatContextPage {
    pub candidate: ChatImportCandidate,
    pub records: Vec<ExternalRecord>,
    pub next_cursor: Option<String>,
    pub complete: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalChatSnapshot {
    schema: String,
    source: String,
    source_id: String,
    title: String,
    original_workspace: Option<String>,
    bound_workspace: String,
    archived: bool,
    created_at: Option<String>,
    imported_at: String,
    records: Vec<ExternalRecord>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalRecord {
    kind: String,
    role: String,
    content: String,
    timestamp: Option<String>,
    model: Option<String>,
    tool_name: Option<String>,
    source_record_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "camelCase")]
enum ContextCursor {
    Jsonl {
        byte_offset: u64,
        record_index: usize,
        previous_hash: Option<String>,
    },
    Cursor {
        row_id: i64,
        record_index: usize,
        previous_hash: Option<String>,
    },
}

#[derive(Debug, Clone)]
enum CandidateSource {
    Jsonl {
        path: PathBuf,
    },
    Cursor {
        database: PathBuf,
        composer_id: String,
    },
}

#[derive(Debug, Clone)]
struct PendingCandidate {
    summary: ChatImportCandidate,
    source_id: String,
    source: CandidateSource,
}

#[derive(Debug, Clone)]
struct PendingScan {
    candidates: Vec<PendingCandidate>,
}

#[derive(Debug)]
struct ImportedChatDeletion {
    candidate_id: String,
    snapshot_path: PathBuf,
}

#[derive(Debug, Clone)]
struct SourceRoots {
    codex_sessions: PathBuf,
    codex_archived: PathBuf,
    claude_projects: PathBuf,
    cursor_database: PathBuf,
    cursor_workspace_storage: PathBuf,
}

impl SourceRoots {
    fn current_user() -> Result<Self, String> {
        let home = dirs::home_dir().ok_or("Cannot locate the current user's home directory")?;
        let config =
            dirs::config_dir().ok_or("Cannot locate the current user's config directory")?;
        let cursor_user = config.join("Cursor").join("User");
        Ok(Self {
            codex_sessions: home.join(".codex").join("sessions"),
            codex_archived: home.join(".codex").join("archived_sessions"),
            claude_projects: home.join(".claude").join("projects"),
            cursor_database: cursor_user.join("globalStorage").join("state.vscdb"),
            cursor_workspace_storage: cursor_user.join("workspaceStorage"),
        })
    }
}

pub struct ChatMigrationService {
    roots: SourceRoots,
    snapshots_dir: PathBuf,
    pi_sessions_dir: PathBuf,
    scans: Mutex<HashMap<String, PendingScan>>,
    index: Mutex<Connection>,
}

impl ChatMigrationService {
    pub fn for_current_user(app_data_dir: &Path) -> Result<Self, String> {
        let home = dirs::home_dir().ok_or("Cannot locate the current user's home directory")?;
        Self::open(
            SourceRoots::current_user()?,
            app_data_dir.join("external-chats"),
            home.join(".pi").join("agent").join("sessions"),
            app_data_dir.join("chat-migrations.sqlite3"),
        )
    }

    fn open(
        roots: SourceRoots,
        snapshots_dir: PathBuf,
        pi_sessions_dir: PathBuf,
        index_path: PathBuf,
    ) -> Result<Self, String> {
        if let Some(parent) = index_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Cannot create chat-migration directory {}: {error}",
                    parent.display()
                )
            })?;
        }
        let index = Connection::open(&index_path).map_err(|error| {
            format!(
                "Cannot open chat-migration index {}: {error}",
                index_path.display()
            )
        })?;
        index
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS imported_chats (
                    candidate_id TEXT PRIMARY KEY,
                    source TEXT NOT NULL,
                    source_id TEXT NOT NULL,
                    original_workspace TEXT,
                    bound_workspace TEXT NOT NULL,
                    snapshot_path TEXT NOT NULL,
                    session_path TEXT NOT NULL,
                    archived INTEGER NOT NULL,
                    imported_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS workspace_bindings (
                    group_id TEXT PRIMARY KEY,
                    source TEXT NOT NULL,
                    original_workspace TEXT,
                    target_workspace TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );",
            )
            .map_err(|error| format!("Cannot initialize chat-migration index: {error}"))?;
        restrict_file_permissions(&index_path)?;
        Ok(Self {
            roots,
            snapshots_dir,
            pi_sessions_dir,
            scans: Mutex::new(HashMap::new()),
            index: Mutex::new(index),
        })
    }

    pub fn scan_local(&self, requested_sources: &[String]) -> Result<ChatMigrationScan, String> {
        let sources = normalize_sources(requested_sources)?;
        let mut candidates = Vec::new();
        let mut warnings = Vec::new();
        if sources.contains("codex") {
            self.scan_codex_dir(
                &self.roots.codex_sessions,
                false,
                &mut candidates,
                &mut warnings,
            )?;
            self.scan_codex_dir(
                &self.roots.codex_archived,
                true,
                &mut candidates,
                &mut warnings,
            )?;
        }
        if sources.contains("claude") {
            self.scan_claude(&mut candidates, &mut warnings)?;
        }
        if sources.contains("cursor") {
            self.scan_cursor(&mut candidates, &mut warnings)?;
        }
        deduplicate_candidates(&mut candidates);
        candidates.sort_by(|a, b| {
            b.summary
                .updated_at
                .cmp(&a.summary.updated_at)
                .then_with(|| b.summary.created_at.cmp(&a.summary.created_at))
        });
        if candidates.len() > MAX_SCAN_CANDIDATES {
            candidates.truncate(MAX_SCAN_CANDIDATES);
            warnings.push(format!(
                "Only the newest {MAX_SCAN_CANDIDATES} chats are shown in one scan"
            ));
        }

        let mut grouped: HashMap<String, WorkspaceImportGroup> = HashMap::new();
        for candidate in &candidates {
            grouped
                .entry(candidate.summary.workspace_group_id.clone())
                .and_modify(|group| group.candidate_count += 1)
                .or_insert_with(|| WorkspaceImportGroup {
                    id: candidate.summary.workspace_group_id.clone(),
                    source: candidate.summary.source.clone(),
                    original_workspace: candidate.summary.original_workspace.clone(),
                    candidate_count: 1,
                });
        }
        let mut workspace_groups: Vec<_> = grouped.into_values().collect();
        workspace_groups.sort_by(|a, b| {
            a.source
                .cmp(&b.source)
                .then_with(|| a.original_workspace.cmp(&b.original_workspace))
        });

        let scan_id = Uuid::new_v4().to_string();
        let summaries = candidates.iter().map(|item| item.summary.clone()).collect();
        let mut scans = self
            .scans
            .lock()
            .map_err(|_| "The chat-migration scan lock is poisoned".to_string())?;
        if scans.len() >= MAX_SCANS {
            if let Some(oldest) = scans.keys().next().cloned() {
                scans.remove(&oldest);
            }
        }
        scans.insert(scan_id.clone(), PendingScan { candidates });
        Ok(ChatMigrationScan {
            scan_id,
            candidates: summaries,
            workspace_groups,
            warnings,
        })
    }

    pub fn import_selected(
        &self,
        scan_id: &str,
        selected_ids: &[String],
        workspace_bindings: &HashMap<String, String>,
        include_reasoning: bool,
    ) -> Result<ChatImportResult, String> {
        if selected_ids.is_empty() {
            return Err("Select at least one chat to import".to_string());
        }
        let selected_set: HashSet<&str> = selected_ids.iter().map(String::as_str).collect();
        if selected_set.len() != selected_ids.len() {
            return Err("The selected chat list contains duplicates".to_string());
        }
        let pending = {
            let scans = self
                .scans
                .lock()
                .map_err(|_| "The chat-migration scan lock is poisoned".to_string())?;
            scans
                .get(scan_id)
                .cloned()
                .ok_or("The chat scan expired. Scan this computer again")?
        };
        let selected: Vec<_> = pending
            .candidates
            .into_iter()
            .filter(|item| selected_set.contains(item.summary.id.as_str()))
            .collect();
        if selected.len() != selected_ids.len() {
            return Err("One or more selected chats do not belong to this scan".to_string());
        }

        let mut resolved_bindings = HashMap::new();
        for candidate in &selected {
            let group_id = &candidate.summary.workspace_group_id;
            if resolved_bindings.contains_key(group_id) {
                continue;
            }
            let requested = workspace_bindings
                .get(group_id)
                .ok_or_else(|| format!("Workspace group {group_id} must be bound before import"))?;
            resolved_bindings.insert(group_id.clone(), canonical_workspace(requested)?);
        }

        let mut imported = Vec::new();
        let mut skipped = 0;
        for candidate in selected {
            let workspace = resolved_bindings
                .get(&candidate.summary.workspace_group_id)
                .expect("validated above");
            if let Some(existing) = self.existing_import(&candidate.summary.id)? {
                imported.push(existing);
                skipped += 1;
                continue;
            }
            let records = self.load_records(&candidate)?;
            if records.is_empty() {
                return Err(format!(
                    "No readable messages were found in {}",
                    candidate.summary.title
                ));
            }
            let imported_chat =
                self.write_import(&candidate, workspace, records, include_reasoning)?;
            imported.push(imported_chat);
        }
        Ok(ChatImportResult {
            imported: imported.len().saturating_sub(skipped),
            skipped,
            chats: imported,
        })
    }

    /// Read one bounded page from a candidate that belongs to a live scan.
    /// The browser never supplies a filesystem path or Cursor database key;
    /// those remain in the scan-owned candidate stored by the native host.
    pub fn context_page(
        &self,
        scan_id: &str,
        candidate_id: &str,
        cursor: Option<&str>,
    ) -> Result<ChatContextPage, String> {
        self.context_page_with_auxiliary(scan_id, candidate_id, cursor, false)
    }

    fn context_page_with_auxiliary(
        &self,
        scan_id: &str,
        candidate_id: &str,
        cursor: Option<&str>,
        include_auxiliary: bool,
    ) -> Result<ChatContextPage, String> {
        let candidate = self.pending_candidate(scan_id, candidate_id)?;
        let decoded = cursor.map(decode_context_cursor).transpose()?;
        let (records, next_cursor) = match &candidate.source {
            CandidateSource::Jsonl { path } if candidate.summary.source == "codex" => {
                load_jsonl_context_page(path, "codex", decoded, include_auxiliary)?
            }
            CandidateSource::Jsonl { path } if candidate.summary.source == "claude" => {
                load_jsonl_context_page(path, "claude", decoded, include_auxiliary)?
            }
            CandidateSource::Cursor {
                database,
                composer_id,
            } => load_cursor_context_page(database, composer_id, decoded, include_auxiliary)?,
            _ => return Err("Unsupported chat source".to_string()),
        };
        let next_cursor = next_cursor.map(encode_context_cursor).transpose()?;
        Ok(ChatContextPage {
            candidate: candidate.summary,
            complete: next_cursor.is_none(),
            records,
            next_cursor,
        })
    }

    pub fn candidate_summary(
        &self,
        scan_id: &str,
        candidate_id: &str,
    ) -> Result<ChatImportCandidate, String> {
        Ok(self.pending_candidate(scan_id, candidate_id)?.summary)
    }

    fn pending_candidate(
        &self,
        scan_id: &str,
        candidate_id: &str,
    ) -> Result<PendingCandidate, String> {
        let scans = self
            .scans
            .lock()
            .map_err(|_| "The chat-migration scan lock is poisoned".to_string())?;
        let scan = scans
            .get(scan_id)
            .ok_or("The chat scan expired. Scan this computer again")?;
        scan.candidates
            .iter()
            .find(|candidate| candidate.summary.id == candidate_id)
            .cloned()
            .ok_or("The selected chat does not belong to this scan".to_string())
    }

    fn scan_codex_dir(
        &self,
        root: &Path,
        archived: bool,
        output: &mut Vec<PendingCandidate>,
        warnings: &mut Vec<String>,
    ) -> Result<(), String> {
        if !root.exists() {
            return Ok(());
        }
        let files = collect_jsonl_files(root, 6)?;
        for path in files {
            match codex_candidate(&path, archived) {
                Ok(Some(candidate)) => output.push(candidate),
                Ok(None) => {}
                Err(error) => warnings.push(error),
            }
        }
        Ok(())
    }

    fn scan_claude(
        &self,
        output: &mut Vec<PendingCandidate>,
        warnings: &mut Vec<String>,
    ) -> Result<(), String> {
        let root = &self.roots.claude_projects;
        if !root.exists() {
            return Ok(());
        }
        let projects = fs::read_dir(root)
            .map_err(|error| format!("Cannot scan Claude projects {}: {error}", root.display()))?;
        for project in projects.flatten() {
            if !project
                .file_type()
                .map(|kind| kind.is_dir())
                .unwrap_or(false)
            {
                continue;
            }
            let Ok(entries) = fs::read_dir(project.path()) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                    continue;
                }
                match claude_candidate(&path) {
                    Ok(Some(candidate)) => output.push(candidate),
                    Ok(None) => {}
                    Err(error) => warnings.push(error),
                }
            }
        }
        Ok(())
    }

    fn scan_cursor(
        &self,
        output: &mut Vec<PendingCandidate>,
        warnings: &mut Vec<String>,
    ) -> Result<(), String> {
        let database = &self.roots.cursor_database;
        if !database.exists() {
            return Ok(());
        }
        let connection = match open_cursor_database(database) {
            Ok(connection) => connection,
            Err(error) => {
                warnings.push(error);
                return Ok(());
            }
        };
        let has_headers: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='composerHeaders')",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !has_headers {
            warnings.push("This Cursor database does not expose composerHeaders".to_string());
            return Ok(());
        }
        let has_is_subagent = connection
            .prepare("PRAGMA table_info(composerHeaders)")
            .and_then(|mut statement| {
                let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
                for column in columns {
                    if column.as_deref() == Ok("isSubagent") {
                        return Ok(true);
                    }
                }
                Ok(false)
            })
            .map_err(|error| format!("Cannot inspect Cursor chat columns: {error}"))?;
        let header_query = if has_is_subagent {
            "SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
                    COALESCE(isSubagent, 0), value
             FROM composerHeaders ORDER BY lastUpdatedAt DESC LIMIT ?1"
        } else {
            "SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived,
                    0, value
             FROM composerHeaders ORDER BY lastUpdatedAt DESC LIMIT ?1"
        };
        let mut statement = connection
            .prepare(header_query)
            .map_err(|error| format!("Cannot inspect Cursor chat headers: {error}"))?;
        let rows = statement
            .query_map([MAX_SCAN_CANDIDATES as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, Option<i64>>(4)?.unwrap_or(0) != 0,
                    row.get::<_, i64>(5)? != 0,
                    row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                ))
            })
            .map_err(|error| format!("Cannot scan Cursor chat headers: {error}"))?;
        let mut headers = Vec::new();
        for row in rows {
            match row {
                Ok(value) => headers.push(value),
                Err(error) => warnings.push(format!("Cannot read a Cursor chat header: {error}")),
            }
        }
        drop(statement);
        headers.retain(|(_, _, _, _, _, is_subagent, raw_header)| {
            if *is_subagent {
                return false;
            }
            let header: Value = serde_json::from_str(raw_header).unwrap_or(Value::Null);
            !cursor_header_is_internal(&header)
        });
        let composer_ids: HashSet<String> = headers
            .iter()
            .map(|(composer_id, _, _, _, _, _, _)| composer_id.clone())
            .collect();
        let previews = cursor_candidate_previews(&connection, &composer_ids, warnings)?;

        for (composer_id, workspace_id, created_at, updated_at, archived, _, raw_header) in headers
        {
            let header: Value = serde_json::from_str(&raw_header).unwrap_or(Value::Null);
            let Some((last_message_snippet, preview_bytes)) = previews.get(&composer_id).cloned()
            else {
                continue;
            };
            let file_size_bytes = (raw_header.len() as u64).saturating_add(preview_bytes);
            let title = value_string(&header, &["name", "title", "subtitle"])
                .and_then(meaningful_chat_text)
                .unwrap_or_else(|| "Untitled Cursor chat".to_string());
            let workspace = cursor_workspace(
                &header,
                workspace_id.as_deref(),
                &self.roots.cursor_workspace_storage,
            );
            let group_id = workspace_group_id("cursor", workspace.as_deref());
            let id = candidate_id("cursor", &composer_id);
            output.push(PendingCandidate {
                summary: ChatImportCandidate {
                    id,
                    source: "cursor".to_string(),
                    title: clean_title(&title),
                    original_workspace: workspace,
                    workspace_group_id: group_id,
                    archived,
                    created_at: created_at.map(iso_from_unix_millis),
                    updated_at: updated_at.map(iso_from_unix_millis),
                    last_message_snippet,
                    file_size_bytes,
                },
                source_id: composer_id.clone(),
                source: CandidateSource::Cursor {
                    database: database.clone(),
                    composer_id,
                },
            });
        }
        Ok(())
    }

    fn load_records(&self, candidate: &PendingCandidate) -> Result<Vec<ExternalRecord>, String> {
        let records = match &candidate.source {
            CandidateSource::Jsonl { path } if candidate.summary.source == "codex" => {
                load_codex_records(path)?
            }
            CandidateSource::Jsonl { path } if candidate.summary.source == "claude" => {
                load_claude_records(path)?
            }
            CandidateSource::Cursor {
                database,
                composer_id,
            } => load_cursor_records(database, composer_id)?,
            _ => return Err("Unsupported chat source".to_string()),
        };
        Ok(deduplicate_records(records))
    }

    fn existing_import(&self, candidate_id: &str) -> Result<Option<ImportedChat>, String> {
        let index = self
            .index
            .lock()
            .map_err(|_| "The chat-migration index lock is poisoned".to_string())?;
        index
            .query_row(
                "SELECT source, session_path, bound_workspace, archived
                 FROM imported_chats WHERE candidate_id = ?1",
                [candidate_id],
                |row| {
                    Ok(ImportedChat {
                        candidate_id: candidate_id.to_string(),
                        source: row.get(0)?,
                        title: "Already imported".to_string(),
                        session_file: row.get(1)?,
                        workspace_path: row.get(2)?,
                        archived: row.get::<_, i64>(3)? != 0,
                    })
                },
            )
            .optional()
            .map_err(|error| format!("Cannot read the chat-migration index: {error}"))
    }

    fn write_import(
        &self,
        candidate: &PendingCandidate,
        workspace: &str,
        records: Vec<ExternalRecord>,
        include_reasoning: bool,
    ) -> Result<ImportedChat, String> {
        fs::create_dir_all(&self.snapshots_dir).map_err(|error| {
            format!(
                "Cannot create external-chat storage {}: {error}",
                self.snapshots_dir.display()
            )
        })?;
        let imported_at = now_iso();
        let snapshot_path = self
            .snapshots_dir
            .join(format!("{}.json", candidate.summary.id));
        let snapshot = ExternalChatSnapshot {
            schema: "picot.external-chat/v1".to_string(),
            source: candidate.summary.source.clone(),
            source_id: candidate.source_id.clone(),
            title: candidate.summary.title.clone(),
            original_workspace: candidate.summary.original_workspace.clone(),
            bound_workspace: workspace.to_string(),
            archived: candidate.summary.archived,
            created_at: candidate.summary.created_at.clone(),
            imported_at: imported_at.clone(),
            records,
        };
        let snapshot_bytes = serde_json::to_vec_pretty(&snapshot)
            .map_err(|error| format!("Cannot encode external chat snapshot: {error}"))?;
        let session_dir = self.pi_sessions_dir.join(pi_session_dir_name(workspace));
        fs::create_dir_all(&session_dir).map_err(|error| {
            format!(
                "Cannot create Pi session directory {}: {error}",
                session_dir.display()
            )
        })?;
        let session_path = session_dir.join(format!("imported-{}.jsonl", candidate.summary.id));
        let session_bytes =
            build_pi_continuation_session(candidate, workspace, &snapshot, include_reasoning)?;

        atomic_write_new(&snapshot_path, &snapshot_bytes)?;
        if let Err(error) = atomic_write_new(&session_path, &session_bytes) {
            let _ = fs::remove_file(&snapshot_path);
            return Err(error);
        }
        let index_result = (|| {
            let mut index = self
                .index
                .lock()
                .map_err(|_| "The chat-migration index lock is poisoned".to_string())?;
            let transaction = index
                .transaction()
                .map_err(|error| format!("Cannot start chat-import transaction: {error}"))?;
            transaction
                .execute(
                    "INSERT INTO workspace_bindings
                     (group_id, source, original_workspace, target_workspace, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(group_id) DO UPDATE SET
                       target_workspace=excluded.target_workspace,
                       updated_at=excluded.updated_at",
                    params![
                        candidate.summary.workspace_group_id,
                        candidate.summary.source,
                        candidate.summary.original_workspace,
                        workspace,
                        imported_at,
                    ],
                )
                .map_err(|error| format!("Cannot save workspace binding: {error}"))?;
            transaction
                .execute(
                    "INSERT INTO imported_chats
                     (candidate_id, source, source_id, original_workspace, bound_workspace,
                      snapshot_path, session_path, archived, imported_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        candidate.summary.id,
                        candidate.summary.source,
                        candidate.source_id,
                        candidate.summary.original_workspace,
                        workspace,
                        snapshot_path.to_string_lossy(),
                        session_path.to_string_lossy(),
                        i64::from(candidate.summary.archived),
                        imported_at,
                    ],
                )
                .map_err(|error| format!("Cannot index imported chat: {error}"))?;
            transaction
                .commit()
                .map_err(|error| format!("Cannot commit chat import: {error}"))
        })();
        if let Err(error) = index_result {
            let _ = fs::remove_file(&session_path);
            let _ = fs::remove_file(&snapshot_path);
            return Err(error);
        }
        Ok(ImportedChat {
            candidate_id: candidate.summary.id.clone(),
            source: candidate.summary.source.clone(),
            title: candidate.summary.title.clone(),
            session_file: session_path.to_string_lossy().into_owned(),
            workspace_path: workspace.to_string(),
            archived: candidate.summary.archived,
        })
    }

    pub fn delete_sessions(
        &self,
        requested_paths: &[String],
    ) -> Result<ChatDeletionResult, String> {
        let mut deleted = 0_usize;
        let mut errors = Vec::new();
        let mut seen = HashSet::new();
        for requested in requested_paths {
            if !seen.insert(workspace_identity_key(requested)) {
                continue;
            }
            match self.delete_one_session(requested) {
                Ok(()) => deleted += 1,
                Err(error) => {
                    log::warn!("[chat-delete] cannot delete {}: {}", requested, error);
                    errors.push(requested.clone());
                }
            }
        }
        Ok(ChatDeletionResult { deleted, errors })
    }

    fn delete_one_session(&self, requested: &str) -> Result<(), String> {
        let requested_path = PathBuf::from(requested);
        if requested_path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            return Err("Only Pi JSONL session files can be deleted".to_string());
        }
        let sessions_root = fs::canonicalize(&self.pi_sessions_dir).map_err(|error| {
            format!(
                "Cannot resolve Pi sessions root {}: {error}",
                self.pi_sessions_dir.display()
            )
        })?;
        let session_path = fs::canonicalize(&requested_path).map_err(|error| {
            format!("Cannot resolve chat {}: {error}", requested_path.display())
        })?;
        if !session_path.is_file() || !session_path.starts_with(&sessions_root) {
            return Err("The requested chat is outside the Pi sessions directory".to_string());
        }

        let imported = self.imported_deletion_for_session(&session_path)?;
        let snapshot_path = imported
            .as_ref()
            .map(|record| record.snapshot_path.as_path())
            .filter(|path| path.exists())
            .map(|path| {
                let snapshots_root = fs::canonicalize(&self.snapshots_dir).map_err(|error| {
                    format!(
                        "Cannot resolve imported-chat storage {}: {error}",
                        self.snapshots_dir.display()
                    )
                })?;
                let canonical = fs::canonicalize(path).map_err(|error| {
                    format!(
                        "Cannot resolve imported snapshot {}: {error}",
                        path.display()
                    )
                })?;
                if !canonical.is_file() || !canonical.starts_with(snapshots_root) {
                    return Err("The imported snapshot is outside Picode storage".to_string());
                }
                Ok(canonical)
            })
            .transpose()?;

        let mut staged = Vec::new();
        stage_for_deletion(&session_path, &mut staged)?;
        if let Some(snapshot_path) = snapshot_path {
            if let Err(error) = stage_for_deletion(&snapshot_path, &mut staged) {
                restore_staged_files(&staged)?;
                return Err(error);
            }
        }

        if let Some(imported) = imported {
            let index_result = (|| {
                let mut index = self
                    .index
                    .lock()
                    .map_err(|_| "The chat-migration index lock is poisoned".to_string())?;
                let transaction = index
                    .transaction()
                    .map_err(|error| format!("Cannot start chat-deletion transaction: {error}"))?;
                let affected = transaction
                    .execute(
                        "DELETE FROM imported_chats WHERE candidate_id = ?1",
                        [imported.candidate_id],
                    )
                    .map_err(|error| format!("Cannot remove imported-chat index: {error}"))?;
                if affected != 1 {
                    return Err("The imported-chat index changed during deletion".to_string());
                }
                transaction
                    .commit()
                    .map_err(|error| format!("Cannot commit chat deletion: {error}"))
            })();
            if let Err(error) = index_result {
                restore_staged_files(&staged)?;
                return Err(error);
            }
        }

        for (_, staged_path) in staged {
            if let Err(error) = fs::remove_file(&staged_path) {
                log::warn!(
                    "[chat-delete] logical deletion committed but staged file cleanup failed for {}: {}",
                    staged_path.display(),
                    error
                );
            }
        }
        Ok(())
    }

    fn imported_deletion_for_session(
        &self,
        canonical_session: &Path,
    ) -> Result<Option<ImportedChatDeletion>, String> {
        let index = self
            .index
            .lock()
            .map_err(|_| "The chat-migration index lock is poisoned".to_string())?;
        let mut statement = index
            .prepare("SELECT candidate_id, snapshot_path, session_path FROM imported_chats")
            .map_err(|error| format!("Cannot inspect imported-chat index: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| format!("Cannot read imported-chat index: {error}"))?;
        for row in rows {
            let (candidate_id, snapshot_path, session_path) =
                row.map_err(|error| format!("Cannot read imported-chat row: {error}"))?;
            let Ok(indexed_session) = fs::canonicalize(&session_path) else {
                continue;
            };
            if indexed_session == canonical_session {
                return Ok(Some(ImportedChatDeletion {
                    candidate_id,
                    snapshot_path: PathBuf::from(snapshot_path),
                }));
            }
        }
        Ok(None)
    }
}

fn stage_for_deletion(path: &Path, staged: &mut Vec<(PathBuf, PathBuf)>) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("Cannot determine the chat filename for {}", path.display()))?;
    let staged_path = path.with_file_name(format!(".{file_name}.picode-delete-{}", Uuid::new_v4()));
    fs::rename(path, &staged_path)
        .map_err(|error| format!("Cannot stage {} for deletion: {error}", path.display()))?;
    staged.push((path.to_path_buf(), staged_path));
    Ok(())
}

fn restore_staged_files(staged: &[(PathBuf, PathBuf)]) -> Result<(), String> {
    for (original, staged_path) in staged.iter().rev() {
        if !staged_path.exists() {
            continue;
        }
        fs::rename(staged_path, original).map_err(|error| {
            format!(
                "Cannot restore {} after deletion failed: {error}",
                original.display()
            )
        })?;
    }
    Ok(())
}

fn deduplicate_candidates(candidates: &mut Vec<PendingCandidate>) {
    let mut seen = HashSet::new();
    candidates.retain(|candidate| seen.insert(candidate.summary.id.clone()));
}

fn normalize_sources(requested: &[String]) -> Result<HashSet<&'static str>, String> {
    let mut sources = HashSet::new();
    let requested: Vec<&str> = if requested.is_empty() {
        vec!["codex", "cursor", "claude"]
    } else {
        requested.iter().map(|value| value.trim()).collect()
    };
    for source in requested {
        match source.to_ascii_lowercase().as_str() {
            "codex" => {
                sources.insert("codex");
            }
            "cursor" => {
                sources.insert("cursor");
            }
            "claude" => {
                sources.insert("claude");
            }
            _ => return Err(format!("Unsupported chat source: {source}")),
        }
    }
    Ok(sources)
}

fn candidate_id(source: &str, source_id: &str) -> String {
    stable_hash(&format!("candidate\0{source}\0{source_id}"))
}

fn workspace_group_id(source: &str, workspace: Option<&str>) -> String {
    let workspace = workspace.map(workspace_identity_key);
    stable_hash(&format!(
        "workspace\0{source}\0{}",
        workspace.as_deref().unwrap_or("<unassigned>")
    ))
}

fn workspace_identity_key(workspace: &str) -> String {
    let mut normalized = workspace.trim().replace('\\', "/");
    if slash_prefixed_windows_drive(&normalized) {
        normalized.remove(0);
    }
    while normalized.len() > 3 && normalized.ends_with('/') {
        normalized.pop();
    }
    if windows_drive_path(&normalized) || normalized.starts_with("//") {
        normalized.make_ascii_lowercase();
    }
    normalized
}

fn stable_hash(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn clean_title(value: &str) -> String {
    let clean = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.is_empty() {
        return "Untitled chat".to_string();
    }
    clean.chars().take(160).collect()
}

fn clean_message_snippet(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(280)
        .collect()
}

fn meaningful_chat_text(value: String) -> Option<String> {
    let trimmed = value.trim_start_matches('\u{feff}').trim_start();
    const IMPORT_SCAFFOLDING_PREFIXES: &[&str] = &[
        "<environment_context>",
        "<recommended_plugins>",
        "<permissions instructions>",
        "<app-context>",
        "<collaboration_mode>",
        "<plugins_instructions>",
        "<skills_instructions>",
    ];
    if trimmed.is_empty()
        || IMPORT_SCAFFOLDING_PREFIXES
            .iter()
            .any(|prefix| trimmed.starts_with(prefix))
    {
        return None;
    }
    Some(value)
}

fn source_file_size(path: &Path) -> Result<u64, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Cannot inspect chat file {}: {error}", path.display()))?;
    if metadata.len() > MAX_SOURCE_FILE_BYTES {
        return Err(format!(
            "Chat file {} exceeds the {} MiB safety limit",
            path.display(),
            MAX_SOURCE_FILE_BYTES / 1024 / 1024
        ));
    }
    Ok(metadata.len())
}

fn collect_jsonl_files(root: &Path, max_depth: usize) -> Result<Vec<PathBuf>, String> {
    let mut output = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0_usize)];
    while let Some((directory, depth)) = stack.pop() {
        let entries = fs::read_dir(&directory).map_err(|error| {
            format!(
                "Cannot scan chat directory {}: {error}",
                directory.display()
            )
        })?;
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() && depth < max_depth {
                stack.push((path, depth + 1));
            } else if kind.is_file()
                && path.extension().and_then(|value| value.to_str()) == Some("jsonl")
            {
                output.push(path);
            }
        }
    }
    Ok(output)
}

fn check_source_size(path: &Path) -> Result<(), String> {
    source_file_size(path).map(|_| ())
}

fn open_lines(path: &Path) -> Result<impl Iterator<Item = Result<String, std::io::Error>>, String> {
    check_source_size(path)?;
    let file = File::open(path)
        .map_err(|error| format!("Cannot open chat file {}: {error}", path.display()))?;
    Ok(BufReader::new(file).lines())
}

fn preview_json_values(path: &Path) -> Result<(u64, Vec<Value>), String> {
    let file_size = source_file_size(path)?;
    let mut file = File::open(path)
        .map_err(|error| format!("Cannot open chat file {}: {error}", path.display()))?;
    let mut chunks = Vec::with_capacity(2);
    if file_size <= PREVIEW_FULL_FILE_BYTES {
        let mut bytes = Vec::with_capacity(file_size as usize);
        file.read_to_end(&mut bytes)
            .map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
        chunks.push(bytes);
    } else {
        let head_file = File::open(path)
            .map_err(|error| format!("Cannot open chat file {}: {error}", path.display()))?;
        let mut bounded_head = BufReader::new(head_file).take(MAX_RECORD_TEXT_BYTES as u64 + 1);
        let mut head = Vec::with_capacity(PREVIEW_FIRST_RECORD_INITIAL_CAPACITY);
        bounded_head.read_until(b'\n', &mut head).map_err(|error| {
            format!(
                "Cannot read the first record of {}: {error}",
                path.display()
            )
        })?;
        if head.len() == MAX_RECORD_TEXT_BYTES + 1 && !head.ends_with(b"\n") {
            return Err(format!(
                "The first chat record in {} exceeds the {} MiB safety limit",
                path.display(),
                MAX_RECORD_TEXT_BYTES / 1024 / 1024
            ));
        }
        if head.len() < PREVIEW_HEAD_BYTES {
            let remaining = PREVIEW_HEAD_BYTES - head.len();
            let mut additional = Vec::with_capacity(remaining);
            bounded_head
                .take(remaining as u64)
                .read_to_end(&mut additional)
                .map_err(|error| format!("Cannot read the start of {}: {error}", path.display()))?;
            head.extend_from_slice(&additional);
        }
        chunks.push(head);

        let tail_start = file_size.saturating_sub(PREVIEW_TAIL_BYTES);
        file.seek(SeekFrom::Start(tail_start))
            .map_err(|error| format!("Cannot seek in {}: {error}", path.display()))?;
        let mut tail = Vec::with_capacity(PREVIEW_TAIL_BYTES as usize);
        file.read_to_end(&mut tail)
            .map_err(|error| format!("Cannot read the end of {}: {error}", path.display()))?;
        if tail_start > 0 {
            if let Some(first_newline) = tail.iter().position(|byte| *byte == b'\n') {
                tail.drain(..=first_newline);
            } else {
                tail.clear();
            }
        }
        chunks.push(tail);
    }

    let values = chunks
        .iter()
        .flat_map(|chunk| chunk.split(|byte| *byte == b'\n'))
        .filter(|line| !line.is_empty())
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .collect();
    Ok((file_size, values))
}

fn codex_candidate(path: &Path, archived: bool) -> Result<Option<PendingCandidate>, String> {
    let mut source_id = None;
    let mut workspace = None;
    let mut title = None;
    let mut created_at = None;
    let mut last_message_snippet = None;
    let mut last_message_at = None;
    let (file_size_bytes, values) = preview_json_values(path)?;
    for value in values {
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let payload = value.get("payload").unwrap_or(&Value::Null);
        if created_at.is_none() {
            created_at = value
                .get("timestamp")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        if kind == "session_meta" {
            if codex_session_is_internal(payload) {
                return Ok(None);
            }
            source_id = value_string(payload, &["id", "session_id"]);
            workspace = value_string(payload, &["cwd"]);
            title = title.or_else(|| {
                value_string(payload, &["title", "name", "thread_name"])
                    .and_then(meaningful_chat_text)
                    .map(|text| clean_title(&text))
            });
            if created_at.is_none() {
                created_at = value_string(payload, &["timestamp"]);
            }
        }
        if let Some((role, text)) = codex_conversation_text(&value) {
            if title.is_none() && role == "user" {
                title = Some(clean_title(&text));
            }
            last_message_snippet = Some(clean_message_snippet(&text));
            if let Some(timestamp) = value_string(&value, &["timestamp"]) {
                last_message_at = Some(timestamp);
            }
        }
    }
    let source_id = source_id.or_else(|| {
        path.file_stem()
            .and_then(|value| value.to_str())
            .map(str::to_string)
    });
    let Some(source_id) = source_id else {
        return Ok(None);
    };
    let title = title.unwrap_or_else(|| "Untitled Codex chat".to_string());
    let updated_at = last_message_at.or_else(|| file_modified_iso(path));
    Ok(Some(PendingCandidate {
        summary: ChatImportCandidate {
            id: candidate_id("codex", &source_id),
            source: "codex".to_string(),
            title,
            original_workspace: workspace.clone(),
            workspace_group_id: workspace_group_id("codex", workspace.as_deref()),
            archived,
            created_at,
            updated_at,
            last_message_snippet,
            file_size_bytes,
        },
        source_id,
        source: CandidateSource::Jsonl {
            path: path.to_path_buf(),
        },
    }))
}

fn codex_session_is_internal(payload: &Value) -> bool {
    payload.get("thread_source").and_then(Value::as_str) == Some("subagent")
        || payload
            .get("source")
            .and_then(|source| source.get("subagent"))
            .is_some()
}

fn claude_candidate(path: &Path) -> Result<Option<PendingCandidate>, String> {
    let mut source_id = None;
    let mut workspace = None;
    let mut title = None;
    let mut created_at = None;
    let mut archived = false;
    let mut last_message_snippet = None;
    let mut last_message_at = None;
    let (file_size_bytes, values) = preview_json_values(path)?;
    for value in values {
        source_id = source_id.or_else(|| value_string(&value, &["sessionId"]));
        workspace = workspace.or_else(|| value_string(&value, &["cwd"]));
        created_at = created_at.or_else(|| value_string(&value, &["timestamp"]));
        archived |= value
            .get("isArchived")
            .or_else(|| value.get("archived"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        title = title.or_else(|| {
            value_string(&value, &["title", "name", "summary"])
                .and_then(meaningful_chat_text)
                .map(|text| clean_title(&text))
        });
        if matches!(
            value.get("type").and_then(Value::as_str),
            Some("user" | "assistant")
        ) {
            if let Some(text) = message_text(value.get("message").unwrap_or(&Value::Null))
                .and_then(meaningful_chat_text)
            {
                if title.is_none() && value.get("type").and_then(Value::as_str) == Some("user") {
                    title = Some(clean_title(&text));
                }
                last_message_snippet = Some(clean_message_snippet(&text));
                if let Some(timestamp) = value_string(&value, &["timestamp"]) {
                    last_message_at = Some(timestamp);
                }
            }
        }
    }
    let source_id = source_id.or_else(|| {
        path.file_stem()
            .and_then(|value| value.to_str())
            .map(str::to_string)
    });
    let Some(source_id) = source_id else {
        return Ok(None);
    };
    Ok(Some(PendingCandidate {
        summary: ChatImportCandidate {
            id: candidate_id("claude", &source_id),
            source: "claude".to_string(),
            title: title.unwrap_or_else(|| "Untitled Claude chat".to_string()),
            original_workspace: workspace.clone(),
            workspace_group_id: workspace_group_id("claude", workspace.as_deref()),
            archived,
            created_at,
            updated_at: last_message_at.or_else(|| file_modified_iso(path)),
            last_message_snippet,
            file_size_bytes,
        },
        source_id,
        source: CandidateSource::Jsonl {
            path: path.to_path_buf(),
        },
    }))
}

fn codex_conversation_text(value: &Value) -> Option<(&'static str, String)> {
    let kind = value.get("type")?.as_str()?;
    let payload = value.get("payload")?;
    let payload_kind = payload.get("type").and_then(Value::as_str);
    if kind == "event_msg" && payload_kind == Some("user_message") {
        return value_string(payload, &["message", "text"])
            .and_then(meaningful_chat_text)
            .map(|text| ("user", text));
    }
    if kind == "event_msg" && payload_kind == Some("agent_message") {
        return value_string(payload, &["message", "text"])
            .and_then(meaningful_chat_text)
            .map(|text| ("assistant", text));
    }
    if kind == "response_item" && payload_kind == Some("message") {
        let role = match payload.get("role").and_then(Value::as_str) {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => return None,
        };
        return message_text(payload)
            .and_then(meaningful_chat_text)
            .map(|text| (role, text));
    }
    None
}

fn open_cursor_database(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| {
        format!(
            "Cannot open Cursor chat database {}: {error}",
            path.display()
        )
    })
}

fn cursor_candidate_previews(
    connection: &Connection,
    composer_ids: &HashSet<String>,
    warnings: &mut Vec<String>,
) -> Result<HashMap<String, (Option<String>, u64)>, String> {
    let has_messages: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='cursorDiskKV')",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);
    if !has_messages {
        return Ok(HashMap::new());
    }
    let mut statement = connection
        .prepare(CURSOR_PREVIEW_RANGE_SQL)
        .map_err(|error| format!("Cannot prepare Cursor preview lookup: {error}"))?;
    let mut previews = HashMap::new();
    for composer_id in composer_ids {
        let (lower_bound, upper_bound) = cursor_bubble_key_range(composer_id);
        let rows = match statement.query_map(params![lower_bound, upper_bound], |row| {
            row.get::<_, String>(0)
        }) {
            Ok(rows) => rows,
            Err(error) => {
                warnings.push(format!("Cannot read a Cursor chat preview: {error}"));
                continue;
            }
        };
        let mut snippet = None;
        let mut preview_bytes = 0_u64;
        for row in rows {
            let raw = match row {
                Ok(value) => value,
                Err(error) => {
                    warnings.push(format!("Cannot read a Cursor preview record: {error}"));
                    continue;
                }
            };
            preview_bytes = preview_bytes.saturating_add(raw.len() as u64);
            let Ok(value) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            snippet = value_string(&value, &["text", "richText"])
                .and_then(meaningful_chat_text)
                .map(|text| clean_message_snippet(&text));
            if snippet.is_some() {
                break;
            }
        }
        if snippet.is_some() {
            previews.insert(composer_id.clone(), (snippet, preview_bytes));
        }
    }
    Ok(previews)
}

fn cursor_header_is_internal(header: &Value) -> bool {
    header
        .get("isSubagent")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || header.get("subagentInfo").is_some()
}

fn cursor_bubble_key_range(composer_id: &str) -> (String, String) {
    (
        format!("bubbleId:{composer_id}:"),
        format!("bubbleId:{composer_id};"),
    )
}

fn cursor_workspace(header: &Value, workspace_id: Option<&str>, storage: &Path) -> Option<String> {
    if let Some(identifier) = header.get("workspaceIdentifier") {
        if let Some(found) = find_workspace_value(identifier) {
            return Some(found);
        }
    }
    let workspace_id = workspace_id?.trim();
    if workspace_id.is_empty() || workspace_id == "empty-window" {
        return None;
    }
    let workspace_file = storage.join(workspace_id).join("workspace.json");
    let raw = fs::read_to_string(workspace_file).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    find_workspace_value(&value)
}

fn find_workspace_value(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => normalize_workspace_reference(value),
        Value::Array(values) => values.iter().find_map(find_workspace_value),
        Value::Object(map) => {
            for key in [
                "folder",
                "fsPath",
                "external",
                "path",
                "uri",
                "rootPath",
                "workspace",
            ] {
                if let Some(found) = map.get(key).and_then(find_workspace_value) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

fn normalize_workspace_reference(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value == "empty-window" {
        return None;
    }
    let mut path = if let Some(encoded) = value.strip_prefix("file://") {
        percent_decode_str(encoded).decode_utf8_lossy().into_owned()
    } else {
        value.to_string()
    };
    if slash_prefixed_windows_drive(&path) {
        path.remove(0);
    }
    if windows_drive_path(&path) {
        path.replace_range(..1, &path[..1].to_ascii_uppercase());
        path = path.replace(['/', '\\'], std::path::MAIN_SEPARATOR_STR);
        while path.len() > 3 && path.ends_with(['/', '\\']) {
            path.pop();
        }
        return Some(path);
    }
    if path.starts_with('/') || path.starts_with("\\\\") {
        while path.len() > 1 && path.ends_with(['/', '\\']) {
            path.pop();
        }
        return Some(path);
    }
    None
}

fn slash_prefixed_windows_drive(value: &str) -> bool {
    value.len() > 3
        && value.as_bytes().first().copied() == Some(b'/')
        && value.as_bytes().get(2).copied() == Some(b':')
        && matches!(value.as_bytes().get(3), Some(b'\\' | b'/'))
        && value.as_bytes().get(1).is_some_and(u8::is_ascii_alphabetic)
}

fn windows_drive_path(value: &str) -> bool {
    value.len() > 2
        && value.as_bytes().get(1).copied() == Some(b':')
        && matches!(value.as_bytes().get(2), Some(b'\\' | b'/'))
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
}

fn value_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(str::to_string)
}

fn message_text(value: &Value) -> Option<String> {
    if let Some(content) = value.get("content") {
        return content_text(content);
    }
    value_string(value, &["message", "text", "output", "summary"])
}

fn content_text(content: &Value) -> Option<String> {
    match content {
        Value::String(value) => Some(value.clone()),
        Value::Array(items) => {
            let pieces: Vec<String> = items
                .iter()
                .filter_map(|item| {
                    let kind = item.get("type").and_then(Value::as_str);
                    if kind.is_some_and(|kind| {
                        !matches!(kind, "text" | "input_text" | "output_text" | "summary_text")
                    }) {
                        return None;
                    }
                    value_string(item, &["text", "output_text", "input_text", "content"])
                })
                .collect();
            (!pieces.is_empty()).then(|| pieces.join("\n"))
        }
        Value::Object(_) => value_string(content, &["text", "output", "content"]),
        _ => None,
    }
}

fn file_modified_iso(path: &Path) -> Option<String> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| iso_from_unix_millis(duration.as_millis() as i64))
}

fn canonical_workspace(requested: &str) -> Result<String, String> {
    let requested = requested.trim();
    if requested.is_empty() {
        return Err("Choose a workspace directory for every selected group".to_string());
    }
    let path = fs::canonicalize(requested).map_err(|error| {
        format!("Workspace {requested} does not exist or is inaccessible: {error}")
    })?;
    if !path.is_dir() {
        return Err(format!("Workspace {} is not a directory", path.display()));
    }
    Ok(portable_display_path(&path))
}

fn portable_display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
}

fn load_codex_records(path: &Path) -> Result<Vec<ExternalRecord>, String> {
    let mut records = Vec::new();
    for line in open_lines(path)? {
        let line = line.map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        records.extend(codex_records_from_value(&value));
    }
    Ok(records)
}

fn codex_records_from_value(value: &Value) -> Vec<ExternalRecord> {
    let timestamp = value_string(value, &["timestamp"]);
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let payload = value.get("payload").unwrap_or(&Value::Null);
    let payload_kind = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let found = match (kind, payload_kind) {
        ("event_msg", "user_message") => value_string(payload, &["message", "text"])
            .and_then(meaningful_chat_text)
            .map(|content| record("message", "user", content, timestamp, None, None, None)),
        ("event_msg", "agent_message") => value_string(payload, &["message", "text"])
            .and_then(meaningful_chat_text)
            .map(|content| record("message", "assistant", content, timestamp, None, None, None)),
        ("response_item", "message") => {
            let role = match payload.get("role").and_then(Value::as_str) {
                Some("user") => "user",
                Some("assistant") => "assistant",
                _ => return Vec::new(),
            };
            message_text(payload)
                .and_then(meaningful_chat_text)
                .map(|content| {
                    record(
                        "message",
                        role,
                        content,
                        timestamp,
                        None,
                        None,
                        value_string(payload, &["id"]),
                    )
                })
        }
        ("response_item", "reasoning") => message_text(payload).map(|content| {
            record(
                "reasoning",
                "assistant",
                content,
                timestamp,
                None,
                None,
                value_string(payload, &["id"]),
            )
        }),
        ("response_item", "function_call" | "custom_tool_call") => {
            let name = value_string(payload, &["name"]).unwrap_or_else(|| "tool".to_string());
            let arguments = payload
                .get("arguments")
                .or_else(|| payload.get("input"))
                .map(value_to_bounded_text)
                .unwrap_or_default();
            Some(record(
                "toolCall",
                "tool",
                arguments,
                timestamp,
                None,
                Some(name),
                value_string(payload, &["call_id", "id"]),
            ))
        }
        ("response_item", "function_call_output" | "custom_tool_call_output") => {
            let content = payload
                .get("output")
                .or_else(|| payload.get("content"))
                .map(value_to_bounded_text)
                .unwrap_or_default();
            Some(record(
                "toolResult",
                "tool",
                content,
                timestamp,
                None,
                None,
                value_string(payload, &["call_id", "id"]),
            ))
        }
        ("compacted", _) => value_string(value, &["summary"])
            .or_else(|| value_string(payload, &["summary"]))
            .map(|content| record("summary", "system", content, timestamp, None, None, None)),
        _ => None,
    };
    found
        .filter(|item| !item.content.trim().is_empty())
        .into_iter()
        .collect()
}

fn load_claude_records(path: &Path) -> Result<Vec<ExternalRecord>, String> {
    let mut records = Vec::new();
    for line in open_lines(path)? {
        let line = line.map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        records.extend(claude_records_from_value(&value));
    }
    Ok(records)
}

fn claude_records_from_value(value: &Value) -> Vec<ExternalRecord> {
    let mut records = Vec::new();
    let entry_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let timestamp = value_string(value, &["timestamp"]);
    if matches!(entry_type, "user" | "assistant") {
        let message = value.get("message").unwrap_or(&Value::Null);
        let model = value_string(message, &["model"]);
        if let Some(content) = message_text(message).filter(|text| !text.trim().is_empty()) {
            records.push(record(
                "message",
                entry_type,
                content,
                timestamp.clone(),
                model.clone(),
                None,
                value_string(value, &["uuid"]),
            ));
        }
        if let Some(blocks) = message.get("content").and_then(Value::as_array) {
            for block in blocks {
                let block_type = block
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let extra = match block_type {
                    "thinking" => value_string(block, &["thinking"]).map(|content| {
                        record(
                            "reasoning",
                            "assistant",
                            content,
                            timestamp.clone(),
                            model.clone(),
                            None,
                            value_string(block, &["id"]),
                        )
                    }),
                    "tool_use" => Some(record(
                        "toolCall",
                        "tool",
                        block
                            .get("input")
                            .map(value_to_bounded_text)
                            .unwrap_or_default(),
                        timestamp.clone(),
                        model.clone(),
                        value_string(block, &["name"]),
                        value_string(block, &["id"]),
                    )),
                    "tool_result" => Some(record(
                        "toolResult",
                        "tool",
                        block
                            .get("content")
                            .map(value_to_bounded_text)
                            .unwrap_or_default(),
                        timestamp.clone(),
                        model.clone(),
                        None,
                        value_string(block, &["tool_use_id", "id"]),
                    )),
                    _ => None,
                };
                if let Some(extra) = extra.filter(|item| !item.content.trim().is_empty()) {
                    records.push(extra);
                }
            }
        }
    } else if entry_type == "system" {
        if let Some(content) =
            value_string(value, &["content", "summary"]).filter(|text| !text.trim().is_empty())
        {
            records.push(record(
                "system",
                "system",
                content,
                timestamp,
                None,
                None,
                value_string(value, &["uuid"]),
            ));
        }
    }
    records
}

fn load_cursor_records(database: &Path, composer_id: &str) -> Result<Vec<ExternalRecord>, String> {
    let connection = open_cursor_database(database)?;
    let mut statement = connection
        .prepare(CURSOR_RECORDS_RANGE_SQL)
        .map_err(|error| format!("Cannot prepare Cursor message import: {error}"))?;
    let (lower_bound, upper_bound) = cursor_bubble_key_range(composer_id);
    let rows = statement
        .query_map(params![lower_bound, upper_bound], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Cannot read Cursor chat messages: {error}"))?;
    let mut records = Vec::new();
    for row in rows {
        let (row_id, raw) =
            row.map_err(|error| format!("Cannot read a Cursor message: {error}"))?;
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        records.extend(cursor_records_from_value(&value, row_id));
    }
    Ok(records)
}

fn cursor_records_from_value(value: &Value, row_id: i64) -> Vec<ExternalRecord> {
    let mut records = Vec::new();
    let role = if value.get("type").and_then(Value::as_i64) == Some(1) {
        "user"
    } else {
        "assistant"
    };
    let timestamp = value_string(value, &["createdAt"]);
    let source_record_id =
        value_string(value, &["bubbleId"]).or_else(|| Some(format!("row-{row_id}")));
    if let Some(content) =
        value_string(value, &["text", "richText"]).filter(|text| !text.trim().is_empty())
    {
        records.push(record(
            "message",
            role,
            content,
            timestamp.clone(),
            None,
            None,
            source_record_id.clone(),
        ));
    }
    if let Some(content) = ["thinking", "reasoning", "reasoningContent"]
        .iter()
        .find_map(|key| value.get(*key).and_then(cursor_reasoning_text))
    {
        if !content.trim().is_empty() {
            records.push(record(
                "reasoning",
                "assistant",
                content,
                timestamp.clone(),
                None,
                None,
                source_record_id.clone(),
            ));
        }
    }
    for result in value
        .get("toolResults")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let tool_name = value_string(result, &["name", "toolName"]);
        let content = result
            .get("content")
            .or_else(|| result.get("output"))
            .map(value_to_bounded_text)
            .unwrap_or_else(|| value_to_bounded_text(result));
        if !content.trim().is_empty() {
            records.push(record(
                "toolResult",
                "tool",
                content,
                timestamp.clone(),
                None,
                tool_name,
                source_record_id.clone(),
            ));
        }
    }
    records
}

enum ContextAppend {
    Added,
    Duplicate,
    Full,
}

fn append_context_record(
    output: &mut Vec<ExternalRecord>,
    text_bytes: &mut usize,
    previous_hash: &mut Option<String>,
    candidate: ExternalRecord,
) -> ContextAppend {
    let hash = context_record_hash(&candidate);
    if previous_hash.as_deref() == Some(hash.as_str()) {
        return ContextAppend::Duplicate;
    }
    let candidate_bytes = candidate.content.len().saturating_add(256);
    if !output.is_empty()
        && (output.len() >= CONTEXT_PAGE_RECORD_LIMIT
            || text_bytes.saturating_add(candidate_bytes) > CONTEXT_PAGE_TEXT_BYTES)
    {
        return ContextAppend::Full;
    }
    *text_bytes = text_bytes.saturating_add(candidate_bytes);
    *previous_hash = Some(hash);
    output.push(candidate);
    ContextAppend::Added
}

fn context_record_hash(record: &ExternalRecord) -> String {
    let mut hasher = Sha256::new();
    hasher.update(record.kind.as_bytes());
    hasher.update([0]);
    hasher.update(record.role.as_bytes());
    hasher.update([0]);
    hasher.update(record.content.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn encode_context_cursor(cursor: ContextCursor) -> Result<String, String> {
    let bytes = serde_json::to_vec(&cursor)
        .map_err(|error| format!("Cannot encode context cursor: {error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn decode_context_cursor(cursor: &str) -> Result<ContextCursor, String> {
    if cursor.len() > 2_048 {
        return Err("The context cursor is invalid".to_string());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| "The context cursor is invalid".to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| "The context cursor is invalid".to_string())
}

fn load_jsonl_context_page(
    path: &Path,
    source: &str,
    cursor: Option<ContextCursor>,
    include_auxiliary: bool,
) -> Result<(Vec<ExternalRecord>, Option<ContextCursor>), String> {
    let (byte_offset, record_index, mut previous_hash) = match cursor {
        None => (0, 0, None),
        Some(ContextCursor::Jsonl {
            byte_offset,
            record_index,
            previous_hash,
        }) => (byte_offset, record_index, previous_hash),
        Some(ContextCursor::Cursor { .. }) => {
            return Err("The context cursor does not match this chat source".to_string())
        }
    };
    let file_size = source_file_size(path)?;
    if byte_offset > file_size || record_index > 10_000 {
        return Err("The context cursor is outside this chat".to_string());
    }
    let file = File::open(path)
        .map_err(|error| format!("Cannot open chat file {}: {error}", path.display()))?;
    let mut reader = BufReader::new(file);
    reader
        .seek(SeekFrom::Start(byte_offset))
        .map_err(|error| format!("Cannot seek in {}: {error}", path.display()))?;

    let mut output = Vec::new();
    let mut text_bytes = 0_usize;
    let mut first_line = true;
    loop {
        let line_start = reader
            .stream_position()
            .map_err(|error| format!("Cannot seek in {}: {error}", path.display()))?;
        let mut line = Vec::new();
        let read = reader
            .read_until(b'\n', &mut line)
            .map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
        if read == 0 {
            return Ok((output, None));
        }
        let Ok(value) = serde_json::from_slice::<Value>(&line) else {
            first_line = false;
            continue;
        };
        let records = match source {
            "codex" => codex_records_from_value(&value),
            "claude" => claude_records_from_value(&value),
            _ => return Err("Unsupported JSONL chat source".to_string()),
        };
        let start_index = if first_line { record_index } else { 0 };
        if start_index > records.len() {
            return Err("The context cursor no longer matches this chat".to_string());
        }
        for (index, candidate) in records.into_iter().enumerate().skip(start_index) {
            if !include_auxiliary && !context_record_is_conversation(&candidate) {
                continue;
            }
            match append_context_record(&mut output, &mut text_bytes, &mut previous_hash, candidate)
            {
                ContextAppend::Added | ContextAppend::Duplicate => {}
                ContextAppend::Full => {
                    return Ok((
                        output,
                        Some(ContextCursor::Jsonl {
                            byte_offset: line_start,
                            record_index: index,
                            previous_hash,
                        }),
                    ));
                }
            }
        }
        first_line = false;
    }
}

fn load_cursor_context_page(
    database: &Path,
    composer_id: &str,
    cursor: Option<ContextCursor>,
    include_auxiliary: bool,
) -> Result<(Vec<ExternalRecord>, Option<ContextCursor>), String> {
    let (start_row_id, record_index, mut previous_hash) = match cursor {
        None => (0_i64, 0_usize, None),
        Some(ContextCursor::Cursor {
            row_id,
            record_index,
            previous_hash,
        }) => (row_id, record_index, previous_hash),
        Some(ContextCursor::Jsonl { .. }) => {
            return Err("The context cursor does not match this chat source".to_string())
        }
    };
    if start_row_id < 0 || record_index > 10_000 {
        return Err("The context cursor is outside this chat".to_string());
    }
    let connection = open_cursor_database(database)?;
    let (lower_bound, upper_bound) = cursor_bubble_key_range(composer_id);
    let mut statement = connection
        .prepare(
            "SELECT rowid, value FROM cursorDiskKV
             WHERE key >= ?1 AND key < ?2 AND rowid >= ?3
             ORDER BY rowid",
        )
        .map_err(|error| format!("Cannot prepare Cursor context preview: {error}"))?;
    let rows = statement
        .query_map(params![lower_bound, upper_bound, start_row_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Cannot read Cursor context preview: {error}"))?;
    let mut output = Vec::new();
    let mut text_bytes = 0_usize;
    for row in rows {
        let (row_id, raw) =
            row.map_err(|error| format!("Cannot read a Cursor context record: {error}"))?;
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let records = cursor_records_from_value(&value, row_id);
        let row_start_index = if row_id == start_row_id {
            record_index
        } else {
            0
        };
        if row_id == start_row_id && row_start_index > records.len() {
            return Err("The context cursor no longer matches this chat".to_string());
        }
        for (index, candidate) in records.into_iter().enumerate().skip(row_start_index) {
            if !include_auxiliary && !context_record_is_conversation(&candidate) {
                continue;
            }
            match append_context_record(&mut output, &mut text_bytes, &mut previous_hash, candidate)
            {
                ContextAppend::Added | ContextAppend::Duplicate => {}
                ContextAppend::Full => {
                    return Ok((
                        output,
                        Some(ContextCursor::Cursor {
                            row_id,
                            record_index: index,
                            previous_hash,
                        }),
                    ));
                }
            }
        }
    }
    Ok((output, None))
}

fn context_record_is_conversation(record: &ExternalRecord) -> bool {
    matches!(record.kind.as_str(), "message" | "reasoning")
}

fn record(
    kind: &str,
    role: &str,
    content: String,
    timestamp: Option<String>,
    model: Option<String>,
    tool_name: Option<String>,
    source_record_id: Option<String>,
) -> ExternalRecord {
    ExternalRecord {
        kind: kind.to_string(),
        role: role.to_string(),
        content: bound_text(content),
        timestamp,
        model,
        tool_name,
        source_record_id,
    }
}

fn value_to_bounded_text(value: &Value) -> String {
    match value {
        Value::String(value) => bound_text(value.clone()),
        _ => bound_text(serde_json::to_string_pretty(value).unwrap_or_default()),
    }
}

/// Cursor stores reasoning in more than one shape. Current releases commonly
/// wrap the useful text with a transport signature, for example
/// `{ "signature": "...", "text": "..." }`. Signatures are not readable
/// conversation content and must never be rendered as imported JSON.
fn cursor_reasoning_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => (!text.trim().is_empty()).then(|| bound_text(text.clone())),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().filter_map(cursor_reasoning_text).collect();
            (!parts.is_empty()).then(|| bound_text(parts.join("\n")))
        }
        Value::Object(object) => ["text", "thinking", "reasoning", "content"]
            .iter()
            .find_map(|key| object.get(*key).and_then(cursor_reasoning_text)),
        _ => None,
    }
}

fn bound_text(value: String) -> String {
    if value.len() <= MAX_RECORD_TEXT_BYTES {
        return value;
    }
    let mut end = MAX_RECORD_TEXT_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n\n[Picode import truncated this single record at {} MiB]",
        &value[..end],
        MAX_RECORD_TEXT_BYTES / 1024 / 1024
    )
}

fn deduplicate_records(records: Vec<ExternalRecord>) -> Vec<ExternalRecord> {
    let mut output: Vec<ExternalRecord> = Vec::new();
    for record in records {
        let is_duplicate = output.last().is_some_and(|previous| {
            previous.role == record.role
                && previous.kind == record.kind
                && previous.content == record.content
        });
        if !is_duplicate {
            output.push(record);
        }
    }
    output
}

fn build_pi_continuation_session(
    candidate: &PendingCandidate,
    workspace: &str,
    snapshot: &ExternalChatSnapshot,
    include_reasoning: bool,
) -> Result<Vec<u8>, String> {
    let session_id = Uuid::new_v4().to_string();
    let timestamp = candidate
        .summary
        .created_at
        .clone()
        .filter(|value| value.contains('T'))
        .unwrap_or_else(now_iso);
    let mut entries = Vec::new();
    entries.push(json!({
        "type": "session",
        "version": 3,
        "id": session_id,
        "timestamp": timestamp,
        "cwd": workspace,
    }));
    let mut parent_id: Option<String> = None;
    let info_id = short_id();
    entries.push(json!({
        "type": "session_info",
        "id": info_id,
        "parentId": parent_id,
        "timestamp": timestamp,
        "name": format!("[{}] {}", candidate.summary.source, candidate.summary.title),
    }));
    parent_id = Some(info_id);
    let provenance_id = short_id();
    entries.push(json!({
        "type": "custom",
        "id": provenance_id,
        "parentId": parent_id,
        "timestamp": timestamp,
        "customType": "picot.external-chat",
        "data": {
            "schema": snapshot.schema,
            "source": snapshot.source,
            "sourceId": snapshot.source_id,
            "originalWorkspace": snapshot.original_workspace,
            "boundWorkspace": snapshot.bound_workspace,
            "immutableSnapshot": true,
            "continuationBranch": true,
            "continuationIncludesReasoning": include_reasoning,
        }
    }));
    parent_id = Some(provenance_id);

    let mut has_user_message = false;
    for source_record in &snapshot.records {
        if source_record.kind != "message"
            && !(include_reasoning && source_record.kind == "reasoning")
        {
            continue;
        }
        let entry_id = short_id();
        let message_timestamp = source_record
            .timestamp
            .clone()
            .filter(|value| value.contains('T'))
            .unwrap_or_else(|| timestamp.clone());
        let unix_millis = parse_or_now_millis(source_record.timestamp.as_deref());
        let is_user = source_record.role == "user";
        has_user_message |= is_user;
        let content = if source_record.kind == "message" {
            source_record.content.clone()
        } else {
            let label = source_record
                .tool_name
                .as_deref()
                .map(|name| format!("{}: {name}", source_record.kind))
                .unwrap_or_else(|| source_record.kind.clone());
            format!("[{label}]\n{}", source_record.content)
        };
        let message = if is_user {
            json!({
                "role": "user",
                "content": [{"type": "text", "text": content}],
                "timestamp": unix_millis,
            })
        } else {
            json!({
                "role": "assistant",
                "content": [{"type": "text", "text": content}],
                "api": "picot-import",
                "provider": candidate.summary.source,
                "model": source_record.model.as_deref().unwrap_or("imported-snapshot"),
                "usage": {
                    "input": 0,
                    "output": 0,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "totalTokens": 0,
                    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}
                },
                "stopReason": "stop",
                "timestamp": unix_millis,
            })
        };
        entries.push(json!({
            "type": "message",
            "id": entry_id,
            "parentId": parent_id,
            "timestamp": message_timestamp,
            "message": message,
        }));
        parent_id = Some(entry_id);
    }
    if !has_user_message {
        return Err("Imported chat contains no readable user message".to_string());
    }
    let mut output = Vec::new();
    for entry in entries {
        serde_json::to_writer(&mut output, &entry)
            .map_err(|error| format!("Cannot encode Pi continuation branch: {error}"))?;
        output.push(b'\n');
    }
    Ok(output)
}

fn short_id() -> String {
    Uuid::new_v4().simple().to_string()[..8].to_string()
}

fn pi_session_dir_name(cwd: &str) -> String {
    let trimmed = cwd.trim_start_matches(['/', '\\']);
    let safe: String = trimmed
        .chars()
        .map(|character| {
            if matches!(character, '/' | '\\' | ':') {
                '-'
            } else {
                character
            }
        })
        .collect();
    format!("--{safe}--")
}

fn atomic_write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if path.exists() {
        return Err(format!(
            "Refusing to overwrite existing import file {}",
            path.display()
        ));
    }
    let parent = path.parent().ok_or("Import path has no parent directory")?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Cannot create import directory {}: {error}",
            parent.display()
        )
    })?;
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("import"),
        Uuid::new_v4()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|error| {
                format!(
                    "Cannot create temporary import file {}: {error}",
                    temp.display()
                )
            })?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Cannot write import file {}: {error}", temp.display()))?;
        restrict_file_permissions(&temp)?;
        fs::rename(&temp, path)
            .map_err(|error| format!("Cannot finalize import file {}: {error}", path.display()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(unix)]
fn restrict_file_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| {
        format!(
            "Cannot restrict file permissions {}: {error}",
            path.display()
        )
    })
}

#[cfg(not(unix))]
fn restrict_file_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn parse_or_now_millis(value: Option<&str>) -> u128 {
    value
        .and_then(|value| value.parse::<u128>().ok())
        .unwrap_or_else(now_millis)
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn now_iso() -> String {
    iso_from_unix_millis(now_millis() as i64)
}

fn iso_from_unix_millis(milliseconds: i64) -> String {
    let seconds = milliseconds.div_euclid(1_000);
    let millis = milliseconds.rem_euclid(1_000);
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let hour = day_seconds / 3_600;
    let minute = (day_seconds % 3_600) / 60;
    let second = day_seconds % 60;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Seek, SeekFrom};

    fn test_service() -> (PathBuf, ChatMigrationService) {
        let root = std::env::temp_dir().join(format!("picot-chat-migration-{}", Uuid::new_v4()));
        let roots = SourceRoots {
            codex_sessions: root.join("codex-sessions"),
            codex_archived: root.join("codex-archived"),
            claude_projects: root.join("claude-projects"),
            cursor_database: root.join("cursor").join("state.vscdb"),
            cursor_workspace_storage: root.join("cursor").join("workspaceStorage"),
        };
        let service = ChatMigrationService::open(
            roots,
            root.join("snapshots"),
            root.join("pi-sessions"),
            root.join("index.sqlite3"),
        )
        .unwrap();
        (root, service)
    }

    fn write_file(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn scans_selected_sources_and_preserves_archived_state() {
        let (root, service) = test_service();
        write_file(
            &service.roots.codex_archived.join("2026/07/one.jsonl"),
            concat!(
                "{\"type\":\"session_meta\",\"timestamp\":\"2026-07-01T00:00:00Z\",\"payload\":{\"id\":\"codex-1\",\"cwd\":\"C:\\\\old\\\\repo\"}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-01T00:00:01Z\",\"payload\":{\"type\":\"user_message\",\"message\":\"Fix the build\"}}\n"
            ),
        );

        let scan = service.scan_local(&["codex".to_string()]).unwrap();
        assert_eq!(scan.candidates.len(), 1);
        assert!(scan.candidates[0].archived);
        assert_eq!(scan.candidates[0].title, "Fix the build");
        assert_eq!(scan.workspace_groups.len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn codex_preview_ignores_injected_context_and_exposes_recent_content_and_size() {
        let (root, service) = test_service();
        let source = service.roots.codex_sessions.join("2026/07/readable.jsonl");
        write_file(
            &source,
            concat!(
                "{\"type\":\"session_meta\",\"timestamp\":\"2026-07-01T00:00:00Z\",\"payload\":{\"id\":\"codex-readable\",\"cwd\":\"C:\\\\old\\\\repo\"}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-01T00:00:01Z\",\"payload\":{\"type\":\"user_message\",\"message\":\"<environment_context><cwd>C:\\\\old\\\\repo</cwd></environment_context>\"}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-01T00:00:02Z\",\"payload\":{\"type\":\"user_message\",\"message\":\"Fix the build\"}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-01T00:00:03Z\",\"payload\":{\"type\":\"agent_message\",\"message\":\"The build now passes on Windows.\"}}\n"
            ),
        );

        let scan = service.scan_local(&["codex".to_string()]).unwrap();
        let candidate = &scan.candidates[0];
        assert_eq!(candidate.title, "Fix the build");
        assert_eq!(
            candidate.last_message_snippet.as_deref(),
            Some("The build now passes on Windows.")
        );
        assert_eq!(
            candidate.file_size_bytes,
            fs::metadata(&source).unwrap().len()
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn codex_preview_reads_past_large_host_context_to_find_the_first_user_message() {
        let (root, service) = test_service();
        let source = service
            .roots
            .codex_sessions
            .join("2026/07/large-host-context.jsonl");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        let mut file = File::create(&source).unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type": "session_meta",
                "timestamp": "2026-07-01T00:00:00Z",
                "payload": { "id": "codex-large-host-context", "cwd": "C:\\repo" }
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type": "response_item",
                "timestamp": "2026-07-01T00:00:01Z",
                "payload": {
                    "type": "message",
                    "role": "developer",
                    "content": [{ "type": "input_text", "text": format!("<app-context>{}</app-context>", "x".repeat(70 * 1024)) }]
                }
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type": "response_item",
                "timestamp": "2026-07-01T00:00:02Z",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": format!("<environment_context>{}</environment_context>", "y".repeat(40 * 1024)) }]
                }
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type": "response_item",
                "timestamp": "2026-07-01T00:00:03Z",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "Build the Windows release" }]
                }
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type": "response_item",
                "timestamp": "2026-07-01T00:00:04Z",
                "payload": {
                    "type": "function_call_output",
                    "output": "z".repeat(80 * 1024)
                }
            })
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type": "event_msg",
                "timestamp": "2026-07-01T00:00:05Z",
                "payload": { "type": "agent_message", "message": "Release completed" }
            })
        )
        .unwrap();
        drop(file);

        assert!(fs::metadata(&source).unwrap().len() > PREVIEW_FULL_FILE_BYTES);
        let candidate = codex_candidate(&source, false).unwrap().unwrap();
        assert_eq!(candidate.summary.title, "Build the Windows release");
        assert_eq!(
            candidate.summary.last_message_snippet.as_deref(),
            Some("Release completed")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn codex_records_hide_host_messages_and_keep_visible_conversation() {
        let developer = json!({
            "type": "response_item",
            "timestamp": "2026-07-01T00:00:00Z",
            "payload": {
                "type": "message",
                "role": "developer",
                "content": [{ "type": "input_text", "text": "<app-context>host instructions</app-context>" }]
            }
        });
        let injected_user = json!({
            "type": "response_item",
            "timestamp": "2026-07-01T00:00:01Z",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": "<environment_context><cwd>C:\\repo</cwd></environment_context>" }]
            }
        });
        let visible_user = json!({
            "type": "response_item",
            "timestamp": "2026-07-01T00:00:02Z",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": "Fix the visible bug" }]
            }
        });

        assert!(codex_records_from_value(&developer).is_empty());
        assert!(codex_records_from_value(&injected_user).is_empty());
        let records = codex_records_from_value(&visible_user);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].role, "user");
        assert_eq!(records[0].content, "Fix the visible bug");
    }

    #[test]
    fn codex_scan_excludes_internal_subagent_and_approval_sessions() {
        let (root, service) = test_service();
        write_file(
            &service.roots.codex_sessions.join("2026/07/guardian.jsonl"),
            concat!(
                "{\"type\":\"session_meta\",\"timestamp\":\"2026-07-01T00:00:00Z\",\"payload\":{\"id\":\"guardian-1\",\"cwd\":\"C:\\\\repo\",\"thread_source\":\"subagent\",\"source\":{\"subagent\":{\"other\":\"guardian\"}}}}\n",
                "{\"type\":\"response_item\",\"timestamp\":\"2026-07-01T00:00:01Z\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"The following is the Codex agent history whose request action you are assessing.\"}]}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-01T00:00:02Z\",\"payload\":{\"type\":\"agent_message\",\"message\":\"{\\\"outcome\\\":\\\"allow\\\"}\"}}\n"
            ),
        );

        let scan = service.scan_local(&["codex".to_string()]).unwrap();

        assert!(scan.candidates.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn scan_deduplicates_the_same_source_conversation_id() {
        let (root, service) = test_service();
        let content = concat!(
            "{\"type\":\"session_meta\",\"timestamp\":\"2026-07-01T00:00:00Z\",\"payload\":{\"id\":\"codex-same\",\"cwd\":\"C:\\\\repo\",\"thread_source\":\"user\"}}\n",
            "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-01T00:00:01Z\",\"payload\":{\"type\":\"user_message\",\"message\":\"One real chat\"}}\n"
        );
        write_file(
            &service.roots.codex_sessions.join("2026/07/active.jsonl"),
            content,
        );
        write_file(
            &service.roots.codex_archived.join("archived.jsonl"),
            content,
        );

        let scan = service.scan_local(&["codex".to_string()]).unwrap();

        assert_eq!(scan.candidates.len(), 1);
        assert!(!scan.candidates[0].archived);
        assert_eq!(scan.candidates[0].title, "One real chat");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn codex_preview_reads_only_the_file_edges() {
        let (root, service) = test_service();
        let source = service.roots.codex_sessions.join("2026/07/large.jsonl");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        let mut file = File::create(&source).unwrap();
        file.write_all(
            b"{\"type\":\"session_meta\",\"timestamp\":\"2026-07-01T00:00:00Z\",\"payload\":{\"id\":\"codex-large\",\"cwd\":\"C:\\\\repo\",\"title\":\"Large chat\"}}\n",
        )
        .unwrap();
        file.seek(SeekFrom::Start(3 * 1024 * 1024)).unwrap();
        file.write_all(&[0xff, b'\n']).unwrap();
        file.seek(SeekFrom::Start(5 * 1024 * 1024)).unwrap();
        file.write_all(b"\n").unwrap();
        file.seek(SeekFrom::Start(6 * 1024 * 1024 - 1)).unwrap();
        file.write_all(b"\n").unwrap();
        file.seek(SeekFrom::Start(6 * 1024 * 1024)).unwrap();
        file.write_all(
            b"{\"type\":\"event_msg\",\"timestamp\":\"2026-07-01T00:00:03Z\",\"payload\":{\"type\":\"agent_message\",\"message\":\"Finished without reading the middle\"}}\n",
        )
        .unwrap();
        drop(file);

        let candidate = codex_candidate(&source, false).unwrap().unwrap();
        assert_eq!(candidate.summary.title, "Large chat");
        assert_eq!(
            candidate.summary.last_message_snippet.as_deref(),
            Some("Finished without reading the middle")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn codex_preview_keeps_complete_oversized_session_metadata() {
        let (root, service) = test_service();
        let source = service
            .roots
            .codex_sessions
            .join("2026/07/oversized-meta.jsonl");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        let mut file = File::create(&source).unwrap();
        let metadata = json!({
            "type": "session_meta",
            "timestamp": "2026-07-01T00:00:00Z",
            "payload": {
                "id": "codex-oversized-meta",
                "cwd": "D:\\otherproject\\petPI",
                "title": "Oversized metadata chat",
                "base_instructions": {
                    "text": "x".repeat(PREVIEW_FIRST_RECORD_INITIAL_CAPACITY + 1024)
                }
            }
        });
        writeln!(file, "{metadata}").unwrap();
        let middle = json!({
            "type": "response_item",
            "payload": {
                "type": "function_call_output",
                "output": "m".repeat(PREVIEW_TAIL_BYTES as usize + 4096)
            }
        });
        writeln!(file, "{middle}").unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "type": "event_msg",
                "timestamp": "2026-07-01T00:00:03Z",
                "payload": {
                    "type": "agent_message",
                    "message": "Finished after the oversized metadata"
                }
            })
        )
        .unwrap();
        drop(file);

        let candidate = codex_candidate(&source, false).unwrap().unwrap();
        assert_eq!(
            candidate.summary.original_workspace.as_deref(),
            Some("D:\\otherproject\\petPI")
        );
        assert_eq!(candidate.summary.title, "Oversized metadata chat");
        assert_eq!(
            candidate.summary.last_message_snippet.as_deref(),
            Some("Finished after the oversized metadata")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn import_requires_an_existing_workspace_and_never_executes_the_source_path() {
        let (root, service) = test_service();
        let source = service.roots.codex_sessions.join("2026/07/one.jsonl");
        write_file(
            &source,
            concat!(
                "{\"type\":\"session_meta\",\"timestamp\":\"2026-07-01T00:00:00Z\",\"payload\":{\"id\":\"codex-1\",\"cwd\":\"D:\\\\missing\\\\repo\"}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-01T00:00:01Z\",\"payload\":{\"type\":\"user_message\",\"message\":\"Fix the build\"}}\n",
                "{\"type\":\"response_item\",\"timestamp\":\"2026-07-01T00:00:01Z\",\"payload\":{\"type\":\"reasoning\",\"content\":[{\"type\":\"summary_text\",\"text\":\"PRIVATE REASONING\"}]}}\n",
                "{\"type\":\"response_item\",\"timestamp\":\"2026-07-01T00:00:01Z\",\"payload\":{\"type\":\"function_call_output\",\"output\":\"PRIVATE TOOL OUTPUT\"}}\n",
                "{\"type\":\"compacted\",\"timestamp\":\"2026-07-01T00:00:01Z\",\"summary\":\"PRIVATE COMPACTED SUMMARY\"}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-01T00:00:02Z\",\"payload\":{\"type\":\"agent_message\",\"message\":\"Done\"}}\n"
            ),
        );
        let target = root.join("current-workspace");
        fs::create_dir_all(&target).unwrap();
        let scan = service.scan_local(&["codex".to_string()]).unwrap();
        let candidate = &scan.candidates[0];
        let missing = service.import_selected(
            &scan.scan_id,
            std::slice::from_ref(&candidate.id),
            &HashMap::new(),
            false,
        );
        assert!(missing.is_err());

        let bindings = HashMap::from([(
            candidate.workspace_group_id.clone(),
            target.to_string_lossy().into_owned(),
        )]);
        let result = service
            .import_selected(
                &scan.scan_id,
                std::slice::from_ref(&candidate.id),
                &bindings,
                false,
            )
            .unwrap();
        assert_eq!(result.imported, 1);
        let session = fs::read_to_string(&result.chats[0].session_file).unwrap();
        let header: Value = serde_json::from_str(session.lines().next().unwrap()).unwrap();
        assert_eq!(
            header["cwd"],
            canonical_workspace(target.to_str().unwrap()).unwrap()
        );
        assert_ne!(header["cwd"], "D:\\missing\\repo");
        assert!(session.contains("\"continuationBranch\":true"));
        assert!(session.contains("Fix the build"));
        assert!(session.contains("Done"));
        assert!(!session.contains("PRIVATE REASONING"));
        assert!(!session.contains("PRIVATE TOOL OUTPUT"));
        assert!(!session.contains("PRIVATE COMPACTED SUMMARY"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn full_reasoning_import_adds_reasoning_but_never_tool_or_system_records() {
        let (root, service) = test_service();
        let source = service.roots.codex_sessions.join("2026/07/full.jsonl");
        write_file(
            &source,
            concat!(
                "{\"type\":\"session_meta\",\"timestamp\":\"2026-07-01T00:00:00Z\",\"payload\":{\"id\":\"codex-full\",\"cwd\":\"D:\\\\old\\\\repo\"}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-01T00:00:01Z\",\"payload\":{\"type\":\"user_message\",\"message\":\"Investigate it\"}}\n",
                "{\"type\":\"response_item\",\"timestamp\":\"2026-07-01T00:00:02Z\",\"payload\":{\"type\":\"reasoning\",\"content\":[{\"type\":\"summary_text\",\"text\":\"FULL REASONING\"}]}}\n",
                "{\"type\":\"response_item\",\"timestamp\":\"2026-07-01T00:00:03Z\",\"payload\":{\"type\":\"function_call_output\",\"output\":\"HIDDEN TOOL OUTPUT\"}}\n",
                "{\"type\":\"compacted\",\"timestamp\":\"2026-07-01T00:00:04Z\",\"summary\":\"HIDDEN SYSTEM SUMMARY\"}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-01T00:00:05Z\",\"payload\":{\"type\":\"agent_message\",\"message\":\"Investigation complete\"}}\n"
            ),
        );
        let target = root.join("current-workspace");
        fs::create_dir_all(&target).unwrap();
        let scan = service.scan_local(&["codex".to_string()]).unwrap();
        let candidate = &scan.candidates[0];
        let bindings = HashMap::from([(
            candidate.workspace_group_id.clone(),
            target.to_string_lossy().into_owned(),
        )]);

        let result = service
            .import_selected(
                &scan.scan_id,
                std::slice::from_ref(&candidate.id),
                &bindings,
                true,
            )
            .unwrap();

        let session = fs::read_to_string(&result.chats[0].session_file).unwrap();
        assert!(session.contains("FULL REASONING"));
        assert!(!session.contains("HIDDEN TOOL OUTPUT"));
        assert!(!session.contains("HIDDEN SYSTEM SUMMARY"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn scans_current_cursor_schema_and_keeps_its_archive_flag() {
        let (root, service) = test_service();
        fs::create_dir_all(service.roots.cursor_database.parent().unwrap()).unwrap();
        let connection = Connection::open(&service.roots.cursor_database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE composerHeaders (
                    composerId TEXT, workspaceId TEXT, createdAt INTEGER,
                    lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
                    recency REAL, checkpointAt INTEGER, value TEXT
                );
                CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO composerHeaders
                 (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, value)
                 VALUES (?1, ?2, ?3, ?4, 1, ?5)",
                params![
                    "cursor-one",
                    "empty-window",
                    1_700_000_000_000_i64,
                    1_700_000_100_000_i64,
                    r#"{"name":"Cursor migration"}"#,
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO cursorDiskKV (key, value) VALUES (?1, ?2)",
                params![
                    "bubbleId:cursor-one:user",
                    r#"{"type":1,"text":"Review the migration"}"#
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO cursorDiskKV (key, value) VALUES (?1, ?2)",
                params![
                    "bubbleId:cursor-one:assistant",
                    r#"{"type":2,"text":"The migration is ready to review."}"#
                ],
            )
            .unwrap();
        for index in 0..9 {
            connection
                .execute(
                    "INSERT INTO cursorDiskKV (key, value) VALUES (?1, ?2)",
                    params![
                        format!("bubbleId:cursor-one:reasoning-{index}"),
                        format!(r#"{{"type":2,"thinking":{{"text":"Reasoning {index}"}}}}"#)
                    ],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO composerHeaders
                 (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, value)
                 VALUES ('cursor-child', 'empty-window', 3, 4, 0, 1,
                   '{\"name\":\"Internal child\",\"subagentInfo\":{\"parentComposerId\":\"cursor-one\"}}')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO cursorDiskKV (key, value) VALUES
                 ('bubbleId:cursor-child:user', '{\"type\":1,\"text\":\"Internal task\"}')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO composerHeaders
                 (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, value)
                 VALUES ('cursor-empty', 'empty-window', 5, 6, 0, 0,
                   '{\"name\":\"Empty draft\",\"isDraft\":true}')",
                [],
            )
            .unwrap();
        drop(connection);

        let scan = service.scan_local(&["cursor".to_string()]).unwrap();
        assert_eq!(scan.candidates.len(), 1);
        assert!(scan.candidates[0].archived);
        assert_eq!(scan.candidates[0].title, "Cursor migration");
        assert_eq!(
            scan.candidates[0].last_message_snippet.as_deref(),
            Some("The migration is ready to review.")
        );
        assert!(scan.candidates[0].file_size_bytes > 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn deleting_an_imported_chat_removes_session_snapshot_and_index_together() {
        let (root, service) = test_service();
        let source = service.roots.codex_sessions.join("2026/07/delete-me.jsonl");
        write_file(
            &source,
            concat!(
                "{\"type\":\"session_meta\",\"timestamp\":\"2026-07-01T00:00:00Z\",\"payload\":{\"id\":\"codex-delete-me\",\"cwd\":\"D:\\\\old\\\\repo\"}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-01T00:00:01Z\",\"payload\":{\"type\":\"user_message\",\"message\":\"Delete this imported copy\"}}\n"
            ),
        );
        let target = root.join("bound-workspace");
        fs::create_dir_all(&target).unwrap();
        let scan = service.scan_local(&["codex".to_string()]).unwrap();
        let candidate = &scan.candidates[0];
        let bindings = HashMap::from([(
            candidate.workspace_group_id.clone(),
            target.to_string_lossy().into_owned(),
        )]);
        let imported = service
            .import_selected(
                &scan.scan_id,
                std::slice::from_ref(&candidate.id),
                &bindings,
                false,
            )
            .unwrap();
        let session_path = PathBuf::from(&imported.chats[0].session_file);
        let snapshot_path: String = service
            .index
            .lock()
            .unwrap()
            .query_row(
                "SELECT snapshot_path FROM imported_chats WHERE session_path = ?1",
                [session_path.to_string_lossy().as_ref()],
                |row| row.get(0),
            )
            .unwrap();

        let result = service
            .delete_sessions(&[session_path.to_string_lossy().into_owned()])
            .unwrap();

        assert_eq!(result.deleted, 1);
        assert!(result.errors.is_empty());
        assert!(!session_path.exists());
        assert!(!Path::new(&snapshot_path).exists());
        let remaining: i64 = service
            .index
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM imported_chats", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_import_index_deletion_restores_staged_chat_files() {
        let (root, service) = test_service();
        let source = service.roots.codex_sessions.join("2026/07/rollback.jsonl");
        write_file(
            &source,
            concat!(
                "{\"type\":\"session_meta\",\"timestamp\":\"2026-07-01T00:00:00Z\",\"payload\":{\"id\":\"codex-delete-rollback\",\"cwd\":\"D:\\\\old\\\\repo\"}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-01T00:00:01Z\",\"payload\":{\"type\":\"user_message\",\"message\":\"Keep this if the index fails\"}}\n"
            ),
        );
        let target = root.join("bound-workspace");
        fs::create_dir_all(&target).unwrap();
        let scan = service.scan_local(&["codex".to_string()]).unwrap();
        let candidate = &scan.candidates[0];
        let bindings = HashMap::from([(
            candidate.workspace_group_id.clone(),
            target.to_string_lossy().into_owned(),
        )]);
        let imported = service
            .import_selected(
                &scan.scan_id,
                std::slice::from_ref(&candidate.id),
                &bindings,
                false,
            )
            .unwrap();
        let session_path = PathBuf::from(&imported.chats[0].session_file);
        let snapshot_path: String = service
            .index
            .lock()
            .unwrap()
            .query_row("SELECT snapshot_path FROM imported_chats", [], |row| {
                row.get(0)
            })
            .unwrap();
        service
            .index
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER reject_import_delete BEFORE DELETE ON imported_chats
                 BEGIN SELECT RAISE(ABORT, 'forced delete failure'); END;",
            )
            .unwrap();

        let result = service
            .delete_sessions(&[session_path.to_string_lossy().into_owned()])
            .unwrap();

        assert_eq!(result.deleted, 0);
        assert_eq!(
            result.errors,
            vec![session_path.to_string_lossy().into_owned()]
        );
        assert!(session_path.exists());
        assert!(Path::new(&snapshot_path).exists());
        let remaining: i64 = service
            .index
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM imported_chats", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn deleting_a_chat_rejects_files_outside_the_pi_sessions_root() {
        let (root, service) = test_service();
        let outside = root.join("outside.jsonl");
        write_file(&outside, "do not delete");

        let result = service
            .delete_sessions(&[outside.to_string_lossy().into_owned()])
            .unwrap();

        assert_eq!(result.deleted, 0);
        assert_eq!(result.errors, vec![outside.to_string_lossy().into_owned()]);
        assert!(outside.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cursor_workspace_variants_share_one_normalized_windows_group() {
        let (root, service) = test_service();
        fs::create_dir_all(service.roots.cursor_database.parent().unwrap()).unwrap();
        let connection = Connection::open(&service.roots.cursor_database).unwrap();
        connection
            .execute_batch(
                r#"CREATE TABLE composerHeaders (
                    composerId TEXT, workspaceId TEXT, createdAt INTEGER,
                    lastUpdatedAt INTEGER, isArchived INTEGER, value TEXT
                );
                CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);
                INSERT INTO composerHeaders VALUES
                  ('cursor-upper', 'workspace-a', 1, 2, 0,
                   '{"name":"Upper path","workspaceIdentifier":{"path":"/D:/Games/CINERIS SOMNIA/"}}'),
                  ('cursor-lower', 'workspace-b', 3, 4, 0,
                   '{"name":"Lower path","workspaceIdentifier":{"path":"/d:/Games/CINERIS SOMNIA"}}');
                INSERT INTO cursorDiskKV VALUES
                  ('bubbleId:cursor-upper:user', '{"type":1,"text":"Upper message"}'),
                  ('bubbleId:cursor-lower:user', '{"type":1,"text":"Lower message"}');"#,
            )
            .unwrap();
        drop(connection);

        let scan = service.scan_local(&["cursor".to_string()]).unwrap();

        assert_eq!(scan.candidates.len(), 2);
        assert_eq!(scan.workspace_groups.len(), 1);
        assert_eq!(
            scan.candidates[0].workspace_group_id,
            scan.candidates[1].workspace_group_id
        );
        for candidate in &scan.candidates {
            let workspace = candidate.original_workspace.as_deref().unwrap();
            assert!(!workspace.starts_with('/'));
            assert!(!workspace.ends_with(['/', '\\']));
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cursor_preview_query_uses_the_key_index_instead_of_scanning_the_database() {
        let (root, service) = test_service();
        fs::create_dir_all(service.roots.cursor_database.parent().unwrap()).unwrap();
        let connection = Connection::open(&service.roots.cursor_database).unwrap();
        connection
            .execute_batch("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);")
            .unwrap();
        let plan: Vec<String> = connection
            .prepare(&format!("EXPLAIN QUERY PLAN {CURSOR_PREVIEW_RANGE_SQL}"))
            .unwrap()
            .query_map(
                params!["bubbleId:cursor-one:", "bubbleId:cursor-one;"],
                |row| row.get(3),
            )
            .unwrap()
            .map(Result::unwrap)
            .collect();

        assert!(
            plan.iter().all(|line| !line.contains("SCAN cursorDiskKV")),
            "query plan must use the cursorDiskKV key index: {plan:?}"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn claude_preview_ignores_injected_context_and_uses_the_latest_message() {
        let (root, service) = test_service();
        let source = service.roots.claude_projects.join("project/claude.jsonl");
        write_file(
            &source,
            concat!(
                "{\"type\":\"user\",\"sessionId\":\"claude-readable\",\"cwd\":\"/old/repo\",\"timestamp\":\"2026-07-01T00:00:00Z\",\"message\":{\"content\":\"<environment_context><cwd>/old/repo</cwd></environment_context>\"}}\n",
                "{\"type\":\"user\",\"sessionId\":\"claude-readable\",\"cwd\":\"/old/repo\",\"timestamp\":\"2026-07-01T00:00:01Z\",\"message\":{\"content\":\"Fix the launcher\"}}\n",
                "{\"type\":\"assistant\",\"sessionId\":\"claude-readable\",\"cwd\":\"/old/repo\",\"timestamp\":\"2026-07-01T00:00:02Z\",\"message\":{\"content\":\"The launcher tests now pass.\"}}\n"
            ),
        );

        let scan = service.scan_local(&["claude".to_string()]).unwrap();
        assert_eq!(scan.candidates[0].title, "Fix the launcher");
        assert_eq!(
            scan.candidates[0].last_message_snippet.as_deref(),
            Some("The launcher tests now pass.")
        );
        assert_eq!(
            scan.candidates[0].file_size_bytes,
            fs::metadata(&source).unwrap().len()
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cursor_reasoning_import_uses_text_without_signature_wrapper() {
        let (root, service) = test_service();
        fs::create_dir_all(service.roots.cursor_database.parent().unwrap()).unwrap();
        let connection = Connection::open(&service.roots.cursor_database).unwrap();
        connection
            .execute_batch("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);")
            .unwrap();
        connection
            .execute(
                "INSERT INTO cursorDiskKV (key, value) VALUES (?1, ?2)",
                params![
                    "bubbleId:cursor-one:bubble-one",
                    r#"{
                      "type": 2,
                      "bubbleId": "bubble-one",
                      "text": "Answer",
                      "thinking": {
                        "signature": "transport-only",
                        "text": "Reasoned explanation"
                      }
                    }"#,
                ],
            )
            .unwrap();
        drop(connection);

        let records = load_cursor_records(&service.roots.cursor_database, "cursor-one").unwrap();
        let reasoning = records
            .iter()
            .find(|record| record.kind == "reasoning")
            .unwrap();
        assert_eq!(reasoning.content, "Reasoned explanation");
        assert!(!reasoning.content.contains("signature"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn context_preview_pages_codex_without_accepting_a_source_path_from_the_client() {
        let (root, service) = test_service();
        let source = service.roots.codex_sessions.join("2026/07/paged.jsonl");
        let mut content = String::from(
            "{\"type\":\"session_meta\",\"timestamp\":\"2026-07-01T00:00:00Z\",\"payload\":{\"id\":\"codex-paged\",\"cwd\":\"C:\\\\repo\"}}\n",
        );
        for index in 0..(CONTEXT_PAGE_RECORD_LIMIT + 3) {
            content.push_str(&format!(
                "{{\"type\":\"event_msg\",\"timestamp\":\"2026-07-01T00:00:{index:02}Z\",\"payload\":{{\"type\":\"{}\",\"message\":\"message {index}\"}}}}\n",
                if index % 2 == 0 { "user_message" } else { "agent_message" }
            ));
        }
        write_file(&source, &content);
        let scan = service.scan_local(&["codex".to_string()]).unwrap();
        let candidate_id = scan.candidates[0].id.clone();

        let first = service
            .context_page(&scan.scan_id, &candidate_id, None)
            .unwrap();
        assert_eq!(first.records.len(), CONTEXT_PAGE_RECORD_LIMIT);
        assert!(!first.complete);
        assert_eq!(first.records[0].content, "message 0");

        let second = service
            .context_page(&scan.scan_id, &candidate_id, first.next_cursor.as_deref())
            .unwrap();
        assert_eq!(second.records.len(), 3);
        assert_eq!(
            second.records[0].content,
            format!("message {CONTEXT_PAGE_RECORD_LIMIT}")
        );
        assert!(second.complete);
        assert!(service
            .context_page("another-scan", &candidate_id, None)
            .is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn context_preview_does_not_let_tool_logs_hide_conversation_messages() {
        let (root, service) = test_service();
        let source = service
            .roots
            .codex_sessions
            .join("2026/07/tool-heavy.jsonl");
        let mut content = String::from(
            "{\"type\":\"session_meta\",\"timestamp\":\"2026-07-01T00:00:00Z\",\"payload\":{\"id\":\"codex-tool-heavy\",\"cwd\":\"C:\\\\repo\"}}\n{\"type\":\"event_msg\",\"timestamp\":\"2026-07-01T00:00:01Z\",\"payload\":{\"type\":\"user_message\",\"message\":\"Start the task\"}}\n",
        );
        for index in 0..45 {
            content.push_str(&format!(
                "{{\"type\":\"response_item\",\"timestamp\":\"2026-07-01T00:00:02Z\",\"payload\":{{\"type\":\"function_call_output\",\"call_id\":\"call-{index}\",\"output\":\"tool log {index}\"}}}}\n"
            ));
        }
        content.push_str(
            "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-01T00:00:03Z\",\"payload\":{\"type\":\"agent_message\",\"message\":\"Task finished\"}}\n",
        );
        write_file(&source, &content);

        let scan = service.scan_local(&["codex".to_string()]).unwrap();
        let page = service
            .context_page(&scan.scan_id, &scan.candidates[0].id, None)
            .unwrap();

        assert!(page.complete);
        assert_eq!(page.records.len(), 2);
        assert!(page.records.iter().all(|record| record.kind == "message"));
        assert_eq!(page.records[0].content, "Start the task");
        assert_eq!(page.records[1].content, "Task finished");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn context_preview_normalizes_claude_blocks_and_cursor_reasoning() {
        let (root, service) = test_service();
        let claude = service.roots.claude_projects.join("project/blocks.jsonl");
        write_file(
            &claude,
            concat!(
                "{\"type\":\"user\",\"sessionId\":\"claude-blocks\",\"cwd\":\"/repo\",\"timestamp\":\"2026-07-01T00:00:00Z\",\"message\":{\"content\":\"Inspect it\"}}\n",
                "{\"type\":\"assistant\",\"sessionId\":\"claude-blocks\",\"timestamp\":\"2026-07-01T00:00:01Z\",\"message\":{\"model\":\"claude-test\",\"content\":[{\"type\":\"text\",\"text\":\"Done\"},{\"type\":\"thinking\",\"thinking\":\"Reasoned\"},{\"type\":\"tool_use\",\"name\":\"Read\",\"input\":{\"path\":\"a.txt\"}}]}}\n"
            ),
        );
        let claude_scan = service.scan_local(&["claude".to_string()]).unwrap();
        let claude_page = service
            .context_page_with_auxiliary(
                &claude_scan.scan_id,
                &claude_scan.candidates[0].id,
                None,
                true,
            )
            .unwrap();
        assert!(claude_page
            .records
            .iter()
            .any(|record| record.kind == "reasoning"));
        assert!(
            claude_page
                .records
                .iter()
                .any(|record| record.kind == "toolCall"
                    && record.tool_name.as_deref() == Some("Read"))
        );

        fs::create_dir_all(service.roots.cursor_database.parent().unwrap()).unwrap();
        let connection = Connection::open(&service.roots.cursor_database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE composerHeaders (
                    composerId TEXT, workspaceId TEXT, createdAt INTEGER,
                    lastUpdatedAt INTEGER, isArchived INTEGER, value TEXT
                );
                CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO composerHeaders
                 (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, value)
                 VALUES ('cursor-context', 'empty-window', 1, 2, 0, '{\"name\":\"Cursor context\"}')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO cursorDiskKV (key, value) VALUES (?1, ?2)",
                params![
                    "bubbleId:cursor-context:one",
                    r#"{"type":2,"text":"Answer","thinking":{"signature":"hidden","text":"Readable reasoning"}}"#
                ],
            )
            .unwrap();
        drop(connection);
        let cursor_scan = service.scan_local(&["cursor".to_string()]).unwrap();
        let cursor_page = service
            .context_page(&cursor_scan.scan_id, &cursor_scan.candidates[0].id, None)
            .unwrap();
        let reasoning = cursor_page
            .records
            .iter()
            .find(|record| record.kind == "reasoning")
            .unwrap();
        assert_eq!(reasoning.content, "Readable reasoning");
        assert!(!reasoning.content.contains("signature"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unix_millisecond_conversion_is_stable_without_platform_timezone() {
        assert_eq!(iso_from_unix_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso_from_unix_millis(1_700_000_000_000),
            "2023-11-14T22:13:20.000Z"
        );
    }
}
