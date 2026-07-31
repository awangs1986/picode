use crate::capability::{
    parse_tools_md, Activation, CapabilityCatalog, CapabilityManifest, CapabilityScope,
    CapabilitySearchResult, CapabilitySummary, CapabilityTier, IndexLimits, IndexMatch,
    LocalCodeIndex, ResidentCore,
};
use crate::execution::TaskKind;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::Value;
use sha2::Digest;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
#[cfg(test)]
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const STATE_VERSION: u32 = 1;
const MAX_INDEX_FILES: usize = 2_000;
const MAX_INDEX_FILE_BYTES: usize = 512 * 1024;
const MAX_WALK_ENTRIES: usize = 20_000;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedCapabilityState {
    schema_version: u32,
    #[serde(default)]
    catalog_opt_in: BTreeMap<String, bool>,
    #[serde(default)]
    module_tiers: BTreeMap<String, CapabilityTier>,
    #[serde(default)]
    firstmate_root: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCapabilityContext {
    pub task_id: String,
    pub task_kind: TaskKind,
    pub catalog_enabled: bool,
    pub task_capabilities: Vec<String>,
    pub tools_declaration_state: String,
    pub compact_prompt: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySnapshot {
    pub resident_core: ResidentCore,
    pub resident_process_count: usize,
    pub capabilities: Vec<CapabilitySummary>,
}

pub struct CapabilityService {
    root: PathBuf,
    state: PersistedCapabilityState,
    catalog: CapabilityCatalog,
    indexes: BTreeMap<String, LocalCodeIndex>,
}

impl CapabilityService {
    pub fn open(root: &Path) -> Result<Self, String> {
        fs::create_dir_all(root)
            .map_err(|error| format!("create capability state directory: {error}"))?;
        let path = root.join("state.json");
        let state = if path.exists() {
            serde_json::from_slice::<PersistedCapabilityState>(
                &fs::read(&path).map_err(|error| format!("read capability state: {error}"))?,
            )
            .map_err(|error| format!("invalid capability state: {error}"))?
        } else {
            PersistedCapabilityState {
                schema_version: STATE_VERSION,
                catalog_opt_in: BTreeMap::new(),
                module_tiers: BTreeMap::new(),
                firstmate_root: None,
            }
        };
        if state.schema_version != STATE_VERSION {
            return Err(format!(
                "unsupported capability state schema {}",
                state.schema_version
            ));
        }
        let mut catalog = CapabilityCatalog::new(ResidentCore::required());
        for manifest in builtin_manifests() {
            catalog.register(manifest)?;
        }
        for (id, tier) in &state.module_tiers {
            catalog.set_tier(id, *tier)?;
        }
        let service = Self {
            root: root.to_owned(),
            state,
            catalog,
            indexes: BTreeMap::new(),
        };
        service.persist()?;
        Ok(service)
    }

    pub fn snapshot(&self) -> CapabilitySnapshot {
        CapabilitySnapshot {
            resident_core: self.catalog.resident_core.clone(),
            resident_process_count: self.catalog.resident_process_count(),
            capabilities: self.catalog.summaries(),
        }
    }

    pub fn set_catalog_opt_in(&mut self, task_id: &str, enabled: bool) -> Result<(), String> {
        if task_id.trim().is_empty() {
            return Err("task id is required".into());
        }
        self.state
            .catalog_opt_in
            .insert(task_id.to_owned(), enabled);
        self.persist()
    }

    pub fn set_module_tier(&mut self, id: &str, tier: CapabilityTier) -> Result<(), String> {
        self.catalog.set_tier(id, tier)?;
        self.state.module_tiers.insert(id.to_owned(), tier);
        self.persist()
    }

    pub fn firstmate_root(&self) -> Option<PathBuf> {
        self.state
            .firstmate_root
            .clone()
            .filter(|path| path.is_dir())
            .or_else(discover_firstmate_root)
    }

    pub fn set_firstmate_root(&mut self, path: &Path) -> Result<PathBuf, String> {
        if !path.is_dir() {
            return Err("Firstmate directory does not exist".into());
        }
        let resolved = path
            .canonicalize()
            .map_err(|error| format!("resolve Firstmate directory: {error}"))?;
        if !resolved.join("AGENTS.md").is_file() {
            return Err("Firstmate directory must contain AGENTS.md".into());
        }
        self.state.firstmate_root = Some(resolved.clone());
        self.persist()?;
        Ok(resolved)
    }

    pub fn search(
        &self,
        task_id: &str,
        kind: TaskKind,
        query: &str,
        limit: usize,
    ) -> Result<Vec<CapabilitySearchResult>, String> {
        if kind == TaskKind::Simple
            && !self
                .state
                .catalog_opt_in
                .get(task_id)
                .copied()
                .unwrap_or(false)
        {
            return Err("Simple Task capability search requires explicit opt-in".into());
        }
        if query.trim().is_empty() {
            return Err("capability search query is required".into());
        }
        Ok(self.catalog.search_tools(query, limit.clamp(1, 20)))
    }

    pub fn prepare_task(
        &mut self,
        task_id: &str,
        kind: TaskKind,
        workspace: Option<&Path>,
    ) -> Result<TaskCapabilityContext, String> {
        let catalog_enabled = kind == TaskKind::Harness
            || self
                .state
                .catalog_opt_in
                .get(task_id)
                .copied()
                .unwrap_or(false);
        let mut declaration_state = "absent".to_owned();
        let mut task_capabilities = Vec::new();
        if let Some(workspace) = workspace.filter(|path| path.is_dir()) {
            let tools_path = workspace.join("TOOLS.md");
            if tools_path.is_file() {
                let source = fs::read_to_string(&tools_path)
                    .map_err(|error| format!("read {}: {error}", tools_path.display()))?;
                match parse_tools_md(&source) {
                    Ok(declaration) => {
                        self.catalog.bind_task(task_id, &declaration)?;
                        task_capabilities = self.catalog.task_capabilities(task_id);
                        declaration_state = "bound".to_owned();
                    }
                    Err(error) => declaration_state = format!("invalid: {error}"),
                }
            }
        }
        let compact_prompt = if catalog_enabled || !task_capabilities.is_empty() {
            build_compact_prompt(catalog_enabled, &task_capabilities, &declaration_state)
        } else {
            String::new()
        };
        Ok(TaskCapabilityContext {
            task_id: task_id.to_owned(),
            task_kind: kind,
            catalog_enabled,
            task_capabilities,
            tools_declaration_state: declaration_state,
            compact_prompt,
        })
    }

    pub fn refresh_index(&mut self, task_id: &str, workspace: &Path) -> Result<usize, String> {
        let root = workspace
            .canonicalize()
            .map_err(|error| format!("resolve workspace for indexing: {error}"))?;
        let mut index = LocalCodeIndex::new(IndexLimits {
            max_files: MAX_INDEX_FILES,
            max_bytes_per_file: MAX_INDEX_FILE_BYTES,
        });
        let mut pending = vec![root.clone()];
        let mut visited = 0usize;
        let mut indexed = 0usize;
        while let Some(directory) = pending.pop() {
            for entry in fs::read_dir(&directory)
                .map_err(|error| format!("read index directory {}: {error}", directory.display()))?
            {
                let entry = entry.map_err(|error| format!("read index entry: {error}"))?;
                visited += 1;
                if visited > MAX_WALK_ENTRIES || indexed >= MAX_INDEX_FILES {
                    break;
                }
                let path = entry.path();
                let relative = path
                    .strip_prefix(&root)
                    .map_err(|_| "indexed path escaped workspace".to_owned())?;
                if excluded_path(relative) {
                    continue;
                }
                let kind = entry
                    .file_type()
                    .map_err(|error| format!("inspect index entry: {error}"))?;
                if kind.is_symlink() {
                    continue;
                }
                if kind.is_dir() {
                    pending.push(path);
                    continue;
                }
                if !kind.is_file() {
                    continue;
                }
                let metadata = entry
                    .metadata()
                    .map_err(|error| format!("inspect indexed file: {error}"))?;
                if metadata.len() > MAX_INDEX_FILE_BYTES as u64 {
                    continue;
                }
                let bytes = fs::read(&path)
                    .map_err(|error| format!("read indexed file {}: {error}", path.display()))?;
                if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
                    continue;
                }
                let version = format!("sha256:{:x}", sha2::Sha256::digest(&bytes));
                index.update(&relative.to_string_lossy(), &bytes, &version, false)?;
                indexed += 1;
            }
            if visited > MAX_WALK_ENTRIES || indexed >= MAX_INDEX_FILES {
                break;
            }
        }
        self.indexes.insert(task_id.to_owned(), index);
        Ok(indexed)
    }

    pub fn search_code(
        &self,
        task_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<IndexMatch>, String> {
        if query.trim().is_empty() {
            return Err("code search query is required".into());
        }
        let index = self
            .indexes
            .get(task_id)
            .ok_or_else(|| "task code index is not loaded".to_owned())?;
        Ok(index.search(query, limit.clamp(1, 100)))
    }

    #[cfg(test)]
    pub fn resident_process_count(&self) -> usize {
        self.catalog.resident_process_count()
    }

    fn persist(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(&self.state)
            .map_err(|error| format!("serialize capability state: {error}"))?;
        let path = self.root.join("state.json");
        let temporary = self.root.join(".state.json.tmp");
        fs::write(&temporary, bytes).map_err(|error| format!("write capability state: {error}"))?;
        fs::rename(&temporary, &path).map_err(|error| format!("install capability state: {error}"))
    }
}

fn builtin_manifests() -> Vec<CapabilityManifest> {
    vec![
        CapabilityManifest {
            schema_version: 1,
            id: "rust-lsp".into(),
            version: "1.0.0".into(),
            summary: "Lazy scoped Rust symbols, references, types, and diagnostics".into(),
            keywords: vec!["rust".into(), "symbol".into(), "diagnostics".into()],
            scope: CapabilityScope::Global,
            activation: Activation::OnDemand,
            tier: CapabilityTier::Discoverable,
            permissions: BTreeSet::from(["workspace.read".into(), "process.exec".into()]),
            resident_cost_bytes: 0,
        },
        CapabilityManifest {
            schema_version: 1,
            id: "task-build".into(),
            version: "1.0.0".into(),
            summary: "Confirmed task-scoped Harness build and verification actions".into(),
            keywords: vec!["build".into(), "test".into(), "verify".into()],
            scope: CapabilityScope::Task,
            activation: Activation::Explicit,
            tier: CapabilityTier::Discoverable,
            permissions: BTreeSet::from(["workspace.read".into(), "process.exec".into()]),
            resident_cost_bytes: 0,
        },
        CapabilityManifest {
            schema_version: 1,
            id: "local-code-index".into(),
            version: "1.0.0".into(),
            summary: "Bounded local code and symbol search without remote vectors".into(),
            keywords: vec!["code".into(), "search".into(), "symbol".into()],
            scope: CapabilityScope::Global,
            activation: Activation::OnDemand,
            tier: CapabilityTier::Discoverable,
            permissions: BTreeSet::from(["workspace.read".into()]),
            resident_cost_bytes: 0,
        },
        CapabilityManifest {
            schema_version: 1,
            id: "persistent-eval".into(),
            version: "1.0.0".into(),
            summary:
                "Persistent Python/JavaScript evaluation kernel for bounded development checks"
                    .into(),
            keywords: vec![
                "python".into(),
                "javascript".into(),
                "eval".into(),
                "kernel".into(),
            ],
            scope: CapabilityScope::Global,
            activation: Activation::OnDemand,
            tier: CapabilityTier::Discoverable,
            permissions: BTreeSet::from(["workspace.read".into(), "process.exec".into()]),
            resident_cost_bytes: 0,
        },
        CapabilityManifest {
            schema_version: 1,
            id: "browser-automation".into(),
            version: "1.0.0".into(),
            summary: "Lazy CDP browser automation for local web smoke checks".into(),
            keywords: vec!["browser".into(), "cdp".into(), "smoke".into(), "web".into()],
            scope: CapabilityScope::Global,
            activation: Activation::OnDemand,
            tier: CapabilityTier::Discoverable,
            permissions: BTreeSet::from(["process.exec".into(), "network.local".into()]),
            resident_cost_bytes: 0,
        },
        CapabilityManifest {
            schema_version: 1,
            id: "debug-adapter".into(),
            version: "1.0.0".into(),
            summary: "Scoped DAP launch and attach diagnostics for active Harness runs".into(),
            keywords: vec![
                "dap".into(),
                "debug".into(),
                "breakpoint".into(),
                "diagnostics".into(),
            ],
            scope: CapabilityScope::Task,
            activation: Activation::Explicit,
            tier: CapabilityTier::Discoverable,
            permissions: BTreeSet::from(["workspace.read".into(), "process.exec".into()]),
            resident_cost_bytes: 0,
        },
        CapabilityManifest {
            schema_version: 1,
            id: "firstmate-crew-orchestrator".into(),
            version: "external:f0d7cbe9".into(),
            summary: "Optional external Firstmate crew orchestration in isolated worktrees".into(),
            keywords: vec![
                "firstmate".into(),
                "crew".into(),
                "worktree".into(),
                "orchestrator".into(),
            ],
            scope: CapabilityScope::Global,
            activation: Activation::Explicit,
            tier: CapabilityTier::Disabled,
            permissions: BTreeSet::from([
                "workspace.read".into(),
                "process.exec".into(),
                "git.worktree".into(),
            ]),
            resident_cost_bytes: 0,
        },
        CapabilityManifest {
            schema_version: 1,
            id: "pi-subagents-orchestration".into(),
            version: "0.37.2".into(),
            summary: "Managed chains, parallel groups, resume, acceptance, and isolated worktrees"
                .into(),
            keywords: vec![
                "subagent".into(),
                "chain".into(),
                "parallel".into(),
                "fleet".into(),
            ],
            scope: CapabilityScope::Task,
            activation: Activation::OnDemand,
            tier: CapabilityTier::Discoverable,
            permissions: BTreeSet::from(["task.control".into(), "process.exec".into()]),
            resident_cost_bytes: 0,
        },
        CapabilityManifest {
            schema_version: 1,
            id: "scheduler-monitor".into(),
            version: "1.0.0".into(),
            summary: "On-demand monitors and explicitly scheduled development work".into(),
            keywords: vec!["monitor".into(), "schedule".into(), "background".into()],
            scope: CapabilityScope::Task,
            activation: Activation::OnDemand,
            tier: CapabilityTier::Discoverable,
            permissions: BTreeSet::from(["task.control".into(), "process.exec".into()]),
            resident_cost_bytes: 0,
        },
        CapabilityManifest {
            schema_version: 1,
            id: "lifecycle-hooks".into(),
            version: "1.0.0".into(),
            summary: "Trusted command hooks for selected Agent lifecycle events".into(),
            keywords: vec!["hook".into(), "lifecycle".into(), "stop".into()],
            scope: CapabilityScope::Global,
            activation: Activation::Explicit,
            tier: CapabilityTier::Disabled,
            permissions: BTreeSet::from(["process.exec".into()]),
            resident_cost_bytes: 0,
        },
        CapabilityManifest {
            schema_version: 1,
            id: "mcp-server-host".into(),
            version: "1.0.0".into(),
            summary: "Manually imported and task-scoped MCP servers with secret references".into(),
            keywords: vec!["mcp".into(), "tools".into(), "server".into()],
            scope: CapabilityScope::Task,
            activation: Activation::Explicit,
            tier: CapabilityTier::Disabled,
            permissions: BTreeSet::from(["process.exec".into(), "network".into()]),
            resident_cost_bytes: 0,
        },
        // P5 modules are deliberately visible in Settings but disabled by
        // default. Registering their manifests does not install dependencies,
        // expose them to the Agent, or start a worker process.
        CapabilityManifest {
            schema_version: 1,
            id: "remote-control".into(),
            version: "planned:p5-02".into(),
            summary: "Opt-in phone control for local chats and Agent Runs".into(),
            keywords: vec!["phone".into(), "remote".into(), "control".into()],
            scope: CapabilityScope::Global,
            activation: Activation::Explicit,
            tier: CapabilityTier::Disabled,
            permissions: BTreeSet::from(["network.local".into(), "task.control".into()]),
            resident_cost_bytes: 0,
        },
        CapabilityManifest {
            schema_version: 1,
            id: "computer-use".into(),
            version: "planned:p5-03".into(),
            summary: "Opt-in browser and desktop visual automation".into(),
            keywords: vec!["computer".into(), "desktop".into(), "visual".into()],
            scope: CapabilityScope::Global,
            activation: Activation::Explicit,
            tier: CapabilityTier::Disabled,
            permissions: BTreeSet::from(["network.local".into(), "process.exec".into()]),
            resident_cost_bytes: 0,
        },
        CapabilityManifest {
            schema_version: 1,
            id: "collaboration-review".into(),
            version: "planned:p5-04".into(),
            summary: "Opt-in shared review and collaborator identity boundary".into(),
            keywords: vec!["collaboration".into(), "review".into(), "shared".into()],
            scope: CapabilityScope::Global,
            activation: Activation::Explicit,
            tier: CapabilityTier::Disabled,
            permissions: BTreeSet::from(["network.local".into(), "task.control".into()]),
            resident_cost_bytes: 0,
        },
        CapabilityManifest {
            schema_version: 1,
            id: "voice-image-workflows".into(),
            version: "planned:p5-05".into(),
            summary: "Opt-in local audio capture, transcription, and image input".into(),
            keywords: vec![
                "voice".into(),
                "audio".into(),
                "image".into(),
                "media".into(),
            ],
            scope: CapabilityScope::Global,
            activation: Activation::Explicit,
            tier: CapabilityTier::Disabled,
            permissions: BTreeSet::from(["media.capture".into(), "network".into()]),
            resident_cost_bytes: 0,
        },
        CapabilityManifest {
            schema_version: 1,
            id: "durable-memory".into(),
            version: "planned:p5-06".into(),
            summary: "Opt-in inspectable long-term task memory and retrieval".into(),
            keywords: vec!["memory".into(), "journal".into(), "retrieval".into()],
            scope: CapabilityScope::Global,
            activation: Activation::Explicit,
            tier: CapabilityTier::Disabled,
            permissions: BTreeSet::from(["workspace.read".into()]),
            resident_cost_bytes: 0,
        },
        CapabilityManifest {
            schema_version: 1,
            id: "remote-worker-pool".into(),
            version: "planned:p5-07".into(),
            summary: "Opt-in remote worker scheduling with capability and artifact bounds".into(),
            keywords: vec![
                "worker".into(),
                "pool".into(),
                "remote".into(),
                "scheduler".into(),
            ],
            scope: CapabilityScope::Global,
            activation: Activation::Explicit,
            tier: CapabilityTier::Disabled,
            permissions: BTreeSet::from(["network".into(), "process.exec".into()]),
            resident_cost_bytes: 0,
        },
        CapabilityManifest {
            schema_version: 1,
            id: "game-content-pipeline".into(),
            version: "planned:p5-09".into(),
            summary: "Engine content validation for references, imports, Cook, and runtime loading"
                .into(),
            keywords: vec![
                "unity".into(),
                "unreal".into(),
                "godot".into(),
                "content".into(),
                "cook".into(),
            ],
            scope: CapabilityScope::Task,
            activation: Activation::Explicit,
            tier: CapabilityTier::Disabled,
            permissions: BTreeSet::from(["workspace.read".into(), "process.exec".into()]),
            resident_cost_bytes: 0,
        },
        CapabilityManifest {
            schema_version: 1,
            id: "security-supply-chain".into(),
            version: "planned:p5-09".into(),
            summary: "Secret, dependency, license, SAST, and SBOM validation".into(),
            keywords: vec![
                "security".into(),
                "dependency".into(),
                "license".into(),
                "sbom".into(),
            ],
            scope: CapabilityScope::Task,
            activation: Activation::Explicit,
            tier: CapabilityTier::Disabled,
            permissions: BTreeSet::from([
                "workspace.read".into(),
                "process.exec".into(),
                "network".into(),
            ]),
            resident_cost_bytes: 0,
        },
    ]
}

fn discover_firstmate_root() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for key in ["FIRSTMATE_ROOT", "FM_HOME"] {
        if let Ok(value) = std::env::var(key) {
            let path = PathBuf::from(value);
            candidates.push(path.clone());
            if key == "FM_HOME" {
                candidates.push(path.join("firstmate"));
            }
        }
    }
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        let home = PathBuf::from(home);
        candidates.extend([
            home.join("firstmate"),
            home.join("src").join("firstmate"),
            home.join("Documents").join("firstmate"),
        ]);
    }
    candidates.extend([
        PathBuf::from(r"D:\firstmate"),
        PathBuf::from(r"D:\temp\firstmate"),
    ]);
    candidates
        .into_iter()
        .find(|path| path.is_dir() && path.join("AGENTS.md").is_file())
}

