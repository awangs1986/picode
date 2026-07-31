// This module is the executable capability contract. Some states are retained
// for schema compatibility and are exercised only by higher-level services.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResidentCore {
    pub capabilities: BTreeSet<String>,
}

impl ResidentCore {
    pub fn required() -> Self {
        Self {
            capabilities: BTreeSet::from([
                "conversation".to_owned(),
                "task-control".to_owned(),
                "authorization".to_owned(),
                "filesystem-read".to_owned(),
                "filesystem-write".to_owned(),
                "process-exec".to_owned(),
                "runtime-registry".to_owned(),
            ]),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityScope {
    Global,
    Task,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Activation {
    OnDemand,
    Explicit,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityTier {
    Resident,
    Discoverable,
    Disabled,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityManifest {
    pub schema_version: u32,
    pub id: String,
    pub version: String,
    pub summary: String,
    #[serde(default)]
    pub keywords: Vec<String>,
    pub scope: CapabilityScope,
    pub activation: Activation,
    pub tier: CapabilityTier,
    #[serde(default)]
    pub permissions: BTreeSet<String>,
    pub resident_cost_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogEntry {
    manifest: CapabilityManifest,
    loaded: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySearchResult {
    pub id: String,
    pub summary: String,
    pub score: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySummary {
    pub id: String,
    pub version: String,
    pub summary: String,
    pub keywords: Vec<String>,
    pub scope: CapabilityScope,
    pub activation: Activation,
    pub tier: CapabilityTier,
    pub permissions: BTreeSet<String>,
    pub loaded: bool,
}

#[derive(Clone, Debug)]
pub struct CapabilityCatalog {
    pub resident_core: ResidentCore,
    entries: BTreeMap<String, CatalogEntry>,
    task_bindings: BTreeMap<String, Vec<String>>,
}

impl CapabilityCatalog {
    pub fn new(resident_core: ResidentCore) -> Self {
        Self {
            resident_core,
            entries: BTreeMap::new(),
            task_bindings: BTreeMap::new(),
        }
    }
    pub fn register(&mut self, manifest: CapabilityManifest) -> Result<(), String> {
        if manifest.schema_version != 1
            || manifest.id.trim().is_empty()
            || manifest.version.trim().is_empty()
        {
            return Err("invalid capability manifest".into());
        }
        if manifest.resident_cost_bytes != 0 && manifest.activation == Activation::OnDemand {
            return Err("on-demand capability must not claim resident cost while unloaded".into());
        }
        if self.entries.contains_key(&manifest.id) {
            return Err("capability already registered".into());
        }
        self.entries.insert(
            manifest.id.clone(),
            CatalogEntry {
                manifest,
                loaded: false,
            },
        );
        Ok(())
    }
    pub fn search_tools(&self, query: &str, limit: usize) -> Vec<CapabilitySearchResult> {
        let terms: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
        let mut results: Vec<_> = self
            .entries
            .values()
            .filter_map(|entry| {
                if entry.manifest.tier == CapabilityTier::Disabled {
                    return None;
                }
                let id = entry.manifest.id.to_lowercase();
                let summary = entry.manifest.summary.to_lowercase();
                let keywords = entry.manifest.keywords.join(" ").to_lowercase();
                let score = terms
                    .iter()
                    .map(|term| {
                        if id == *term {
                            10
                        } else if id.contains(term) {
                            6
                        } else if keywords.contains(term) {
                            4
                        } else if summary.contains(term) {
                            2
                        } else {
                            0
                        }
                    })
                    .sum::<u32>();
                (score > 0).then(|| CapabilitySearchResult {
                    id: entry.manifest.id.clone(),
                    summary: entry.manifest.summary.clone(),
                    score,
                })
            })
            .collect();
        results.sort_by(|left, right| {
            right
                .score
                .cmp(&left.score)
                .then_with(|| left.id.cmp(&right.id))
        });
        results.truncate(limit);
        results
    }
    pub fn relevance_hints(&self, keywords: &[&str], limit: usize) -> Vec<String> {
        let query = keywords.join(" ");
        self.search_tools(&query, self.entries.len())
            .into_iter()
            .filter(|result| {
                self.entries
                    .get(&result.id)
                    .is_some_and(|entry| entry.manifest.scope == CapabilityScope::Global)
            })
            .take(limit.min(5))
            .map(|result| result.id)
            .collect()
    }
    pub fn bind_task(
        &mut self,
        task_id: &str,
        declarations: &ToolsDeclaration,
    ) -> Result<(), String> {
        let mut capabilities = declarations.capabilities.clone();
        capabilities.sort();
        capabilities.dedup();
        for capability in &capabilities {
            let entry = self
                .entries
                .get(capability)
                .ok_or_else(|| format!("declared capability {capability} is missing"))?;
            if entry.manifest.scope != CapabilityScope::Task {
                return Err(format!("{capability} is not task scoped"));
            }
        }
        self.task_bindings.insert(task_id.to_owned(), capabilities);
        Ok(())
    }
    pub fn task_capabilities(&self, task_id: &str) -> Vec<String> {
        self.task_bindings.get(task_id).cloned().unwrap_or_default()
    }
    pub fn summaries(&self) -> Vec<CapabilitySummary> {
        self.entries
            .values()
            .map(|entry| CapabilitySummary {
                id: entry.manifest.id.clone(),
                version: entry.manifest.version.clone(),
                summary: entry.manifest.summary.clone(),
                keywords: entry.manifest.keywords.clone(),
                scope: entry.manifest.scope,
                activation: entry.manifest.activation,
                tier: entry.manifest.tier,
                permissions: entry.manifest.permissions.clone(),
                loaded: entry.loaded,
            })
            .collect()
    }
    pub fn load(&mut self, id: &str) -> Result<(), String> {
        let entry = self
            .entries
            .get_mut(id)
            .ok_or_else(|| "capability missing".to_owned())?;
        if entry.manifest.tier == CapabilityTier::Disabled {
            return Err("disabled capability must be enabled in Settings before loading".into());
        }
        entry.loaded = true;
        Ok(())
    }
    pub fn unload(&mut self, id: &str) -> Result<(), String> {
        self.entries
            .get_mut(id)
            .ok_or_else(|| "capability missing".to_owned())?
            .loaded = false;
        Ok(())
    }
    pub fn resident_process_count(&self) -> usize {
        self.entries.values().filter(|entry| entry.loaded).count()
    }

    pub fn set_tier(&mut self, id: &str, tier: CapabilityTier) -> Result<(), String> {
        let entry = self
            .entries
            .get_mut(id)
            .ok_or_else(|| "capability missing".to_owned())?;
        if tier == CapabilityTier::Disabled {
            entry.loaded = false;
        }
        entry.manifest.tier = tier;
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolsDeclaration {
    pub schema_version: u32,
    pub capabilities: Vec<String>,
}

pub fn parse_tools_md(markdown: &str) -> Result<ToolsDeclaration, String> {
    let opening = "```picode-tools";
    let start = markdown
        .find(opening)
        .ok_or_else(|| "TOOLS.md is missing picode-tools declaration".to_owned())?
        + opening.len();
    let remainder = &markdown[start..];
    let end = remainder
        .find("```")
        .ok_or_else(|| "TOOLS.md declaration is not closed".to_owned())?;
    let declaration: ToolsDeclaration = serde_json::from_str(remainder[..end].trim())
        .map_err(|error| format!("invalid TOOLS.md declaration: {error}"))?;
    if declaration.schema_version != 1 {
        return Err("unsupported TOOLS.md declaration schema".into());
    }
    if declaration
        .capabilities
        .iter()
        .any(|id| id.trim().is_empty())
    {
        return Err("empty capability id in TOOLS.md".into());
    }
    Ok(declaration)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SkillStatus {
    Installed,
    Discovered,
    Suggested,
    ExplicitlyInvoked,
    Active,
    Expired,
    Conflicting,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SkillProvenance {
    pub source: String,
    pub scope: Option<String>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SkillTaskOverride {
    pub task_id: String,
    pub visible: bool,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SkillState {
    pub id: String,
    pub status: SkillStatus,
    pub provenance: SkillProvenance,
    pub task_override: Option<SkillTaskOverride>,
}

impl SkillState {
    pub fn new(id: &str, source: &str, status: SkillStatus) -> Self {
        Self {
            id: id.into(),
            status,
            provenance: SkillProvenance {
                source: source.into(),
                scope: None,
                reason: None,
            },
            task_override: None,
        }
    }
    pub fn invoke(&mut self, task_id: &str, reason: &str) -> Result<(), String> {
        if task_id.trim().is_empty() || reason.trim().is_empty() {
            return Err("Skill invocation requires task and reason".into());
        }
        self.status = SkillStatus::ExplicitlyInvoked;
        self.provenance.scope = Some(task_id.into());
        self.provenance.reason = Some(reason.into());
        self.task_override = Some(SkillTaskOverride {
            task_id: task_id.into(),
            visible: true,
            reason: reason.into(),
        });
        Ok(())
    }
    pub fn expire(&mut self, task_id: &str) -> Result<(), String> {
        if self.provenance.scope.as_deref() != Some(task_id) {
            return Err("Skill is not active for task".into());
        }
        self.status = SkillStatus::Expired;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug)]
pub struct IndexLimits {
    pub max_files: usize,
    pub max_bytes_per_file: usize,
}

#[derive(Clone, Debug)]
struct IndexedFile {
    content: String,
    version: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexMatch {
    pub path: String,
    pub line: usize,
    pub preview: String,
    pub version: String,
}

pub struct LocalCodeIndex {
    limits: IndexLimits,
    files: BTreeMap<String, IndexedFile>,
}

impl LocalCodeIndex {
    pub fn new(limits: IndexLimits) -> Self {
        Self {
            limits,
            files: BTreeMap::new(),
        }
    }
    pub fn update(
        &mut self,
        path: &str,
        content: &[u8],
        version: &str,
        excluded_or_secret: bool,
    ) -> Result<(), String> {
        if excluded_or_secret {
            return Err("excluded or sensitive path cannot be indexed".into());
        }
        if content.len() > self.limits.max_bytes_per_file {
            return Err("file exceeds local index bound".into());
        }
        if !self.files.contains_key(path) && self.files.len() >= self.limits.max_files {
            return Err("local index file limit reached".into());
        }
        let content = String::from_utf8(content.to_vec())
            .map_err(|_| "local index accepts UTF-8 text only".to_owned())?;
        self.files.insert(
            path.replace('\\', "/"),
            IndexedFile {
                content,
                version: version.into(),
            },
        );
        Ok(())
    }
    pub fn remove(&mut self, path: &str) {
        self.files.remove(&path.replace('\\', "/"));
    }
    pub fn search(&self, query: &str, limit: usize) -> Vec<IndexMatch> {
        let mut matches = Vec::new();
        for (path, file) in &self.files {
            for (line, text) in file.content.lines().enumerate() {
                if text.contains(query) {
                    matches.push(IndexMatch {
                        path: path.clone(),
                        line: line + 1,
                        preview: text.chars().take(160).collect(),
                        version: file.version.clone(),
                    });
                }
            }
        }
        matches.truncate(limit);
        matches
    }
}

#[derive(Clone, Debug)]
struct LspSession {
    id: String,
    task_id: String,
    language: String,
    scope: String,
    last_active: u64,
    running: bool,
    diagnostics: BTreeMap<String, VersionedDiagnostics>,
}

#[derive(Clone, Debug)]
struct VersionedDiagnostics {
    version: String,
    items: Vec<String>,
}

#[derive(Default)]
pub struct LazyLspManager {
    sessions: BTreeMap<String, LspSession>,
}

impl LazyLspManager {
    pub fn start_for_scope(
        &mut self,
        task_id: &str,
        language: &str,
        scope: &str,
        at: u64,
    ) -> Result<String, String> {
        if [task_id, language, scope]
            .iter()
            .any(|value| value.trim().is_empty())
        {
            return Err("LSP task, language, and scope are required".into());
        }
        let id = Uuid::new_v4().to_string();
        self.sessions.insert(
            id.clone(),
            LspSession {
                id: id.clone(),
                task_id: task_id.into(),
                language: language.into(),
                scope: scope.into(),
                last_active: at,
                running: true,
                diagnostics: BTreeMap::new(),
            },
        );
        Ok(id)
    }
    pub fn running_count(&self) -> usize {
        self.sessions
            .values()
            .filter(|session| session.running)
            .count()
    }
    pub fn record_diagnostics(
        &mut self,
        session_id: &str,
        path: &str,
        version: &str,
        items: Vec<String>,
    ) -> Result<(), String> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| "LSP session missing".to_owned())?;
        if !session.running {
            return Err("LSP session is stopped".into());
        }
        session.diagnostics.insert(
            path.replace('\\', "/"),
            VersionedDiagnostics {
                version: version.into(),
                items,
            },
        );
        Ok(())
    }
    pub fn diagnostics(
        &self,
        session_id: &str,
        path: &str,
        version: &str,
    ) -> Result<&[String], String> {
        let diagnostics = self
            .sessions
            .get(session_id)
            .and_then(|session| session.diagnostics.get(&path.replace('\\', "/")))
            .ok_or_else(|| "LSP diagnostics missing".to_owned())?;
        if diagnostics.version != version {
            return Err("LSP diagnostics are stale for this file version".into());
        }
        Ok(&diagnostics.items)
    }
    pub fn stop_idle(&mut self, now: u64, idle_timeout: u64) {
        for session in self.sessions.values_mut() {
            if now.saturating_sub(session.last_active) >= idle_timeout {
                session.running = false;
            }
        }
    }

    pub fn stop(&mut self, session_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| "LSP session missing".to_owned())?;
        session.running = false;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct BoundedModelView {
    pub preview: String,
    pub truncated: bool,
    pub full_content_hash: String,
    pub original_bytes: usize,
}

pub fn bounded_model_view(content: &[u8], limit: usize) -> BoundedModelView {
    let visible = content.len().min(limit);
    BoundedModelView {
        preview: String::from_utf8_lossy(&content[..visible]).into_owned(),
        truncated: content.len() > visible,
        full_content_hash: Sha256::digest(content)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        original_bytes: content.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn manifest(id: &str, summary: &str, scope: CapabilityScope) -> CapabilityManifest {
        CapabilityManifest {
            schema_version: 1,
            id: id.to_owned(),
            version: "1.0.0".to_owned(),
            summary: summary.to_owned(),
            keywords: vec!["rust".to_owned(), "symbol".to_owned()],
            scope,
            activation: Activation::OnDemand,
            tier: CapabilityTier::Discoverable,
            permissions: BTreeSet::from(["workspace.read".to_owned()]),
            resident_cost_bytes: 0,
        }
    }

    #[test]
    fn catalog_search_hints_and_task_declarations_are_lazy_and_scoped() {
        let mut catalog = CapabilityCatalog::new(ResidentCore::required());
        catalog
            .register(manifest(
                "rust-lsp",
                "Rust symbols and diagnostics",
                CapabilityScope::Global,
            ))
            .unwrap();
        catalog
            .register(manifest(
                "task-build",
                "Project build actions",
                CapabilityScope::Task,
            ))
            .unwrap();
        assert_eq!(catalog.resident_process_count(), 0);
        assert_eq!(catalog.search_tools("rust symbol", 3)[0].id, "rust-lsp");
        assert_eq!(catalog.relevance_hints(&["rust"], 1), vec!["rust-lsp"]);

        let declarations = parse_tools_md(
            "# Tools\n```picode-tools\n{\"schemaVersion\":1,\"capabilities\":[\"task-build\"]}\n```",
        )
        .unwrap();
        catalog.bind_task("task-a", &declarations).unwrap();
        assert_eq!(catalog.task_capabilities("task-a"), vec!["task-build"]);
        assert!(catalog.task_capabilities("new-simple-task").is_empty());
        catalog.load("rust-lsp").unwrap();
        assert_eq!(catalog.resident_process_count(), 1);
        catalog.unload("rust-lsp").unwrap();
        assert_eq!(catalog.resident_process_count(), 0);
    }

    #[test]
    fn invoked_skill_wins_workflow_only_with_visible_override() {
        let mut state = SkillState::new("user-tdd", "C:/skills/tdd", SkillStatus::Installed);
        state.invoke("task-a", "user explicit request").unwrap();
        assert_eq!(state.status, SkillStatus::ExplicitlyInvoked);
        assert_eq!(state.provenance.scope.as_deref(), Some("task-a"));
        assert!(state.task_override.as_ref().unwrap().visible);
        state.expire("task-a").unwrap();
        assert_eq!(state.status, SkillStatus::Expired);
    }

    #[test]
    fn code_index_lsp_and_model_views_stay_bounded_and_versioned() {
        let mut index = LocalCodeIndex::new(IndexLimits {
            max_files: 2,
            max_bytes_per_file: 64,
        });
        index
            .update("src/lib.rs", b"pub fn alpha() {}", "v1", false)
            .unwrap();
        index
            .update("src/main.rs", b"fn main() { alpha(); }", "v1", false)
            .unwrap();
        assert!(index.update(".env", b"TOKEN=secret", "v1", true).is_err());
        assert_eq!(index.search("alpha", 5).len(), 2);
        index.remove("src/lib.rs");
        assert_eq!(index.search("pub fn alpha", 5).len(), 0);

        let mut lsp = LazyLspManager::default();
        assert_eq!(lsp.running_count(), 0);
        let session = lsp.start_for_scope("task-a", "rust", "src", 100).unwrap();
        lsp.record_diagnostics(
            &session,
            "src/main.rs",
            "v1",
            vec!["missing semicolon".to_owned()],
        )
        .unwrap();
        assert!(lsp.diagnostics(&session, "src/main.rs", "v2").is_err());
        lsp.stop_idle(1_000, 500);
        assert_eq!(lsp.running_count(), 0);

        let bounded = bounded_model_view(b"0123456789abcdefghij", 8);
        assert_eq!(bounded.preview, "01234567");
        assert!(bounded.truncated);
        assert_eq!(bounded.full_content_hash.len(), 64);
    }
}
