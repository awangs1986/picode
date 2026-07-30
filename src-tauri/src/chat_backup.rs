use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;
use zeroize::Zeroize;

const CONTAINER_SCHEMA: &str = "picot.chat-backup/v1";
const PAYLOAD_SCHEMA: &str = "picot.chat-backup-payload/v1";
const BACKUP_VERSION: u8 = 1;
const MAX_PENDING_SCANS: usize = 8;
const MAX_PENDING_RESTORES: usize = 4;
const MAX_CHAT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_BACKUP_BYTES: u64 = 1024 * 1024 * 1024;
const ARGON2_MEMORY_KIB: u32 = 19 * 1024;
const ARGON2_ITERATIONS: u32 = 2;
const ARGON2_PARALLELISM: u32 = 1;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupChatCandidate {
    pub id: String,
    pub title: String,
    pub workspace_group_id: String,
    pub workspace_path: String,
    pub session_file: String,
    pub size_bytes: u64,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupWorkspaceGroup {
    pub id: String,
    pub workspace_path: String,
    pub candidate_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSessionScan {
    pub scan_id: String,
    pub candidates: Vec<BackupChatCandidate>,
    pub workspace_groups: Vec<BackupWorkspaceGroup>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSelectionFlags {
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub favourite: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCreationResult {
    pub path: String,
    pub encrypted: bool,
    pub chat_count: usize,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupProbe {
    pub encrypted: bool,
    pub chat_count: usize,
    pub created_at: String,
    pub application_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreChatCandidate {
    pub id: String,
    pub title: String,
    pub workspace_group_id: String,
    pub original_workspace: String,
    pub archived: bool,
    pub favourite: bool,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub restore_id: String,
    pub encrypted: bool,
    pub chats: Vec<RestoreChatCandidate>,
    pub workspace_groups: Vec<BackupWorkspaceGroup>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredChat {
    pub backup_chat_id: String,
    pub session_file: String,
    pub workspace_path: String,
    pub archived: bool,
    pub favourite: bool,
    pub status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub added: usize,
    pub skipped: usize,
    pub conflicted: usize,
    pub chats: Vec<RestoredChat>,
}

#[derive(Debug, Clone)]
struct PendingBackupCandidate {
    summary: BackupChatCandidate,
    path: PathBuf,
}

#[derive(Debug)]
struct PendingBackupScan {
    candidates: Vec<PendingBackupCandidate>,
}

#[derive(Debug, Clone)]
pub(crate) struct CompressionSourceChat {
    pub id: String,
    pub title: String,
    pub workspace_path: String,
    pub updated_at: Option<String>,
    pub content: Vec<u8>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    schema_version: u8,
    created_at: String,
    application_version: String,
    encrypted: bool,
    mode: String,
    chat_count: usize,
    payload_sha256: String,
    chats: Vec<ManifestChat>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestChat {
    id: String,
    content_sha256: String,
    size_bytes: u64,
    attachments: Vec<ManifestAttachment>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestAttachment {
    id: String,
    content_sha256: String,
    size_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupProtection {
    mode: String,
    algorithm: Option<String>,
    kdf: Option<KdfDescription>,
    nonce: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KdfDescription {
    algorithm: String,
    version: u32,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupContainer {
    schema: String,
    manifest: BackupManifest,
    protection: BackupProtection,
    payload: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupPayload {
    schema: String,
    chats: Vec<BackupChat>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupChat {
    id: String,
    title: String,
    original_workspace: String,
    archived: bool,
    favourite: bool,
    source_format: String,
    content: String,
}

#[derive(Debug)]
struct PendingRestore {
    created_at: String,
    payload: BackupPayload,
    manifest_by_id: HashMap<String, ManifestChat>,
}

pub struct ChatBackupService {
    pi_sessions_dir: PathBuf,
    scans: Mutex<HashMap<String, PendingBackupScan>>,
    restores: Mutex<HashMap<String, PendingRestore>>,
}

impl ChatBackupService {
    pub fn for_current_user() -> Result<Self, String> {
        let home = dirs::home_dir().ok_or("Cannot locate the current user's home directory")?;
        Ok(Self::new(home.join(".pi").join("agent").join("sessions")))
    }

    fn new(pi_sessions_dir: PathBuf) -> Self {
        Self {
            pi_sessions_dir,
            scans: Mutex::new(HashMap::new()),
            restores: Mutex::new(HashMap::new()),
        }
    }

    pub fn scan_sessions(&self) -> Result<BackupSessionScan, String> {
        let mut paths = Vec::new();
        collect_session_files(&self.pi_sessions_dir, &mut paths)?;
        let mut candidates = Vec::new();
        for path in paths {
            if let Ok(summary) = summarize_session(&path) {
                candidates.push(PendingBackupCandidate { summary, path });
            }
        }
        candidates.sort_by(|left, right| {
            right
                .summary
                .updated_at
                .cmp(&left.summary.updated_at)
                .then_with(|| left.summary.title.cmp(&right.summary.title))
        });
        let mut groups: HashMap<String, BackupWorkspaceGroup> = HashMap::new();
        for candidate in &candidates {
            groups
                .entry(candidate.summary.workspace_group_id.clone())
                .and_modify(|group| group.candidate_count += 1)
                .or_insert_with(|| BackupWorkspaceGroup {
                    id: candidate.summary.workspace_group_id.clone(),
                    workspace_path: candidate.summary.workspace_path.clone(),
                    candidate_count: 1,
                });
        }
        let mut workspace_groups: Vec<_> = groups.into_values().collect();
        workspace_groups.sort_by(|left, right| left.workspace_path.cmp(&right.workspace_path));
        let scan_id = Uuid::new_v4().to_string();
        let summaries = candidates
            .iter()
            .map(|candidate| candidate.summary.clone())
            .collect();
        let mut scans = self
            .scans
            .lock()
            .map_err(|_| "The chat-backup scan lock is poisoned".to_string())?;
        if scans.len() >= MAX_PENDING_SCANS {
            if let Some(oldest) = scans.keys().next().cloned() {
                scans.remove(&oldest);
            }
        }
        scans.insert(scan_id.clone(), PendingBackupScan { candidates });
        Ok(BackupSessionScan {
            scan_id,
            candidates: summaries,
            workspace_groups,
        })
    }

    pub fn create_backup(
        &self,
        scan_id: &str,
        selected_ids: &[String],
        flags: &HashMap<String, BackupSelectionFlags>,
        encrypted: bool,
        mut password: String,
        destination: &str,
    ) -> Result<BackupCreationResult, String> {
        let result = (|| {
            if selected_ids.is_empty() {
                return Err("Select at least one chat to back up".to_string());
            }
            if encrypted && password.len() < 8 {
                return Err("Encrypted backups require a password of at least 8 characters".into());
            }
            let scans = self
                .scans
                .lock()
                .map_err(|_| "The chat-backup scan lock is poisoned".to_string())?;
            let scan = scans
                .get(scan_id)
                .ok_or("The chat-backup scan expired; scan the sessions again")?;
            let wanted: HashSet<_> = selected_ids.iter().map(String::as_str).collect();
            if wanted.len() != selected_ids.len() {
                return Err("The backup selection contains duplicate chats".to_string());
            }
            let selected: Vec<_> = scan
                .candidates
                .iter()
                .filter(|candidate| wanted.contains(candidate.summary.id.as_str()))
                .collect();
            if selected.len() != wanted.len() {
                return Err("The backup selection is not part of this scan".to_string());
            }

            let mut chats = Vec::with_capacity(selected.len());
            let mut manifest_chats = Vec::with_capacity(selected.len());
            for candidate in selected {
                let bytes = read_bounded(&candidate.path, MAX_CHAT_BYTES)?;
                validate_pi_session(&bytes)?;
                let chat_id = Uuid::new_v4().to_string();
                let selection_flags = flags
                    .get(&candidate.summary.id)
                    .cloned()
                    .unwrap_or_default();
                manifest_chats.push(ManifestChat {
                    id: chat_id.clone(),
                    content_sha256: sha256_hex(&bytes),
                    size_bytes: bytes.len() as u64,
                    attachments: Vec::new(),
                });
                chats.push(BackupChat {
                    id: chat_id,
                    title: candidate.summary.title.clone(),
                    original_workspace: candidate.summary.workspace_path.clone(),
                    archived: selection_flags.archived,
                    favourite: selection_flags.favourite,
                    source_format: "pi-session-jsonl/v3".to_string(),
                    content: BASE64.encode(bytes),
                });
            }
            let payload = BackupPayload {
                schema: PAYLOAD_SCHEMA.to_string(),
                chats,
            };
            let mut plaintext = serde_json::to_vec(&payload)
                .map_err(|error| format!("Cannot encode chat-backup payload: {error}"))?;
            let manifest = BackupManifest {
                schema_version: BACKUP_VERSION,
                created_at: now_iso(),
                application_version: env!("CARGO_PKG_VERSION").to_string(),
                encrypted,
                mode: "full".to_string(),
                chat_count: manifest_chats.len(),
                payload_sha256: sha256_hex(&plaintext),
                chats: manifest_chats,
            };
            let manifest_bytes = serde_json::to_vec(&manifest)
                .map_err(|error| format!("Cannot encode chat-backup manifest: {error}"))?;
            let (protection, encoded_payload) = if encrypted {
                encrypt_payload(&plaintext, &manifest_bytes, &password)?
            } else {
                (
                    BackupProtection {
                        mode: "none".to_string(),
                        algorithm: None,
                        kdf: None,
                        nonce: None,
                    },
                    BASE64.encode(&plaintext),
                )
            };
            plaintext.zeroize();
            let container = BackupContainer {
                schema: CONTAINER_SCHEMA.to_string(),
                manifest,
                protection,
                payload: encoded_payload,
            };
            let encoded = serde_json::to_vec_pretty(&container)
                .map_err(|error| format!("Cannot encode chat-backup container: {error}"))?;
            let destination = normalized_backup_destination(destination)?;
            atomic_write_new(&destination, &encoded)?;
            Ok(BackupCreationResult {
                path: destination.to_string_lossy().into_owned(),
                encrypted,
                chat_count: container.manifest.chat_count,
                size_bytes: encoded.len() as u64,
            })
        })();
        password.zeroize();
        result
    }

    pub(crate) fn compression_sources(
        &self,
        scan_id: &str,
        selected_ids: &[String],
    ) -> Result<Vec<CompressionSourceChat>, String> {
        if selected_ids.is_empty() {
            return Err("Select at least one chat to compress".to_string());
        }
        let wanted: HashSet<_> = selected_ids.iter().map(String::as_str).collect();
        if wanted.len() != selected_ids.len() {
            return Err("The compression selection contains duplicate chats".to_string());
        }
        let scans = self
            .scans
            .lock()
            .map_err(|_| "The chat-backup scan lock is poisoned".to_string())?;
        let scan = scans
            .get(scan_id)
            .ok_or("The chat scan expired; load the sessions again")?;
        let selected: Vec<_> = scan
            .candidates
            .iter()
            .filter(|candidate| wanted.contains(candidate.summary.id.as_str()))
            .collect();
        if selected.len() != wanted.len() {
            return Err("The compression selection is not part of this scan".to_string());
        }
        selected
            .into_iter()
            .map(|candidate| {
                let content = read_bounded(&candidate.path, MAX_CHAT_BYTES)?;
                validate_pi_session(&content)?;
                Ok(CompressionSourceChat {
                    id: candidate.summary.id.clone(),
                    title: candidate.summary.title.clone(),
                    workspace_path: candidate.summary.workspace_path.clone(),
                    updated_at: candidate.summary.updated_at.clone(),
                    content,
                })
            })
            .collect()
    }

    pub fn probe_backup(&self, path: &str) -> Result<BackupProbe, String> {
        let container = read_backup_container(Path::new(path))?;
        validate_container_header(&container)?;
        Ok(BackupProbe {
            encrypted: container.manifest.encrypted,
            chat_count: container.manifest.chat_count,
            created_at: container.manifest.created_at,
            application_version: container.manifest.application_version,
        })
    }

    pub fn inspect_backup(
        &self,
        path: &str,
        mut password: String,
    ) -> Result<RestorePreview, String> {
        let result = (|| {
            let container = read_backup_container(Path::new(path))?;
            validate_container_header(&container)?;
            let manifest_bytes = serde_json::to_vec(&container.manifest)
                .map_err(|error| format!("Cannot verify chat-backup manifest: {error}"))?;
            let mut plaintext = decode_payload(&container, &manifest_bytes, &password)?;
            if sha256_hex(&plaintext) != container.manifest.payload_sha256 {
                plaintext.zeroize();
                return Err("The chat-backup payload failed its integrity check".to_string());
            }
            let payload: BackupPayload = serde_json::from_slice(&plaintext)
                .map_err(|error| format!("Invalid chat-backup payload: {error}"))?;
            plaintext.zeroize();
            if payload.schema != PAYLOAD_SCHEMA {
                return Err(format!(
                    "Unsupported chat-backup payload: {}",
                    payload.schema
                ));
            }
            let manifest_by_id = verify_payload(&container.manifest, &payload)?;
            let mut group_counts: HashMap<String, BackupWorkspaceGroup> = HashMap::new();
            let chats: Vec<_> = payload
                .chats
                .iter()
                .map(|chat| {
                    let group_id = workspace_group_id(&chat.original_workspace);
                    group_counts
                        .entry(group_id.clone())
                        .and_modify(|group| group.candidate_count += 1)
                        .or_insert_with(|| BackupWorkspaceGroup {
                            id: group_id.clone(),
                            workspace_path: chat.original_workspace.clone(),
                            candidate_count: 1,
                        });
                    let size_bytes = manifest_by_id
                        .get(&chat.id)
                        .map_or(0, |manifest| manifest.size_bytes);
                    RestoreChatCandidate {
                        id: chat.id.clone(),
                        title: chat.title.clone(),
                        workspace_group_id: group_id,
                        original_workspace: chat.original_workspace.clone(),
                        archived: chat.archived,
                        favourite: chat.favourite,
                        size_bytes,
                    }
                })
                .collect();
            let mut workspace_groups: Vec<_> = group_counts.into_values().collect();
            workspace_groups.sort_by(|left, right| left.workspace_path.cmp(&right.workspace_path));
            let restore_id = Uuid::new_v4().to_string();
            let encrypted = container.manifest.encrypted;
            let pending = PendingRestore {
                created_at: container.manifest.created_at,
                payload,
                manifest_by_id,
            };
            let mut restores = self
                .restores
                .lock()
                .map_err(|_| "The chat-backup restore lock is poisoned".to_string())?;
            if restores.len() >= MAX_PENDING_RESTORES {
                if let Some(oldest) = restores.keys().next().cloned() {
                    restores.remove(&oldest);
                }
            }
            restores.insert(restore_id.clone(), pending);
            Ok(RestorePreview {
                restore_id,
                encrypted,
                chats,
                workspace_groups,
            })
        })();
        password.zeroize();
        result
    }

    pub fn restore_selected(
        &self,
        restore_id: &str,
        selected_ids: &[String],
        workspace_bindings: &HashMap<String, String>,
    ) -> Result<RestoreResult, String> {
        if selected_ids.is_empty() {
            return Err("Select at least one chat to restore".to_string());
        }
        let mut restores = self
            .restores
            .lock()
            .map_err(|_| "The chat-backup restore lock is poisoned".to_string())?;
        let pending = restores
            .remove(restore_id)
            .ok_or("The verified restore expired; open and verify the backup again")?;
        drop(restores);
        let result = self.restore_from_pending(&pending, selected_ids, workspace_bindings);
        if result.is_err() {
            let mut restores = self
                .restores
                .lock()
                .map_err(|_| "The chat-backup restore lock is poisoned".to_string())?;
            restores.insert(restore_id.to_string(), pending);
        }
        result
    }

    fn restore_from_pending(
        &self,
        pending: &PendingRestore,
        selected_ids: &[String],
        workspace_bindings: &HashMap<String, String>,
    ) -> Result<RestoreResult, String> {
        let wanted: HashSet<_> = selected_ids.iter().map(String::as_str).collect();
        if wanted.len() != selected_ids.len() {
            return Err("The restore selection contains duplicate chats".to_string());
        }
        let selected: Vec<_> = pending
            .payload
            .chats
            .iter()
            .filter(|chat| wanted.contains(chat.id.as_str()))
            .collect();
        if selected.len() != wanted.len() {
            return Err("The restore selection is not part of the verified backup".to_string());
        }
        let mut canonical_bindings = HashMap::new();
        for chat in &selected {
            let group_id = workspace_group_id(&chat.original_workspace);
            if canonical_bindings.contains_key(&group_id) {
                continue;
            }
            let target = workspace_bindings.get(&group_id).ok_or_else(|| {
                format!("Choose a current workspace for {}", chat.original_workspace)
            })?;
            canonical_bindings.insert(group_id, canonical_existing_directory(target)?);
        }

        let mut planned = Vec::new();
        let mut reserved = HashMap::<PathBuf, Vec<u8>>::new();
        let mut chats = Vec::new();
        let mut skipped = 0;
        let mut conflicted = 0;
        for chat in selected {
            let manifest = pending
                .manifest_by_id
                .get(&chat.id)
                .ok_or("The verified manifest no longer matches its payload")?;
            let group_id = workspace_group_id(&chat.original_workspace);
            let workspace = canonical_bindings
                .get(&group_id)
                .ok_or("A verified workspace binding is missing")?;
            let content = BASE64
                .decode(&chat.content)
                .map_err(|error| format!("Invalid verified session content: {error}"))?;
            let session_dir = session_directory(&self.pi_sessions_dir, workspace);
            let base_name = format!(
                "picot-restore-{}.jsonl",
                &manifest.content_sha256[..16.min(manifest.content_sha256.len())]
            );
            let base_path = session_dir.join(base_name);
            let regular_bytes =
                rewrite_session(&content, workspace, chat, &pending.created_at, false)?;
            let existing = if let Some(bytes) = reserved.get(&base_path) {
                Some(bytes.clone())
            } else if base_path.exists() {
                Some(read_bounded(&base_path, MAX_CHAT_BYTES)?)
            } else {
                None
            };
            if existing.as_deref() == Some(regular_bytes.as_slice()) {
                skipped += 1;
                chats.push(restored_summary(chat, workspace, &base_path, "skipped"));
                continue;
            }

            let (target_path, output, status) = if existing.is_some() {
                conflicted += 1;
                let conflict_path = session_dir.join(format!(
                    "picot-restore-{}-conflict-{}.jsonl",
                    &manifest.content_sha256[..12.min(manifest.content_sha256.len())],
                    Uuid::new_v4().simple()
                ));
                let conflict_bytes =
                    rewrite_session(&content, workspace, chat, &pending.created_at, true)?;
                (conflict_path, conflict_bytes, "conflicted")
            } else {
                (base_path, regular_bytes, "added")
            };
            reserved.insert(target_path.clone(), output.clone());
            planned.push((target_path.clone(), output));
            chats.push(restored_summary(chat, workspace, &target_path, status));
        }

        let mut created = Vec::new();
        for (path, bytes) in &planned {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    rollback_created(&created);
                    format!("Cannot create restored-session directory: {error}")
                })?;
            }
            if let Err(error) = atomic_write_new(path, bytes) {
                rollback_created(&created);
                return Err(error);
            }
            created.push(path.clone());
        }
        Ok(RestoreResult {
            added: planned.len().saturating_sub(conflicted),
            skipped,
            conflicted,
            chats,
        })
    }
}

fn restored_summary(
    chat: &BackupChat,
    workspace: &Path,
    path: &Path,
    status: &str,
) -> RestoredChat {
    RestoredChat {
        backup_chat_id: chat.id.clone(),
        session_file: path.to_string_lossy().into_owned(),
        workspace_path: workspace.to_string_lossy().into_owned(),
        archived: chat.archived,
        favourite: chat.favourite,
        status: status.to_string(),
    }
}

fn collect_session_files(root: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    for directory in fs::read_dir(root).map_err(|error| {
        format!(
            "Cannot scan Pi session directory {}: {error}",
            root.display()
        )
    })? {
        let directory =
            directory.map_err(|error| format!("Cannot read Pi session entry: {error}"))?;
        let metadata = directory
            .file_type()
            .map_err(|error| format!("Cannot inspect Pi session entry: {error}"))?;
        if metadata.is_symlink() || !metadata.is_dir() {
            continue;
        }
        for entry in fs::read_dir(directory.path()).map_err(|error| {
            format!(
                "Cannot scan Pi workspace sessions {}: {error}",
                directory.path().display()
            )
        })? {
            let entry = entry.map_err(|error| format!("Cannot read Pi session file: {error}"))?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("Cannot inspect Pi session file: {error}"))?;
            let path = entry.path();
            if !file_type.is_symlink()
                && file_type.is_file()
                && path.extension().and_then(|extension| extension.to_str()) == Some("jsonl")
            {
                output.push(path);
            }
        }
    }
    Ok(())
}

fn summarize_session(path: &Path) -> Result<BackupChatCandidate, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Cannot inspect session {}: {error}", path.display()))?;
    if metadata.len() > MAX_CHAT_BYTES {
        return Err(format!(
            "Session is too large to back up: {}",
            path.display()
        ));
    }
    let mut file = File::open(path)
        .map_err(|error| format!("Cannot open session {}: {error}", path.display()))?;
    let mut preview = Vec::new();
    Read::by_ref(&mut file)
        .take(2 * 1024 * 1024)
        .read_to_end(&mut preview)
        .map_err(|error| format!("Cannot preview session {}: {error}", path.display()))?;
    let text = String::from_utf8_lossy(&preview);
    let mut workspace = None;
    let mut title = None;
    for (index, line) in text.lines().enumerate() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if index == 0 && value.get("type").and_then(Value::as_str) == Some("session") {
            workspace = value.get("cwd").and_then(Value::as_str).map(str::to_string);
        }
        if value.get("type").and_then(Value::as_str) == Some("session_info") {
            title = value
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string);
            if title.is_some() {
                break;
            }
        }
    }
    let workspace = workspace.ok_or("Session header does not contain a workspace")?;
    let title = title.unwrap_or_else(|| {
        path.file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("Untitled chat")
            .to_string()
    });
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("Cannot resolve session {}: {error}", path.display()))?;
    Ok(BackupChatCandidate {
        id: sha256_hex(canonical.to_string_lossy().as_bytes()),
        title,
        workspace_group_id: workspace_group_id(&workspace),
        workspace_path: workspace,
        session_file: portable_display_path(&canonical),
        size_bytes: metadata.len(),
        updated_at: metadata.modified().ok().map(system_time_iso),
    })
}

fn validate_pi_session(bytes: &[u8]) -> Result<(), String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "Pi session is not valid UTF-8")?;
    let mut lines = text.lines();
    let first = lines.next().ok_or("Pi session is empty")?;
    let header: Value = serde_json::from_str(first)
        .map_err(|error| format!("Invalid Pi session header: {error}"))?;
    if header.get("type").and_then(Value::as_str) != Some("session")
        || header.get("cwd").and_then(Value::as_str).is_none()
    {
        return Err("Unsupported Pi session header".to_string());
    }
    for line in lines.filter(|line| !line.trim().is_empty()) {
        serde_json::from_str::<Value>(line)
            .map_err(|error| format!("Invalid Pi session record: {error}"))?;
    }
    Ok(())
}

fn verify_payload(
    manifest: &BackupManifest,
    payload: &BackupPayload,
) -> Result<HashMap<String, ManifestChat>, String> {
    if manifest.chat_count != payload.chats.len() || manifest.chats.len() != payload.chats.len() {
        return Err("The chat-backup manifest count does not match its payload".to_string());
    }
    let mut by_id = HashMap::new();
    for item in &manifest.chats {
        if by_id.contains_key(&item.id) {
            return Err("The chat-backup manifest contains duplicate chat IDs".to_string());
        }
        by_id.insert(
            item.id.clone(),
            ManifestChat {
                id: item.id.clone(),
                content_sha256: item.content_sha256.clone(),
                size_bytes: item.size_bytes,
                attachments: item
                    .attachments
                    .iter()
                    .map(|attachment| ManifestAttachment {
                        id: attachment.id.clone(),
                        content_sha256: attachment.content_sha256.clone(),
                        size_bytes: attachment.size_bytes,
                    })
                    .collect(),
            },
        );
    }
    let mut payload_ids = HashSet::new();
    for chat in &payload.chats {
        if chat.source_format != "pi-session-jsonl/v3" || !payload_ids.insert(chat.id.as_str()) {
            return Err("The chat-backup payload contains an unsupported or duplicate chat".into());
        }
        let item = by_id
            .get(&chat.id)
            .ok_or("The chat-backup payload has no matching manifest entry")?;
        let content = BASE64
            .decode(&chat.content)
            .map_err(|error| format!("Invalid backed-up session encoding: {error}"))?;
        if item.size_bytes != content.len() as u64 || item.content_sha256 != sha256_hex(&content) {
            return Err(format!("Chat {} failed its integrity check", chat.id));
        }
        validate_pi_session(&content)?;
        if !item.attachments.is_empty() {
            return Err("This Picode version cannot restore detached backup attachments".into());
        }
    }
    Ok(by_id)
}

fn validate_container_header(container: &BackupContainer) -> Result<(), String> {
    if container.schema != CONTAINER_SCHEMA {
        return Err(format!(
            "Unsupported chat-backup schema: {}",
            container.schema
        ));
    }
    if container.manifest.schema_version > BACKUP_VERSION {
        return Err(
            "This backup was created by a newer Picode; upgrade Picode to restore it".into(),
        );
    }
    if container.manifest.schema_version != BACKUP_VERSION || container.manifest.mode != "full" {
        return Err("Unsupported chat-backup version or mode".to_string());
    }
    if !matches!(container.protection.mode.as_str(), "none" | "password") {
        return Err("Unsupported chat-backup protection mode".to_string());
    }
    let encrypted = container.protection.mode == "password";
    if encrypted != container.manifest.encrypted {
        return Err("The chat-backup protection metadata is inconsistent".to_string());
    }
    if !encrypted
        && (container.protection.algorithm.is_some()
            || container.protection.kdf.is_some()
            || container.protection.nonce.is_some())
    {
        return Err("The plaintext backup has unexpected encryption metadata".to_string());
    }
    if encrypted
        && (container.protection.algorithm.is_none()
            || container.protection.kdf.is_none()
            || container.protection.nonce.is_none())
    {
        return Err("The encrypted backup is missing protection metadata".to_string());
    }
    Ok(())
}

fn encrypt_payload(
    plaintext: &[u8],
    aad: &[u8],
    password: &str,
) -> Result<(BackupProtection, String), String> {
    let mut salt = [0_u8; 16];
    let mut nonce = [0_u8; 12];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let kdf = KdfDescription {
        algorithm: "Argon2id".to_string(),
        version: 19,
        memory_kib: ARGON2_MEMORY_KIB,
        iterations: ARGON2_ITERATIONS,
        parallelism: ARGON2_PARALLELISM,
        salt: BASE64.encode(salt),
    };
    let mut key = derive_key(password, &salt, &kdf)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| "Cannot initialize chat-backup encryption".to_string())?;
    let encrypted = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            aes_gcm::aead::Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| "Cannot encrypt chat-backup payload".to_string());
    key.zeroize();
    let ciphertext = encrypted?;
    Ok((
        BackupProtection {
            mode: "password".to_string(),
            algorithm: Some("AES-256-GCM".to_string()),
            kdf: Some(kdf),
            nonce: Some(BASE64.encode(nonce)),
        },
        BASE64.encode(ciphertext),
    ))
}

pub(crate) fn protect_portable_payload(
    plaintext: &[u8],
    aad: &[u8],
    encrypted: bool,
    password: &str,
) -> Result<(BackupProtection, String), String> {
    if encrypted {
        encrypt_payload(plaintext, aad, password)
    } else {
        Ok((
            BackupProtection {
                mode: "none".to_string(),
                algorithm: None,
                kdf: None,
                nonce: None,
            },
            BASE64.encode(plaintext),
        ))
    }
}

fn decode_payload(
    container: &BackupContainer,
    aad: &[u8],
    password: &str,
) -> Result<Vec<u8>, String> {
    let encoded = BASE64
        .decode(&container.payload)
        .map_err(|error| format!("Invalid chat-backup payload encoding: {error}"))?;
    if !container.manifest.encrypted {
        return Ok(encoded);
    }
    if password.is_empty() {
        return Err("This chat backup requires its password".to_string());
    }
    if container.protection.algorithm.as_deref() != Some("AES-256-GCM") {
        return Err("Unsupported chat-backup encryption algorithm".to_string());
    }
    let kdf = container
        .protection
        .kdf
        .as_ref()
        .ok_or("Encrypted chat backup has no key-derivation settings")?;
    let salt = BASE64
        .decode(&kdf.salt)
        .map_err(|error| format!("Invalid chat-backup salt: {error}"))?;
    let nonce = BASE64
        .decode(
            container
                .protection
                .nonce
                .as_deref()
                .ok_or("Encrypted chat backup has no nonce")?,
        )
        .map_err(|error| format!("Invalid chat-backup nonce: {error}"))?;
    if salt.len() != 16 || nonce.len() != 12 {
        return Err("Invalid chat-backup salt or nonce length".to_string());
    }
    let mut key = derive_key(password, &salt, kdf)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| "Cannot initialize chat-backup decryption".to_string())?;
    let decrypted = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            aes_gcm::aead::Payload { msg: &encoded, aad },
        )
        .map_err(|_| "Cannot decrypt the chat backup; the password or file is incorrect".into());
    key.zeroize();
    decrypted
}