fn build_compact_prompt(enabled: bool, task_capabilities: &[String], state: &str) -> String {
    let mut lines = vec![
        "Picode task capabilities are lazy; do not assume optional tools are running.".to_owned(),
    ];
    if enabled {
        lines.push("Use picode_search_tools before requesting an optional capability.".to_owned());
    }
    if !task_capabilities.is_empty() {
        lines.push(format!(
            "Task-bound TOOLS.md capabilities: {}.",
            task_capabilities.join(", ")
        ));
    }
    if state.starts_with("invalid:") {
        lines.push(format!("TOOLS.md is unavailable ({state})."));
    }
    lines.join("\n")
}

fn excluded_path(path: &Path) -> bool {
    path.components().any(|component| {
        let value = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        matches!(
            value.as_str(),
            ".git" | ".env" | ".secrets" | "secrets" | "node_modules" | "target" | "dist" | "build"
        ) || value.ends_with(".pem")
            || value.ends_with(".key")
    })
}

#[cfg(test)]
pub fn encode_lsp_frame(value: &Value) -> Result<Vec<u8>, String> {
    let body = serde_json::to_vec(value).map_err(|error| format!("encode LSP payload: {error}"))?;
    let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    frame.extend_from_slice(&body);
    Ok(frame)
}

#[cfg(test)]
pub fn decode_lsp_frame(frame: &[u8], max_body_bytes: usize) -> Result<Value, String> {
    let header_end = frame
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "LSP frame header is incomplete".to_owned())?;
    let header = std::str::from_utf8(&frame[..header_end])
        .map_err(|_| "LSP frame header is not UTF-8".to_owned())?;
    let length = header
        .lines()
        .find_map(|line| line.strip_prefix("Content-Length:"))
        .ok_or_else(|| "LSP frame has no Content-Length".to_owned())?
        .trim()
        .parse::<usize>()
        .map_err(|_| "LSP Content-Length is invalid".to_owned())?;
    if length > max_body_bytes {
        return Err("LSP response exceeds configured limit".into());
    }
    let body_start = header_end + 4;
    if frame.len().saturating_sub(body_start) != length {
        return Err("LSP frame body length does not match header".into());
    }
    serde_json::from_slice(&frame[body_start..])
        .map_err(|error| format!("decode LSP payload: {error}"))
}

