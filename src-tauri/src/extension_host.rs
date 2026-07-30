// This module is the executable extension-host contract. The service consumes
// only a subset of its migration and lifecycle states in any one build.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    WorkspaceRead,
    WorkspaceWrite,
    ProcessExecute,
    Network,
    SecretUse,
    DebugAttach,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ExtensionInstall {
    pub id: String,
    pub schema_version: u32,
    pub permissions: BTreeSet<Permission>,
    pub enabled: bool,
}

impl ExtensionInstall {
    pub fn new(id: &str, schema_version: u32, permissions: BTreeSet<Permission>) -> Self {
        Self {
            id: id.into(),
            schema_version,
            permissions,
            enabled: true,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ResourceLimits {
    pub max_memory_bytes: u64,
    pub max_output_bytes: usize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ExtensionRunState {
    Starting,
    Running,
    Crashed,
    Hung,
    ResourceStopped,
    Cancelled,
    Completed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ExtensionRun {
    pub id: String,
    pub extension_id: String,
    pub task_id: String,
    pub process_id: u32,
    pub state: ExtensionRunState,
    pub output_tail: Vec<u8>,
    pub observed_memory_bytes: u64,
    pub termination_result: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ExtensionMigration {
    pub from_version: u32,
    pub to_version: u32,
    pub requested_permissions: BTreeSet<Permission>,
    pub compatible_downgrade: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MigrationFailure {
    None,
    AfterStage,
}

pub struct HeavyExtensionHost {
    limits: ResourceLimits,
    installations: BTreeMap<String, ExtensionInstall>,
    runs: BTreeMap<String, ExtensionRun>,
}

impl HeavyExtensionHost {
    pub fn new(limits: ResourceLimits) -> Self {
        Self {
            limits,
            installations: BTreeMap::new(),
            runs: BTreeMap::new(),
        }
    }
    pub fn install(&mut self, install: ExtensionInstall) -> Result<(), String> {
        if install.id.trim().is_empty() || install.schema_version == 0 {
            return Err("invalid extension installation".into());
        }
        if self.installations.contains_key(&install.id) {
            return Err("extension already installed".into());
        }
        self.installations.insert(install.id.clone(), install);
        Ok(())
    }
    pub fn installation(&self, id: &str) -> Option<&ExtensionInstall> {
        self.installations.get(id)
    }
    pub fn resident_process_count(&self) -> usize {
        self.runs
            .values()
            .filter(|run| {
                matches!(
                    run.state,
                    ExtensionRunState::Starting | ExtensionRunState::Running
                )
            })
            .count()
    }
    pub fn start(
        &mut self,
        extension_id: &str,
        task_id: &str,
        process_id: u32,
    ) -> Result<ExtensionRun, String> {
        let extension = self
            .installations
            .get(extension_id)
            .ok_or_else(|| "extension is not installed".to_owned())?;
        if !extension.enabled || process_id == 0 {
            return Err("extension cannot start".into());
        }
        let run = ExtensionRun {
            id: Uuid::new_v4().to_string(),
            extension_id: extension_id.into(),
            task_id: task_id.into(),
            process_id,
            state: ExtensionRunState::Running,
            output_tail: Vec::new(),
            observed_memory_bytes: 0,
            termination_result: None,
        };
        self.runs.insert(run.id.clone(), run.clone());
        Ok(run)
    }
    pub fn run(&self, id: &str) -> Option<&ExtensionRun> {
        self.runs.get(id)
    }
    pub fn append_output(&mut self, id: &str, output: &[u8]) -> Result<(), String> {
        let run = self
            .runs
            .get_mut(id)
            .ok_or_else(|| "extension run missing".to_owned())?;
        if run.state != ExtensionRunState::Running {
            return Err("extension run is not active".into());
        }
        run.output_tail.extend_from_slice(output);
        if run.output_tail.len() > self.limits.max_output_bytes {
            let overflow = run.output_tail.len() - self.limits.max_output_bytes;
            run.output_tail.drain(..overflow);
        }
        Ok(())
    }
    pub fn observe_memory(&mut self, id: &str, bytes: u64) -> Result<(), String> {
        let run = self
            .runs
            .get_mut(id)
            .ok_or_else(|| "extension run missing".to_owned())?;
        run.observed_memory_bytes = bytes;
        if bytes > self.limits.max_memory_bytes {
            run.state = ExtensionRunState::ResourceStopped;
            run.termination_result = Some("extension exceeded memory limit".into());
        }
        Ok(())
    }
    pub fn chat_session_healthy(&self, _task_id: &str) -> bool {
        true
    }
    pub fn migrate(
        &mut self,
        id: &str,
        migration: ExtensionMigration,
        permission_expansion_approved: bool,
        failure: MigrationFailure,
    ) -> Result<(), String> {
        let current = self
            .installations
            .get(id)
            .cloned()
            .ok_or_else(|| "extension missing".to_owned())?;
        if migration.from_version != current.schema_version
            || migration.to_version <= migration.from_version
        {
            return Err("incompatible extension migration".into());
        }
        if !migration
            .requested_permissions
            .is_subset(&current.permissions)
            && !permission_expansion_approved
        {
            return Err("extension permission expansion requires review".into());
        }
        let staged = ExtensionInstall {
            schema_version: migration.to_version,
            permissions: migration.requested_permissions,
            ..current.clone()
        };
        if failure == MigrationFailure::AfterStage {
            return Err("extension migration failed; prior installation preserved".into());
        }
        self.installations.insert(id.into(), staged);
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ExternalSource {
    Codex,
    Claude,
    Cursor,
    OpenCode,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ImportKind {
    Rule,
    Skill,
    Command,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ExternalItem {
    pub id: String,
    pub kind: ImportKind,
    pub unsupported_reason: Option<String>,
}

impl ExternalItem {
    pub fn supported(id: &str, kind: ImportKind) -> Self {
        Self {
            id: id.into(),
            kind,
            unsupported_reason: None,
        }
    }
    pub fn unsupported(id: &str, reason: &str) -> Self {
        Self {
            id: id.into(),
            kind: ImportKind::Command,
            unsupported_reason: Some(reason.into()),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ImportCandidate {
    pub id: String,
    pub kind: ImportKind,
    pub source: ExternalSource,
    pub selected: bool,
    pub unsupported_reason: Option<String>,
}

pub fn preview_external_import(
    source: ExternalSource,
    items: &[ExternalItem],
) -> Vec<ImportCandidate> {
    items
        .iter()
        .map(|item| ImportCandidate {
            id: item.id.clone(),
            kind: item.kind,
            source,
            selected: false,
            unsupported_reason: item.unsupported_reason.clone(),
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq)]
pub struct ImportedItem {
    pub id: String,
    pub kind: ImportKind,
    pub source: ExternalSource,
    pub scope: String,
    pub overrides_defaults: bool,
}

pub fn apply_external_import(
    candidates: &[ImportCandidate],
    selected_ids: &[&str],
    scope: &str,
) -> Result<Vec<ImportedItem>, String> {
    let mut imported = Vec::new();
    for id in selected_ids {
        let candidate = candidates
            .iter()
            .find(|candidate| candidate.id == *id)
            .ok_or_else(|| format!("import candidate {id} missing"))?;
        if let Some(reason) = &candidate.unsupported_reason {
            return Err(format!("unsupported import {id}: {reason}"));
        }
        imported.push(ImportedItem {
            id: candidate.id.clone(),
            kind: candidate.kind,
            source: candidate.source,
            scope: scope.into(),
            overrides_defaults: false,
        });
    }
    Ok(imported)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretRef {
    Environment(String),
    Credential(String),
    File(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpTransport {
    Stdio,
    StreamableHttp,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionScope {
    Global,
    Task(String),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub transport: McpTransport,
    pub command: String,
    pub args: Vec<String>,
    pub environment: BTreeMap<String, SecretRef>,
    pub scope: ExtensionScope,
}

#[derive(Clone, Debug, PartialEq)]
pub struct McpRun {
    pub server_id: String,
    pub task_id: String,
    pub process_id: u32,
    pub running: bool,
}

#[derive(Default)]
pub struct McpLifecycle {
    configs: BTreeMap<String, McpServerConfig>,
    runs: Vec<McpRun>,
}

impl McpLifecycle {
    pub fn import_selected(&mut self, config: McpServerConfig) -> Result<(), String> {
        if config.id.trim().is_empty() || config.command.trim().is_empty() {
            return Err("MCP id and command are required".into());
        }
        self.configs.insert(config.id.clone(), config);
        Ok(())
    }
    pub fn config(&self, id: &str) -> Option<&McpServerConfig> {
        self.configs.get(id)
    }
    pub fn running_count(&self) -> usize {
        self.runs.iter().filter(|run| run.running).count()
    }
    pub fn start(&mut self, id: &str, task_id: &str, process_id: u32) -> Result<(), String> {
        let config = self
            .configs
            .get(id)
            .ok_or_else(|| "MCP server is not imported".to_owned())?;
        if let ExtensionScope::Task(bound) = &config.scope {
            if bound != task_id {
                return Err("task-scoped MCP cannot start for another task".into());
            }
        }
        if process_id == 0 {
            return Err("MCP process id is required".into());
        }
        self.runs.push(McpRun {
            server_id: id.into(),
            task_id: task_id.into(),
            process_id,
            running: true,
        });
        Ok(())
    }
    pub fn cancel_task(&mut self, task_id: &str) {
        for run in &mut self.runs {
            if run.task_id == task_id {
                run.running = false;
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProjectAdapter {
    pub id: String,
    pub markers: Vec<String>,
    pub action_ids: Vec<String>,
    pub enabled: bool,
}

impl ProjectAdapter {
    pub fn new(id: &str, markers: &[&str], actions: &[&str]) -> Self {
        Self {
            id: id.into(),
            markers: markers.iter().map(|value| (*value).into()).collect(),
            action_ids: actions.iter().map(|value| (*value).into()).collect(),
            enabled: true,
        }
    }
}

#[derive(Default)]
pub struct AdapterRegistry {
    adapters: BTreeMap<String, ProjectAdapter>,
}

impl AdapterRegistry {
    pub fn register(&mut self, adapter: ProjectAdapter) -> Result<(), String> {
        if self.adapters.contains_key(&adapter.id) {
            return Err("adapter already registered".into());
        }
        self.adapters.insert(adapter.id.clone(), adapter);
        Ok(())
    }
    pub fn disable(&mut self, id: &str) -> Result<(), String> {
        self.adapters
            .get_mut(id)
            .ok_or_else(|| "adapter missing".to_owned())?
            .enabled = false;
        Ok(())
    }
    pub fn len(&self) -> usize {
        self.adapters.len()
    }
    pub fn active_for(&self, project_file: &str) -> Vec<String> {
        self.adapters
            .values()
            .filter(|adapter| {
                adapter.enabled
                    && adapter
                        .markers
                        .iter()
                        .any(|marker| project_file.ends_with(marker))
            })
            .map(|adapter| adapter.id.clone())
            .collect()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DapConfig {
    pub adapter: String,
    pub request: String,
    pub target: String,
}

impl DapConfig {
    pub fn launch(adapter: &str, target: &str) -> Self {
        Self {
            adapter: adapter.into(),
            request: "launch".into(),
            target: target.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DapSession {
    pub id: String,
    pub task_id: String,
    pub config: DapConfig,
    pub running: bool,
    pub events: Vec<String>,
}

#[derive(Default)]
pub struct DapManager {
    sessions: BTreeMap<String, DapSession>,
}

impl DapManager {
    pub fn running_count(&self) -> usize {
        self.sessions
            .values()
            .filter(|session| session.running)
            .count()
    }
    pub fn launch(
        &mut self,
        task_id: &str,
        config: DapConfig,
        authorized: bool,
    ) -> Result<DapSession, String> {
        if !authorized {
            return Err("DAP launch or attach requires authorization".into());
        }
        if config.adapter.trim().is_empty() || config.target.trim().is_empty() {
            return Err("DAP configuration is incomplete".into());
        }
        let session = DapSession {
            id: Uuid::new_v4().to_string(),
            task_id: task_id.into(),
            config,
            running: true,
            events: Vec::new(),
        };
        self.sessions.insert(session.id.clone(), session.clone());
        Ok(session)
    }
    pub fn record_event(&mut self, id: &str, event: &str, max_events: usize) -> Result<(), String> {
        let session = self
            .sessions
            .get_mut(id)
            .ok_or_else(|| "DAP session missing".to_owned())?;
        session.events.push(event.into());
        if session.events.len() > max_events {
            let overflow = session.events.len() - max_events;
            session.events.drain(..overflow);
        }
        Ok(())
    }
    pub fn stop_task(&mut self, task_id: &str) {
        for session in self.sessions.values_mut() {
            if session.task_id == task_id {
                session.running = false;
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum FindingKind {
    Deterministic,
    ModelOpinion,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Finding {
    pub source: String,
    pub path: String,
    pub version: String,
    pub line: usize,
    pub severity: Severity,
    pub message: String,
    pub kind: FindingKind,
}

impl Finding {
    pub fn deterministic(
        source: &str,
        path: &str,
        version: &str,
        line: usize,
        severity: Severity,
        message: &str,
    ) -> Self {
        Self {
            source: source.into(),
            path: path.into(),
            version: version.into(),
            line,
            severity,
            message: message.into(),
            kind: FindingKind::Deterministic,
        }
    }
    pub fn model_opinion(
        source: &str,
        path: &str,
        version: &str,
        line: usize,
        message: &str,
    ) -> Self {
        Self {
            source: source.into(),
            path: path.into(),
            version: version.into(),
            line,
            severity: Severity::Info,
            message: message.into(),
            kind: FindingKind::ModelOpinion,
        }
    }
}

#[derive(Default)]
pub struct DiagnosticStore {
    findings: BTreeSet<Finding>,
}

impl DiagnosticStore {
    pub fn add(&mut self, finding: Finding) -> Result<(), String> {
        if finding.path.trim().is_empty()
            || finding.version.trim().is_empty()
            || finding.message.trim().is_empty()
        {
            return Err("diagnostic finding is incomplete".into());
        }
        self.findings.insert(finding);
        Ok(())
    }
    pub fn for_version(&self, path: &str, version: &str) -> Vec<&Finding> {
        self.findings
            .iter()
            .filter(|finding| finding.path == path && finding.version == version)
            .collect()
    }
    pub fn can_mark_harness_complete(&self) -> bool {
        false
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AdvisoryRequest {
    pub role: String,
    pub model: String,
    pub context_bytes: usize,
    pub cost_limit_micros: u64,
    pub allowed_tools: BTreeSet<String>,
    pub output_is_evidence: bool,
}

impl AdvisoryRequest {
    pub fn new(
        role: &str,
        model: &str,
        context_bytes: usize,
        cost_limit_micros: u64,
        tools: &[&str],
    ) -> Result<Self, String> {
        let allowed_tools: BTreeSet<String> = tools.iter().map(|tool| (*tool).to_owned()).collect();
        if allowed_tools
            .iter()
            .any(|tool| matches!(tool.as_str(), "write" | "edit" | "execute"))
        {
            return Err("advisers cannot receive write or execute authority".into());
        }
        Ok(Self {
            role: role.into(),
            model: model.into(),
            context_bytes,
            cost_limit_micros,
            allowed_tools,
            output_is_evidence: false,
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RegressionScenario {
    pub id: String,
    pub version: u32,
    pub fixture_hash: String,
    pub environment: String,
}

impl RegressionScenario {
    pub fn new(id: &str, version: u32, fixture_hash: &str, environment: &str) -> Self {
        Self {
            id: id.into(),
            version,
            fixture_hash: fixture_hash.into(),
            environment: environment.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RegressionMetrics {
    pub success: bool,
    pub edit_retries: u32,
    pub verification_accuracy: f32,
    pub routing_accuracy: f32,
    pub tokens: u64,
    pub cost_micros: u64,
    pub startup_ms: i64,
    pub interaction_ms: u64,
    pub idle_memory_bytes: u64,
    pub peak_memory_bytes: u64,
    pub false_stalls: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RegressionRun {
    pub scenario: RegressionScenario,
    pub picode_version: String,
    pub model: String,
    pub metrics: RegressionMetrics,
    pub artifact_id: String,
}

impl RegressionRun {
    pub fn record(
        scenario: &RegressionScenario,
        picode_version: &str,
        model: &str,
        metrics: RegressionMetrics,
    ) -> Self {
        Self {
            scenario: scenario.clone(),
            picode_version: picode_version.into(),
            model: model.into(),
            metrics,
            artifact_id: format!(
                "regression:{}:{}:{}",
                scenario.id, scenario.version, picode_version
            ),
        }
    }
    pub fn comparable_with(&self, other: &Self) -> bool {
        self.scenario.id == other.scenario.id
            && self.scenario.version == other.scenario.version
            && self.scenario.fixture_hash == other.scenario.fixture_hash
            && self.scenario.environment == other.scenario.environment
            && self.model == other.model
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RegressionComparison {
    pub startup_delta_ms: i64,
    pub idle_memory_delta_bytes: i128,
    pub token_delta: i128,
}

pub fn compare_runs(
    before: &RegressionRun,
    after: &RegressionRun,
) -> Result<RegressionComparison, String> {
    if !before.comparable_with(after) {
        return Err("regression runs use incompatible scenarios or environments".into());
    }
    Ok(RegressionComparison {
        startup_delta_ms: after.metrics.startup_ms - before.metrics.startup_ms,
        idle_memory_delta_bytes: after.metrics.idle_memory_bytes as i128
            - before.metrics.idle_memory_bytes as i128,
        token_delta: after.metrics.tokens as i128 - before.metrics.tokens as i128,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet};

    #[test]
    fn heavy_extensions_are_explicit_isolated_bounded_and_migrated_transactionally() {
        let mut host = HeavyExtensionHost::new(ResourceLimits {
            max_memory_bytes: 256,
            max_output_bytes: 12,
        });
        host.install(ExtensionInstall::new(
            "review",
            1,
            BTreeSet::from([Permission::WorkspaceRead]),
        ))
        .unwrap();
        assert_eq!(host.resident_process_count(), 0);
        let run = host.start("review", "task-a", 4_200).unwrap();
        host.append_output(&run.id, b"abcdefghijklmnopqrstuvwxyz")
            .unwrap();
        assert_eq!(host.run(&run.id).unwrap().output_tail, b"opqrstuvwxyz");
        host.observe_memory(&run.id, 300).unwrap();
        assert_eq!(
            host.run(&run.id).unwrap().state,
            ExtensionRunState::ResourceStopped
        );
        assert!(host.chat_session_healthy("task-a"));

        let before = host.installation("review").unwrap().clone();
        let migration = ExtensionMigration {
            from_version: 1,
            to_version: 2,
            requested_permissions: BTreeSet::from([
                Permission::WorkspaceRead,
                Permission::WorkspaceWrite,
            ]),
            compatible_downgrade: false,
        };
        assert!(host
            .migrate("review", migration, false, MigrationFailure::None)
            .is_err());
        assert_eq!(host.installation("review").unwrap(), &before);
        let failed = ExtensionMigration {
            from_version: 1,
            to_version: 2,
            requested_permissions: before.permissions.clone(),
            compatible_downgrade: false,
        };
        assert!(host
            .migrate("review", failed, true, MigrationFailure::AfterStage)
            .is_err());
        assert_eq!(host.installation("review").unwrap(), &before);
    }

    #[test]
    fn external_import_and_mcp_are_manual_selective_scoped_and_secret_safe() {
        let candidates = preview_external_import(
            ExternalSource::Codex,
            &[
                ExternalItem::supported("rules/a.md", ImportKind::Rule),
                ExternalItem::unsupported("commands/x", "shell interpolation"),
            ],
        );
        assert_eq!(candidates.len(), 2);
        assert!(!candidates[0].selected);
        assert!(candidates[1].unsupported_reason.is_some());
        let imported = apply_external_import(&candidates, &["rules/a.md"], "task-a").unwrap();
        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].scope, "task-a");
        assert!(!imported[0].overrides_defaults);

        let mut mcp = McpLifecycle::default();
        let server = McpServerConfig {
            id: "memory".to_owned(),
            transport: McpTransport::Stdio,
            command: "memory-server".to_owned(),
            args: vec![],
            environment: BTreeMap::from([(
                "API_KEY".to_owned(),
                SecretRef::Environment("MEMORY_KEY".to_owned()),
            )]),
            scope: ExtensionScope::Task("task-a".to_owned()),
        };
        mcp.import_selected(server).unwrap();
        assert_eq!(mcp.running_count(), 0);
        mcp.start("memory", "task-a", 5_000).unwrap();
        assert_eq!(mcp.running_count(), 1);
        mcp.cancel_task("task-a");
        assert_eq!(mcp.running_count(), 0);
        assert!(!serde_json::to_string(mcp.config("memory").unwrap())
            .unwrap()
            .contains("secret-value"));
    }

    #[test]
    fn adapters_dap_diagnostics_and_advisers_cannot_claim_completion_or_write() {
        let mut adapters = AdapterRegistry::default();
        adapters
            .register(ProjectAdapter::new("unity", &[".unity"], &["unity.test"]))
            .unwrap();
        adapters
            .register(ProjectAdapter::new(
                "rust",
                &["Cargo.toml"],
                &["cargo.test"],
            ))
            .unwrap();
        assert_eq!(adapters.len(), 2);
        adapters.disable("unity").unwrap();
        assert_eq!(adapters.active_for("Cargo.toml"), vec!["rust"]);

        let mut dap = DapManager::default();
        assert_eq!(dap.running_count(), 0);
        let session = dap
            .launch("task-a", DapConfig::launch("coreclr", "game.exe"), true)
            .unwrap();
        dap.record_event(&session.id, "stopped", 8).unwrap();
        dap.stop_task("task-a");
        assert_eq!(dap.running_count(), 0);

        let mut diagnostics = DiagnosticStore::default();
        diagnostics
            .add(Finding::deterministic(
                "rust",
                "src/lib.rs",
                "v1",
                4,
                Severity::Error,
                "E1",
            ))
            .unwrap();
        diagnostics
            .add(Finding::deterministic(
                "rust",
                "src/lib.rs",
                "v1",
                4,
                Severity::Error,
                "E1",
            ))
            .unwrap();
        diagnostics
            .add(Finding::model_opinion(
                "adviser",
                "src/lib.rs",
                "v1",
                4,
                "consider renaming",
            ))
            .unwrap();
        assert_eq!(diagnostics.for_version("src/lib.rs", "v1").len(), 2);
        assert!(diagnostics.for_version("src/lib.rs", "v2").is_empty());
        assert!(!diagnostics.can_mark_harness_complete());

        let advisory = AdvisoryRequest::new(
            "security reviewer",
            "model-b",
            2_000,
            12,
            &["read", "search"],
        )
        .unwrap();
        assert!(!advisory.allowed_tools.contains("write"));
        assert!(!advisory.output_is_evidence);
    }

    #[test]
    fn regression_runs_are_reproducible_and_environment_comparable() {
        let scenario = RegressionScenario::new("search-small", 1, "fixture:abc", "windows-x64");
        let first = RegressionRun::record(
            &scenario,
            "picode-1",
            "model-a",
            RegressionMetrics {
                success: true,
                edit_retries: 0,
                verification_accuracy: 1.0,
                routing_accuracy: 1.0,
                tokens: 100,
                cost_micros: 20,
                startup_ms: 400,
                interaction_ms: 30,
                idle_memory_bytes: 80,
                peak_memory_bytes: 120,
                false_stalls: 0,
            },
        );
        let second = RegressionRun::record(
            &scenario,
            "picode-2",
            "model-a",
            RegressionMetrics {
                startup_ms: 350,
                ..first.metrics.clone()
            },
        );
        assert!(first.comparable_with(&second));
        assert_eq!(compare_runs(&first, &second).unwrap().startup_delta_ms, -50);
        let incompatible = RegressionScenario::new("search-small", 1, "fixture:abc", "linux-x64");
        let third =
            RegressionRun::record(&incompatible, "picode-2", "model-a", second.metrics.clone());
        assert!(!first.comparable_with(&third));
    }
}
