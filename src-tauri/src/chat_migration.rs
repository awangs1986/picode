use percent_encoding::percent_decode_str;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const MAX_SCANS: usize = 8;
const MAX_SCAN_CANDIDATES: usize = 5_000;
const MAX_SOURCE_FILE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_RECORD_TEXT_BYTES: usize = 8 * 1024 * 1024;

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
struct ExternalRecord {
    kind: String,
    role: String,
    content: String,
    timestamp: Option<String>,
    model: Option<String>,
    tool_name: Option<String>,
    source_record_id: Option<String>,
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
            let imported_chat = self.write_import(&candidate, workspace, records)?;
            imported.push(imported_chat);
        }
        Ok(ChatImportResult {
            imported: imported.len().saturating_sub(skipped),
            skipped,
            chats: imported,
        })
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
        let mut statement = connection
            .prepare(
                "SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, value
                 FROM composerHeaders ORDER BY lastUpdatedAt DESC LIMIT ?1",
            )
            .map_err(|error| format!("Cannot inspect Cursor chat headers: {error}"))?;
        let rows = statement
            .query_map([MAX_SCAN_CANDIDATES as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, Option<i64>>(4)?.unwrap_or(0) != 0,
                    row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                ))
            })
            .map_err(|error| format!("Cannot scan Cursor chat headers: {error}"))?;
        for row in rows {
            let (composer_id, workspace_id, created_at, updated_at, archived, raw_header) =
                match row {
                    Ok(value) => value,
                    Err(error) => {
                        warnings.push(format!("Cannot read a Cursor chat header: {error}"));
                        continue;
                    }
                };
            let header: Value = serde_json::from_str(&raw_header).unwrap_or(Value::Null);
            let title = value_string(&header, &["name", "subtitle"])
                .filter(|value| !value.trim().is_empty())
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
        let session_bytes = build_pi_continuation_session(candidate, workspace, &snapshot)?;

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
    stable_hash(&format!(
        "workspace\0{source}\0{}",
        workspace.unwrap_or("<unassigned>")
    ))
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
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Cannot inspect chat file {}: {error}", path.display()))?;
    if metadata.len() > MAX_SOURCE_FILE_BYTES {
        return Err(format!(
            "Chat file {} exceeds the {} MiB safety limit",
            path.display(),
            MAX_SOURCE_FILE_BYTES / 1024 / 1024
        ));
    }
    Ok(())
}

fn open_lines(path: &Path) -> Result<impl Iterator<Item = Result<String, std::io::Error>>, String> {
    check_source_size(path)?;
    let file = File::open(path)
        .map_err(|error| format!("Cannot open chat file {}: {error}", path.display()))?;
    Ok(BufReader::new(file).lines())
}

fn codex_candidate(path: &Path, archived: bool) -> Result<Option<PendingCandidate>, String> {
    let mut source_id = None;
    let mut workspace = None;
    let mut title = None;
    let mut created_at = None;
    for line in open_lines(path)? {
        let line = line.map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
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
            source_id = value_string(payload, &["id", "session_id"]);
            workspace = value_string(payload, &["cwd"]);
            if created_at.is_none() {
                created_at = value_string(payload, &["timestamp"]);
            }
        }
        if title.is_none() {
            title = codex_user_text(&value).map(|text| clean_title(&text));
        }
        if source_id.is_some() && workspace.is_some() && title.is_some() {
            break;
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
    let updated_at = file_modified_iso(path);
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
        },
        source_id,
        source: CandidateSource::Jsonl {
            path: path.to_path_buf(),
        },
    }))
}

fn claude_candidate(path: &Path) -> Result<Option<PendingCandidate>, String> {
    let mut source_id = None;
    let mut workspace = None;
    let mut title = None;
    let mut created_at = None;
    let mut archived = false;
    for line in open_lines(path)? {
        let line = line.map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        source_id = source_id.or_else(|| value_string(&value, &["sessionId"]));
        workspace = workspace.or_else(|| value_string(&value, &["cwd"]));
        created_at = created_at.or_else(|| value_string(&value, &["timestamp"]));
        archived |= value
            .get("isArchived")
            .or_else(|| value.get("archived"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if title.is_none() && value.get("type").and_then(Value::as_str) == Some("user") {
            title = message_text(value.get("message").unwrap_or(&Value::Null))
                .filter(|text| !text.trim().is_empty())
                .map(|text| clean_title(&text));
        }
        if source_id.is_some() && workspace.is_some() && title.is_some() {
            break;
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
            updated_at: file_modified_iso(path),
        },
        source_id,
        source: CandidateSource::Jsonl {
            path: path.to_path_buf(),
        },
    }))
}