#[cfg(test)]
pub fn read_lsp_frame(reader: &mut impl Read, max_body_bytes: usize) -> Result<Value, String> {
    let mut header = Vec::new();
    let mut byte = [0u8; 1];
    while !header.ends_with(b"\r\n\r\n") {
        reader
            .read_exact(&mut byte)
            .map_err(|error| format!("read LSP header: {error}"))?;
        header.push(byte[0]);
        if header.len() > 8 * 1024 {
            return Err("LSP header exceeds configured limit".into());
        }
    }
    let header_text =
        std::str::from_utf8(&header).map_err(|_| "LSP frame header is not UTF-8".to_owned())?;
    let length = header_text
        .lines()
        .find_map(|line| line.strip_prefix("Content-Length:"))
        .ok_or_else(|| "LSP frame has no Content-Length".to_owned())?
        .trim()
        .parse::<usize>()
        .map_err(|_| "LSP Content-Length is invalid".to_owned())?;
    if length > max_body_bytes {
        return Err("LSP response exceeds configured limit".into());
    }
    let mut body = vec![0; length];
    reader
        .read_exact(&mut body)
        .map_err(|error| format!("read LSP body: {error}"))?;
    serde_json::from_slice(&body).map_err(|error| format!("decode LSP payload: {error}"))
}