fn derive_key(password: &str, salt: &[u8], kdf: &KdfDescription) -> Result<[u8; 32], String> {
    if kdf.algorithm != "Argon2id"
        || kdf.version != 19
        || !(8 * 1024..=256 * 1024).contains(&kdf.memory_kib)
        || !(1..=10).contains(&kdf.iterations)
        || !(1..=8).contains(&kdf.parallelism)
    {
        return Err("Unsupported or unsafe chat-backup key-derivation settings".to_string());
    }
    let params = Params::new(kdf.memory_kib, kdf.iterations, kdf.parallelism, Some(32))
        .map_err(|error| format!("Invalid chat-backup key-derivation settings: {error}"))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0_u8; 32];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|error| format!("Cannot derive chat-backup encryption key: {error}"))?;
    Ok(key)
}

fn rewrite_session(
    content: &[u8],
    workspace: &Path,
    chat: &BackupChat,
    backup_created_at: &str,
    conflict: bool,
) -> Result<Vec<u8>, String> {
    validate_pi_session(content)?;
    let text = std::str::from_utf8(content).map_err(|_| "Backed-up session is not UTF-8")?;
    let mut values = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        values.push(
            serde_json::from_str::<Value>(line)
                .map_err(|error| format!("Invalid backed-up session record: {error}"))?,
        );
    }
    let header = values.first_mut().ok_or("Backed-up session is empty")?;
    header["cwd"] = Value::String(workspace.to_string_lossy().into_owned());
    if conflict {
        header["id"] = Value::String(Uuid::new_v4().to_string());
    }
    let parent_id = values
        .iter()
        .rev()
        .find_map(|entry| entry.get("id").and_then(Value::as_str))
        .map(str::to_string);
    let marker_id =
        sha256_hex(format!("{}:{}:{}", chat.id, workspace.to_string_lossy(), conflict).as_bytes())
            [..16]
            .to_string();
    values.push(json!({
        "type": "custom",
        "id": marker_id,
        "parentId": parent_id,
        "timestamp": backup_created_at,
        "customType": "picot.backup-restore",
        "data": {
            "schema": CONTAINER_SCHEMA,
            "backupChatId": chat.id,
            "originalWorkspace": chat.original_workspace,
            "boundWorkspace": workspace.to_string_lossy(),
            "conflictCopy": conflict,
        }
    }));
    if conflict {
        values.push(json!({
            "type": "session_info",
            "id": Uuid::new_v4().simple().to_string()[..16].to_string(),
            "parentId": marker_id,
            "timestamp": backup_created_at,
            "name": format!("[Restored conflict] {}", chat.title),
        }));
    }
    let mut output = Vec::new();
    for value in values {
        serde_json::to_writer(&mut output, &value)
            .map_err(|error| format!("Cannot encode restored session: {error}"))?;
        output.push(b'\n');
    }
    Ok(output)
}