fn codex_user_text(value: &Value) -> Option<String> {
    let kind = value.get("type")?.as_str()?;
    let payload = value.get("payload")?;
    let payload_kind = payload.get("type").and_then(Value::as_str);
    if kind == "event_msg" && payload_kind == Some("user_message") {
        return value_string(payload, &["message", "text"]);
    }
    if kind == "response_item"
        && payload_kind == Some("message")
        && payload.get("role").and_then(Value::as_str) == Some("user")
    {
        return message_text(payload);
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
            for key in ["folder", "path", "uri", "rootPath", "workspace"] {
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
    if let Some(encoded) = value.strip_prefix("file://") {
        let decoded = percent_decode_str(encoded).decode_utf8_lossy();
        let mut path = decoded.into_owned();
        if cfg!(windows) && path.starts_with('/') && path.as_bytes().get(2).copied() == Some(b':') {
            path.remove(0);
        }
        return Some(path.replace('/', std::path::MAIN_SEPARATOR_STR));
    }
    let is_windows_absolute = value.len() > 2
        && value.as_bytes().get(1).copied() == Some(b':')
        && matches!(value.as_bytes().get(2), Some(b'\\' | b'/'));
    if value.starts_with('/') || value.starts_with("\\\\") || is_windows_absolute {
        return Some(value.to_string());
    }
    None
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
        let timestamp = value_string(&value, &["timestamp"]);
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let payload = value.get("payload").unwrap_or(&Value::Null);
        let payload_kind = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let record = match (kind, payload_kind) {
            ("event_msg", "user_message") => value_string(payload, &["message", "text"])
                .map(|content| record("message", "user", content, timestamp, None, None, None)),
            ("event_msg", "agent_message") => {
                value_string(payload, &["message", "text"]).map(|content| {
                    record("message", "assistant", content, timestamp, None, None, None)
                })
            }
            ("response_item", "message") => message_text(payload).map(|content| {
                let role = payload
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("assistant");
                record(
                    "message",
                    if role == "user" { "user" } else { "assistant" },
                    content,
                    timestamp,
                    None,
                    None,
                    value_string(payload, &["id"]),
                )
            }),
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
            ("compacted", _) => value_string(&value, &["summary"])
                .or_else(|| value_string(payload, &["summary"]))
                .map(|content| record("summary", "system", content, timestamp, None, None, None)),
            _ => None,
        };
        if let Some(record) = record.filter(|item| !item.content.trim().is_empty()) {
            records.push(record);
        }
    }
    Ok(records)
}

fn load_claude_records(path: &Path) -> Result<Vec<ExternalRecord>, String> {
    let mut records = Vec::new();
    for line in open_lines(path)? {
        let line = line.map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let entry_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let timestamp = value_string(&value, &["timestamp"]);
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
                    value_string(&value, &["uuid"]),
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
                value_string(&value, &["content", "summary"]).filter(|text| !text.trim().is_empty())
            {
                records.push(record(
                    "system",
                    "system",
                    content,
                    timestamp,
                    None,
                    None,
                    value_string(&value, &["uuid"]),
                ));
            }
        }
    }
    Ok(records)
}

fn load_cursor_records(database: &Path, composer_id: &str) -> Result<Vec<ExternalRecord>, String> {
    let connection = open_cursor_database(database)?;
    let mut statement = connection
        .prepare(
            "SELECT rowid, value FROM cursorDiskKV
             WHERE key LIKE ?1 ORDER BY rowid",
        )
        .map_err(|error| format!("Cannot prepare Cursor message import: {error}"))?;
    let pattern = format!("bubbleId:{composer_id}:%");
    let rows = statement
        .query_map([pattern], |row| {
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
        let role = if value.get("type").and_then(Value::as_i64) == Some(1) {
            "user"
        } else {
            "assistant"
        };
        let timestamp = value_string(&value, &["createdAt"]);
        let source_record_id =
            value_string(&value, &["bubbleId"]).or_else(|| Some(format!("row-{row_id}")));
        if let Some(content) =
            value_string(&value, &["text", "richText"]).filter(|text| !text.trim().is_empty())
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
        if let Some(thinking) = value.get("thinking") {
            let content = value_to_bounded_text(thinking);
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
    }
    Ok(records)
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

fn bound_text(value: String) -> String {
    if value.len() <= MAX_RECORD_TEXT_BYTES {
        return value;
    }
    let mut end = MAX_RECORD_TEXT_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n\n[Picot import truncated this single record at {} MiB]",
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
        }
    }));
    parent_id = Some(provenance_id);

    let mut has_user_message = false;
    for source_record in &snapshot.records {
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
    fn import_requires_an_existing_workspace_and_never_executes_the_source_path() {
        let (root, service) = test_service();
        let source = service.roots.codex_sessions.join("2026/07/one.jsonl");
        write_file(
            &source,
            concat!(
                "{\"type\":\"session_meta\",\"timestamp\":\"2026-07-01T00:00:00Z\",\"payload\":{\"id\":\"codex-1\",\"cwd\":\"D:\\\\missing\\\\repo\"}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-01T00:00:01Z\",\"payload\":{\"type\":\"user_message\",\"message\":\"Fix the build\"}}\n",
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
        drop(connection);

        let scan = service.scan_local(&["cursor".to_string()]).unwrap();
        assert_eq!(scan.candidates.len(), 1);
        assert!(scan.candidates[0].archived);
        assert_eq!(scan.candidates[0].title, "Cursor migration");
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