#[cfg(test)]
pub fn write_lsp_frame(writer: &mut impl Write, value: &Value) -> Result<(), String> {
    writer
        .write_all(&encode_lsp_frame(value)?)
        .map_err(|error| format!("write LSP request: {error}"))?;
    writer
        .flush()
        .map_err(|error| format!("flush LSP request: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution::TaskKind;
    use std::fs;

    #[test]
    fn simple_tasks_require_opt_in_and_task_tools_never_leak_globally() {
        let root = std::env::temp_dir().join(format!("picode-capability-{}", uuid::Uuid::new_v4()));
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(
            workspace.join("TOOLS.md"),
            "# Tools\n```picode-tools\n{\"schemaVersion\":1,\"capabilities\":[\"task-build\"]}\n```\n",
        )
        .unwrap();

        let mut service = CapabilityService::open(&root.join("state")).unwrap();
        assert!(service
            .search("simple-a", TaskKind::Simple, "rust", 5)
            .is_err());
        service.set_catalog_opt_in("simple-a", true).unwrap();
        assert!(!service
            .search("simple-a", TaskKind::Simple, "rust", 5)
            .unwrap()
            .is_empty());

        let harness = service
            .prepare_task("harness-a", TaskKind::Harness, Some(&workspace))
            .unwrap();
        assert_eq!(harness.task_capabilities, vec!["task-build"]);
        let unrelated = service
            .prepare_task(
                "harness-b",
                TaskKind::Harness,
                Some(&workspace.join("missing")),
            )
            .unwrap();
        assert!(unrelated.task_capabilities.is_empty());
        assert_eq!(service.resident_process_count(), 0);

        let reopened = CapabilityService::open(&root.join("state")).unwrap();
        assert!(reopened
            .search("simple-a", TaskKind::Simple, "rust", 5)
            .is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_index_excludes_secrets_and_lsp_framing_is_bounded() {
        let root = std::env::temp_dir().join(format!("picode-index-{}", uuid::Uuid::new_v4()));
        let workspace = root.join("workspace");
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(workspace.join("src/main.rs"), "fn player_spawn() {}\n").unwrap();
        fs::write(workspace.join(".env"), "TOKEN=secret\n").unwrap();
        let mut service = CapabilityService::open(&root.join("state")).unwrap();
        let indexed = service.refresh_index("task-a", &workspace).unwrap();
        assert_eq!(indexed, 1);
        let matches = service.search_code("task-a", "player_spawn", 10).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].path, "src/main.rs");

        let value = serde_json::json!({"jsonrpc":"2.0","id":7,"result":{"ok":true}});
        let framed = encode_lsp_frame(&value).unwrap();
        assert_eq!(decode_lsp_frame(&framed, 1024).unwrap(), value);
        assert!(decode_lsp_frame(&framed, 4).unwrap_err().contains("limit"));
        let mut wire = Vec::new();
        write_lsp_frame(&mut wire, &value).unwrap();
        assert_eq!(
            read_lsp_frame(&mut std::io::Cursor::new(wire), 1024).unwrap(),
            value
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn disabled_modules_are_persisted_and_hidden_until_explicitly_enabled() {
        let root = std::env::temp_dir().join(format!("picode-tier-{}", uuid::Uuid::new_v4()));
        let state = root.join("state");
        let mut service = CapabilityService::open(&state).unwrap();
        assert!(service
            .search("harness-a", TaskKind::Harness, "firstmate", 5)
            .unwrap()
            .is_empty());
        assert!(service
            .snapshot()
            .capabilities
            .iter()
            .find(|capability| capability.id == "firstmate-crew-orchestrator")
            .is_some_and(|capability| capability.tier == CapabilityTier::Disabled));
        let snapshot = service.snapshot();
        let tier_by_id = snapshot
            .capabilities
            .iter()
            .map(|capability| (capability.id.as_str(), capability.tier))
            .collect::<BTreeMap<_, _>>();
        for id in [
            "remote-control",
            "computer-use",
            "collaboration-review",
            "voice-image-workflows",
            "durable-memory",
            "remote-worker-pool",
            "game-content-pipeline",
            "security-supply-chain",
        ] {
            assert_eq!(tier_by_id.get(id), Some(&CapabilityTier::Disabled), "{id}");
        }
        for id in [
            "rust-lsp",
            "task-build",
            "local-code-index",
            "persistent-eval",
            "browser-automation",
            "debug-adapter",
        ] {
            assert_eq!(
                tier_by_id.get(id),
                Some(&CapabilityTier::Discoverable),
                "{id}"
            );
        }

        service
            .set_module_tier("firstmate-crew-orchestrator", CapabilityTier::Discoverable)
            .unwrap();
        assert_eq!(
            service
                .search("harness-a", TaskKind::Harness, "firstmate", 5)
                .unwrap()[0]
                .id,
            "firstmate-crew-orchestrator"
        );

        let reopened = CapabilityService::open(&state).unwrap();
        assert!(reopened
            .snapshot()
            .capabilities
            .iter()
            .find(|capability| capability.id == "firstmate-crew-orchestrator")
            .is_some_and(|capability| capability.tier == CapabilityTier::Discoverable));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn firstmate_root_requires_agents_file_and_persists() {
        let root = std::env::temp_dir().join(format!("picode-firstmate-{}", uuid::Uuid::new_v4()));
        let state = root.join("state");
        let invalid = root.join("invalid");
        let valid = root.join("firstmate");
        fs::create_dir_all(&invalid).unwrap();
        fs::create_dir_all(&valid).unwrap();
        let mut service = CapabilityService::open(&state).unwrap();
        assert!(service.set_firstmate_root(&invalid).is_err());
        fs::write(valid.join("AGENTS.md"), "# Firstmate\n").unwrap();
        let saved = service.set_firstmate_root(&valid).unwrap();
        assert_eq!(service.firstmate_root(), Some(saved.clone()));
        let reopened = CapabilityService::open(&state).unwrap();
        assert_eq!(reopened.firstmate_root(), Some(saved));
        fs::remove_dir_all(root).unwrap();
    }
}