fn normalized_backup_destination(value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Choose a destination for the chat backup".to_string());
    }
    let mut path = PathBuf::from(trimmed);
    if path.extension().and_then(|extension| extension.to_str()) != Some("picot-backup") {
        path.set_extension("picot-backup");
    }
    let parent = path
        .parent()
        .ok_or("The chat-backup destination has no parent directory")?;
    if !parent.is_dir() {
        return Err("The chat-backup destination directory does not exist".to_string());
    }
    if path.exists() {
        return Err("The selected backup file already exists; choose a new file name".to_string());
    }
    Ok(path)
}

fn read_backup_container(path: &Path) -> Result<BackupContainer, String> {
    let bytes = read_bounded(path, MAX_BACKUP_BYTES)?;
    serde_json::from_slice(&bytes).map_err(|error| format!("Invalid chat-backup file: {error}"))
}

fn read_bounded(path: &Path, maximum: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Cannot inspect {}: {error}", path.display()))?;
    if !metadata.is_file() || metadata.len() > maximum {
        return Err(format!(
            "File is missing or exceeds the safety limit: {}",
            path.display()
        ));
    }
    let bytes =
        fs::read(path).map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
    if bytes.len() as u64 > maximum {
        return Err(format!(
            "File grew beyond the safety limit: {}",
            path.display()
        ));
    }
    Ok(bytes)
}

fn canonical_existing_directory(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.trim());
    let canonical = fs::canonicalize(&path)
        .map_err(|error| format!("Cannot resolve workspace {}: {error}", path.display()))?;
    if !canonical.is_dir() {
        return Err(format!(
            "Workspace is not a directory: {}",
            canonical.display()
        ));
    }
    Ok(PathBuf::from(portable_display_path(&canonical)))
}

fn session_directory(root: &Path, workspace: &Path) -> PathBuf {
    let resolved = portable_display_path(workspace);
    let trimmed = resolved.trim_start_matches(['/', '\\']);
    let encoded: String = trimmed
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' => '-',
            other => other,
        })
        .collect();
    root.join(format!("--{encoded}--"))
}

fn portable_display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
}

fn workspace_group_id(workspace: &str) -> String {
    format!("workspace-{}", &sha256_hex(workspace.as_bytes())[..20])
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn atomic_write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Output path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Cannot create output directory {}: {error}",
            parent.display()
        )
    })?;
    let temporary = parent.join(format!(".picot-backup-{}.tmp", Uuid::new_v4().simple()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| format!("Cannot create temporary backup file: {error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("Cannot write temporary backup file: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Cannot sync temporary backup file: {error}"))?;
        if path.exists() {
            return Err(format!(
                "Refusing to overwrite existing file: {}",
                path.display()
            ));
        }
        fs::rename(&temporary, path)
            .map_err(|error| format!("Cannot finish output file {}: {error}", path.display()))?;
        restrict_file_permissions(path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn rollback_created(paths: &[PathBuf]) {
    for path in paths.iter().rev() {
        let _ = fs::remove_file(path);
    }
}

pub(crate) fn now_iso() -> String {
    system_time_iso(SystemTime::now())
}

fn system_time_iso(time: SystemTime) -> String {
    let millis = time
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64;
    let seconds = millis.div_euclid(1000);
    let milliseconds = millis.rem_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let seconds_in_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_in_day / 3_600;
    let minute = (seconds_in_day % 3_600) / 60;
    let second = seconds_in_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milliseconds:03}Z")
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
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

#[cfg(unix)]
fn restrict_file_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| {
        format!(
            "Cannot restrict backup permissions {}: {error}",
            path.display()
        )
    })
}

#[cfg(not(unix))]
fn restrict_file_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(cwd: &str, name: &str, message: &str) -> Vec<u8> {
        format!(
            "{}\n{}\n{}\n",
            json!({"type":"session","version":3,"id":"session-1","timestamp":"2026-01-01T00:00:00.000Z","cwd":cwd}),
            json!({"type":"session_info","id":"info-1","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","name":name}),
            json!({"type":"message","id":"msg-1","parentId":"info-1","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":message,"timestamp":1}})
        )
        .into_bytes()
    }

    fn fixture() -> (PathBuf, ChatBackupService, PathBuf) {
        let temp = std::env::temp_dir().join(format!("picot-chat-backup-{}", Uuid::new_v4()));
        let sessions = temp.join("sessions");
        let source = sessions.join("--old--");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("one.jsonl"),
            session("D:\\old", "One", "secret chat"),
        )
        .unwrap();
        let workspace = temp.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        (temp, ChatBackupService::new(sessions), workspace)
    }

    #[test]
    fn encrypted_backup_round_trips_and_hides_chat_text() {
        let (temp, service, workspace) = fixture();
        let scan = service.scan_sessions().unwrap();
        assert!(!scan.candidates[0].session_file.starts_with(r"\\?\"));
        let destination = temp.join("encrypted.picot-backup");
        service
            .create_backup(
                &scan.scan_id,
                &[scan.candidates[0].id.clone()],
                &HashMap::new(),
                true,
                "correct horse".to_string(),
                destination.to_str().unwrap(),
            )
            .unwrap();
        let encoded = fs::read_to_string(&destination).unwrap();
        assert!(!encoded.contains("secret chat"));
        assert!(service
            .inspect_backup(destination.to_str().unwrap(), "wrong pass".to_string())
            .is_err());
        let preview = service
            .inspect_backup(destination.to_str().unwrap(), "correct horse".to_string())
            .unwrap();
        let mut bindings = HashMap::new();
        bindings.insert(
            preview.workspace_groups[0].id.clone(),
            workspace.to_string_lossy().into_owned(),
        );
        let result = service
            .restore_selected(
                &preview.restore_id,
                &[preview.chats[0].id.clone()],
                &bindings,
            )
            .unwrap();
        assert_eq!(result.added, 1);
        let restored = fs::read_to_string(&result.chats[0].session_file).unwrap();
        assert!(restored.contains("secret chat"));
        let restored_header: Value =
            serde_json::from_str(restored.lines().next().unwrap()).unwrap();
        assert_eq!(
            restored_header["cwd"],
            portable_display_path(&fs::canonicalize(&workspace).unwrap())
        );
        assert!(!restored.contains("\"cwd\":\"D:\\\\old\""));
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn restore_is_idempotent_and_never_overwrites_a_modified_session() {
        let (temp, service, workspace) = fixture();
        let scan = service.scan_sessions().unwrap();
        let destination = temp.join("plain.picot-backup");
        service
            .create_backup(
                &scan.scan_id,
                &[scan.candidates[0].id.clone()],
                &HashMap::new(),
                false,
                String::new(),
                destination.to_str().unwrap(),
            )
            .unwrap();
        let restore_once = |service: &ChatBackupService| {
            let preview = service
                .inspect_backup(destination.to_str().unwrap(), String::new())
                .unwrap();
            let mut bindings = HashMap::new();
            bindings.insert(
                preview.workspace_groups[0].id.clone(),
                workspace.to_string_lossy().into_owned(),
            );
            service
                .restore_selected(
                    &preview.restore_id,
                    &[preview.chats[0].id.clone()],
                    &bindings,
                )
                .unwrap()
        };
        let first = restore_once(&service);
        let second = restore_once(&service);
        assert_eq!((first.added, first.skipped, first.conflicted), (1, 0, 0));
        assert_eq!((second.added, second.skipped, second.conflicted), (0, 1, 0));
        fs::OpenOptions::new()
            .append(true)
            .open(&first.chats[0].session_file)
            .unwrap()
            .write_all(b"\n")
            .unwrap();
        let third = restore_once(&service);
        assert_eq!((third.added, third.skipped, third.conflicted), (0, 0, 1));
        assert_ne!(third.chats[0].session_file, first.chats[0].session_file);
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn corruption_aborts_before_any_restore_write() {
        let (temp, service, workspace) = fixture();
        let scan = service.scan_sessions().unwrap();
        let destination = temp.join("plain.picot-backup");
        service
            .create_backup(
                &scan.scan_id,
                &[scan.candidates[0].id.clone()],
                &HashMap::new(),
                false,
                String::new(),
                destination.to_str().unwrap(),
            )
            .unwrap();
        let mut container: Value =
            serde_json::from_slice(&fs::read(&destination).unwrap()).unwrap();
        container["payload"] = Value::String(BASE64.encode(b"corrupt"));
        fs::write(&destination, serde_json::to_vec(&container).unwrap()).unwrap();
        assert!(service
            .inspect_backup(destination.to_str().unwrap(), String::new())
            .is_err());
        let restored_dir = session_directory(&service.pi_sessions_dir, &workspace);
        assert!(!restored_dir.exists());
        let _ = fs::remove_dir_all(temp);
    }
}
