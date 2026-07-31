// This module is the executable Harness contract. Terminal and cross-platform
// variants remain part of the persisted schema even when not built locally.
#![allow(dead_code)]

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Instant;
use tokio::process::Command;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HarnessProfile {
    pub schema_version: u32,
    #[serde(default)]
    pub actions: Vec<HarnessAction>,
    #[serde(default)]
    pub gates: Vec<CompletionGate>,
    #[serde(default)]
    pub slots: Vec<LocalSlot>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HarnessAction {
    pub id: String,
    pub kind: ActionKind,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub parameters: Vec<String>,
    pub cwd: String,
    pub timeout_ms: u64,
    pub risk: ActionRisk,
    #[serde(default)]
    pub depends_on: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActionKind {
    Exec,
    Shell,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActionRisk {
    ReadOnly,
    Write,
    Destructive,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompletionGate {
    pub id: String,
    pub action_id: String,
    #[serde(default)]
    pub path_prefixes: Vec<String>,
    #[serde(default)]
    pub red_probe_action_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalSlot {
    pub id: String,
    pub required: bool,
    pub secret: bool,
}

impl HarnessProfile {
    pub fn parse_jsonc(source: &str) -> Result<Self, String> {
        let json = strip_jsonc(source)?;
        let profile: Self = serde_json::from_str(&json)
            .map_err(|error| format!("invalid Harness Profile JSONC: {error}"))?;
        profile.validate()?;
        Ok(profile)
    }

    fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err(format!(
                "unsupported Harness Profile schema {}",
                self.schema_version
            ));
        }
        let action_ids: BTreeSet<&str> = self
            .actions
            .iter()
            .map(|action| action.id.as_str())
            .collect();
        if action_ids.len() != self.actions.len() {
            return Err("Harness Action ids must be unique".into());
        }
        for action in &self.actions {
            if action.id.trim().is_empty()
                || action.program.trim().is_empty()
                || action.timeout_ms == 0
            {
                return Err("Harness Actions require id, program, and non-zero timeout".into());
            }
            if !is_portable_relative(&action.cwd) {
                return Err(format!(
                    "action {} cwd must be a portable relative path",
                    action.id
                ));
            }
            for dependency in &action.depends_on {
                if !action_ids.contains(dependency.as_str()) {
                    return Err(format!(
                        "action {} has missing dependency {dependency}",
                        action.id
                    ));
                }
            }
        }
        for id in &action_ids {
            ensure_acyclic(
                id,
                &self.actions,
                &mut BTreeSet::new(),
                &mut BTreeSet::new(),
            )?;
        }
        for gate in &self.gates {
            if !action_ids.contains(gate.action_id.as_str()) {
                return Err(format!("gate {} references missing action", gate.id));
            }
            if let Some(probe) = &gate.red_probe_action_id {
                if !action_ids.contains(probe.as_str()) {
                    return Err(format!("gate {} references missing red probe", gate.id));
                }
            }
        }
        Ok(())
    }

    pub fn select_gates(&self, changed_paths: &[String]) -> GateSelection {
        let mut gate_ids = Vec::new();
        let mut rationale = Vec::new();
        for gate in &self.gates {
            for path in changed_paths {
                let normalized = path.replace('\\', "/");
                if gate
                    .path_prefixes
                    .iter()
                    .any(|prefix| normalized.starts_with(prefix))
                {
                    if !gate_ids.contains(&gate.id) {
                        gate_ids.push(gate.id.clone());
                        rationale.push(format!("{} selected by {normalized}", gate.id));
                    }
                    break;
                }
            }
        }
        GateSelection {
            gate_ids,
            rationale,
        }
    }
}

fn ensure_acyclic<'a>(
    id: &'a str,
    actions: &'a [HarnessAction],
    visiting: &mut BTreeSet<&'a str>,
    visited: &mut BTreeSet<&'a str>,
) -> Result<(), String> {
    if visited.contains(id) {
        return Ok(());
    }
    if !visiting.insert(id) {
        return Err(format!("Harness Action dependency cycle at {id}"));
    }
    let action = actions
        .iter()
        .find(|action| action.id == id)
        .expect("validated action id");
    for dependency in &action.depends_on {
        ensure_acyclic(dependency, actions, visiting, visited)?;
    }
    visiting.remove(id);
    visited.insert(id);
    Ok(())
}

fn is_portable_relative(path: &str) -> bool {
    let trimmed = path.trim();
    !trimmed.is_empty()
        && !trimmed.starts_with('/')
        && !trimmed.starts_with('\\')
        && !(trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':')
        && !trimmed.split(['/', '\\']).any(|part| part == "..")
}

fn strip_jsonc(source: &str) -> Result<String, String> {
    let mut output = String::with_capacity(source.len());
    let mut chars = source.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;
    while let Some(ch) = chars.next() {
        if in_string {
            output.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            output.push(ch);
        } else if ch == '/' && chars.peek() == Some(&'/') {
            chars.next();
            for next in chars.by_ref() {
                if next == '\n' {
                    output.push('\n');
                    break;
                }
            }
        } else if ch == '/' && chars.peek() == Some(&'*') {
            chars.next();
            let mut closed = false;
            while let Some(next) = chars.next() {
                if next == '*' && chars.peek() == Some(&'/') {
                    chars.next();
                    closed = true;
                    break;
                }
            }
            if !closed {
                return Err("unterminated JSONC block comment".into());
            }
        } else {
            output.push(ch);
        }
    }
    if in_string {
        return Err("unterminated JSON string".into());
    }
    Ok(output)
}

#[derive(Clone, Debug, PartialEq)]
pub struct HarnessTemplate {
    pub version: String,
    pub actions: Vec<HarnessAction>,
}

impl HarnessTemplate {
    pub fn builtin_v1() -> Self {
        Self {
            version: "builtin:harness@1".to_owned(),
            actions: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct HarnessOverlay {
    pub id: String,
    pub actions: Vec<HarnessAction>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct HarnessOverride {
    pub id: String,
    pub disabled_actions: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EffectiveHarness {
    pub template_version: String,
    pub fingerprint: String,
    pub actions: Vec<HarnessAction>,
    pub provenance: Vec<String>,
}

impl EffectiveHarness {
    pub fn compose(
        template: &HarnessTemplate,
        profile: Option<&HarnessProfile>,
        overlays: &[HarnessOverlay],
        overrides: &[HarnessOverride],
    ) -> Result<Self, String> {
        let mut actions = template.actions.clone();
        let mut provenance = vec![template.version.clone()];
        if let Some(profile) = profile {
            actions.extend(profile.actions.clone());
            provenance.push("project-profile".to_owned());
        }
        let mut seen_overlay_actions = BTreeMap::<String, String>::new();
        for overlay in overlays {
            for action in &overlay.actions {
                if let Some(other) =
                    seen_overlay_actions.insert(action.id.clone(), overlay.id.clone())
                {
                    return Err(format!(
                        "ambiguous overlays {other} and {} define {}",
                        overlay.id, action.id
                    ));
                }
                actions.retain(|existing| existing.id != action.id);
                actions.push(action.clone());
            }
            provenance.push(format!("overlay:{}", overlay.id));
        }
        for task_override in overrides {
            actions.retain(|action| !task_override.disabled_actions.contains(&action.id));
            provenance.push(format!("override:{}", task_override.id));
        }
        actions.sort_by(|left, right| left.id.cmp(&right.id));
        let serialized = serde_json::to_vec(&(template.version.as_str(), &actions, &provenance))
            .map_err(|error| format!("fingerprint effective Harness: {error}"))?;
        Ok(Self {
            template_version: template.version.clone(),
            fingerprint: hex_digest(&serialized),
            actions,
            provenance,
        })
    }
}

#[derive(Clone, Debug)]
pub struct DiscoverySource {
    pub path: String,
    pub content: String,
}

impl DiscoverySource {
    pub fn new(path: &str, content: &str) -> Self {
        Self {
            path: path.to_owned(),
            content: content.to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionCandidate {
    pub id: String,
    pub command: String,
    pub source: String,
    pub source_fingerprint: String,
    pub trusted: bool,
}

impl ActionCandidate {
    pub fn sort_key(&self) -> (&str, &str, &str) {
        (&self.id, &self.source, &self.command)
    }
}

pub fn discover_actions(sources: &[DiscoverySource]) -> Vec<ActionCandidate> {
    let mut candidates = Vec::new();
    for source in sources {
        if source.path.ends_with("package.json") {
            if let Ok(value) = serde_json::from_str::<Value>(&source.content) {
                if let Some(scripts) = value.get("scripts").and_then(Value::as_object) {
                    for (name, command) in scripts {
                        if let Some(command) = command.as_str() {
                            candidates.push(ActionCandidate {
                                id: format!("package.{name}"),
                                command: command.to_owned(),
                                source: source.path.clone(),
                                source_fingerprint: hex_digest(source.content.as_bytes()),
                                trusted: false,
                            });
                        }
                    }
                }
            }
        }
    }
    candidates.sort_by(|left, right| left.sort_key().cmp(&right.sort_key()));
    candidates
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TrustState {
    Trusted,
    Drifted,
    Unconfirmed,
}

#[derive(Clone, Debug, Default)]
pub struct TrustStore {
    fingerprints: BTreeMap<String, String>,
}

impl TrustStore {
    pub fn confirm(&mut self, action_id: &str, fingerprint: &str) {
        self.fingerprints
            .insert(action_id.to_owned(), fingerprint.to_owned());
    }
    pub fn assess(&self, action_id: &str, fingerprint: &str) -> TrustState {
        match self.fingerprints.get(action_id) {
            Some(confirmed) if confirmed == fingerprint => TrustState::Trusted,
            Some(_) => TrustState::Drifted,
            None => TrustState::Unconfirmed,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Platform {
    Windows,
    Linux,
    Macos,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PreparedAction {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActionExecution {
    pub action_id: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub output_truncated: bool,
    pub timed_out: bool,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredTestResult {
    pub structured: bool,
    pub status: String,
    pub passed: bool,
    pub tests: Option<u64>,
    pub failures: Option<u64>,
    pub source: String,
}

impl StructuredTestResult {
    pub fn from_execution(execution: &ActionExecution) -> Self {
        let candidate = execution
            .stdout
            .lines()
            .chain(execution.stderr.lines())
            .map(str::trim)
            .find(|line| line.starts_with('{') && line.ends_with('}'));
        if let Some(line) = candidate {
            if let Ok(value) = serde_json::from_str::<Value>(line) {
                let passed = value
                    .get("passed")
                    .and_then(Value::as_bool)
                    .or_else(|| value.get("success").and_then(Value::as_bool));
                let tests = value
                    .get("tests")
                    .and_then(Value::as_u64)
                    .or_else(|| value.get("total").and_then(Value::as_u64));
                let failures = value
                    .get("failures")
                    .and_then(Value::as_u64)
                    .or_else(|| value.get("failed").and_then(Value::as_u64));
                if let Some(passed) = passed {
                    return Self {
                        structured: true,
                        status: if passed { "passed" } else { "failed" }.into(),
                        passed,
                        tests,
                        failures,
                        source: "json-line".into(),
                    };
                }
            }
        }
        let passed = execution.exit_code == Some(0) && !execution.timed_out;
        Self {
            structured: false,
            status: if execution.timed_out {
                "timed-out"
            } else if passed {
                "passed"
            } else {
                "failed"
            }
            .into(),
            passed,
            tests: None,
            failures: None,
            source: "exit-code".into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GateValidityResult {
    pub gate_id: String,
    pub probe_action_id: Option<String>,
    pub red_capable: bool,
    pub observed_failure: bool,
    pub reason: String,
}

impl GateValidityResult {
    pub fn missing_probe(gate_id: &str) -> Self {
        Self {
            gate_id: gate_id.into(),
            probe_action_id: None,
            red_capable: false,
            observed_failure: false,
            reason: "gate has no declared controlled red probe".into(),
        }
    }

    pub fn from_probe(gate_id: &str, probe_action_id: &str, execution: &ActionExecution) -> Self {
        let observed_failure = execution.timed_out || execution.exit_code != Some(0);
        Self {
            gate_id: gate_id.into(),
            probe_action_id: Some(probe_action_id.into()),
            red_capable: observed_failure,
            observed_failure,
            reason: if observed_failure {
                "controlled red probe produced a non-passing result".into()
            } else {
                "red probe unexpectedly passed; Gate validity is not proven".into()
            },
        }
    }
}

impl HarnessAction {
    pub fn prepare(
        &self,
        supplied: &BTreeMap<String, String>,
        _platform: Platform,
        risk_approved: bool,
    ) -> Result<PreparedAction, String> {
        let declared: BTreeSet<&str> = self.parameters.iter().map(String::as_str).collect();
        if supplied.keys().any(|key| !declared.contains(key.as_str())) {
            return Err("undeclared Harness Action parameter".into());
        }
        if declared.iter().any(|key| !supplied.contains_key(*key)) {
            return Err("missing Harness Action parameter".into());
        }
        if self.risk != ActionRisk::ReadOnly && !risk_approved {
            return Err("Harness Action risk requires authorization".into());
        }
        let substitute = |value: &str| {
            let mut rendered = value.to_owned();
            for (key, replacement) in supplied {
                rendered = rendered.replace(&format!("${{{key}}}"), replacement);
            }
            rendered
        };
        Ok(PreparedAction {
            program: substitute(&self.program),
            args: self.args.iter().map(|arg| substitute(arg)).collect(),
            cwd: self.cwd.clone(),
            timeout_ms: self.timeout_ms,
        })
    }
}

pub async fn execute_action(
    workspace: &Path,
    action: &HarnessAction,
    supplied: &BTreeMap<String, String>,
    platform: Platform,
    risk_approved: bool,
) -> Result<ActionExecution, String> {
    const MAX_CAPTURE_BYTES: usize = 1024 * 1024;
    let prepared = action.prepare(supplied, platform, risk_approved)?;
    let workspace = workspace
        .canonicalize()
        .map_err(|error| format!("resolve Harness workspace: {error}"))?;
    let cwd = workspace.join(&prepared.cwd);
    let cwd = cwd
        .canonicalize()
        .map_err(|error| format!("resolve Harness Action cwd: {error}"))?;
    if !cwd.starts_with(&workspace) {
        return Err("Harness Action cwd escapes its bound workspace".into());
    }

    let mut command = match action.kind {
        ActionKind::Exec => {
            let mut command = Command::new(&prepared.program);
            command.args(&prepared.args);
            command
        }
        ActionKind::Shell => {
            let expression = std::iter::once(prepared.program.as_str())
                .chain(prepared.args.iter().map(String::as_str))
                .collect::<Vec<_>>()
                .join(" ");
            #[cfg(target_os = "windows")]
            let command = {
                let mut command = Command::new("cmd.exe");
                command.args(["/D", "/S", "/C", &expression]);
                command
            };
            #[cfg(not(target_os = "windows"))]
            let command = {
                let mut command = Command::new("sh");
                command.args(["-lc", &expression]);
                command
            };
            command
        }
    };
    command
        .current_dir(&cwd)
        .env("PICODE_HARNESS_ACTION_ID", &action.id)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let started = Instant::now();
    let output = tokio::time::timeout(
        std::time::Duration::from_millis(prepared.timeout_ms),
        command.output(),
    )
    .await;
    let duration_ms = started.elapsed().as_millis() as u64;
    let output = match output {
        Ok(result) => {
            result.map_err(|error| format!("execute Harness Action {}: {error}", action.id))?
        }
        Err(_) => {
            return Ok(ActionExecution {
                action_id: action.id.clone(),
                exit_code: None,
                stdout: String::new(),
                stderr: format!("Harness Action exceeded {} ms", prepared.timeout_ms),
                output_truncated: false,
                timed_out: true,
                duration_ms,
            })
        }
    };
    let total_len = output.stdout.len().saturating_add(output.stderr.len());
    let stdout_len = output.stdout.len().min(MAX_CAPTURE_BYTES);
    let remaining = MAX_CAPTURE_BYTES.saturating_sub(stdout_len);
    let stderr_len = output.stderr.len().min(remaining);
    Ok(ActionExecution {
        action_id: action.id.clone(),
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout[..stdout_len]).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr[..stderr_len]).into_owned(),
        output_truncated: total_len > MAX_CAPTURE_BYTES,
        timed_out: false,
        duration_ms,
    })
}

#[derive(Clone, Debug, PartialEq)]
pub struct GateSelection {
    pub gate_ids: Vec<String>,
    pub rationale: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VerificationBaseline {
    pub gate_id: String,
    pub code_fingerprint: String,
    pub profile_fingerprint: String,
    pub platform: String,
    pub environment_revision: u64,
}

impl VerificationBaseline {
    pub fn new(gate_id: &str, code: &str, profile: &str, platform: &str, environment: u64) -> Self {
        Self {
            gate_id: gate_id.into(),
            code_fingerprint: code.into(),
            profile_fingerprint: profile.into(),
            platform: platform.into(),
            environment_revision: environment,
        }
    }
    pub fn comparable_with(
        &self,
        code: &str,
        profile: &str,
        platform: &str,
        environment: u64,
    ) -> bool {
        self.code_fingerprint == code
            && self.profile_fingerprint == profile
            && self.platform == platform
            && self.environment_revision == environment
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ActionAttempt {
    pub number: u32,
    pub passed: bool,
    pub reason: Option<String>,
}

impl ActionAttempt {
    pub fn passed(number: u32) -> Self {
        Self {
            number,
            passed: true,
            reason: None,
        }
    }
    pub fn failed(number: u32, reason: &str) -> Self {
        Self {
            number,
            passed: false,
            reason: Some(reason.into()),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct VerificationEvaluation {
    pub passed: bool,
    pub flaky: bool,
    pub attempts: Vec<ActionAttempt>,
}

pub fn evaluate_attempts(
    attempts: &[ActionAttempt],
    declared_retries: u32,
) -> Result<VerificationEvaluation, String> {
    if attempts.is_empty() {
        return Err("at least one verification attempt is required".into());
    }
    if attempts.len() > declared_retries as usize + 1 {
        return Err("undeclared verification retry".into());
    }
    for (index, attempt) in attempts.iter().enumerate() {
        if attempt.number as usize != index + 1 {
            return Err("verification attempts must be consecutive".into());
        }
    }
    let passed = attempts.last().is_some_and(|attempt| attempt.passed);
    let flaky = passed
        && attempts[..attempts.len() - 1]
            .iter()
            .any(|attempt| !attempt.passed);
    Ok(VerificationEvaluation {
        passed,
        flaky,
        attempts: attempts.to_vec(),
    })
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CompletionLabel {
    SimpleCompleted,
    HarnessVerified,
    HarnessVerifiedFlaky,
    HarnessVerifiedWithOverrides,
    HarnessIncomplete,
    Suspended,
    EnvironmentBlocked,
    Failed,
}

pub enum TaskCompletion<'a> {
    Simple,
    Harness(&'a VerificationEvaluation),
    Suspended,
    EnvironmentBlocked,
    Failed,
}

pub fn completion_label(completion: TaskCompletion<'_>, has_override: bool) -> CompletionLabel {
    match completion {
        TaskCompletion::Simple => CompletionLabel::SimpleCompleted,
        TaskCompletion::Harness(result) if !result.passed => CompletionLabel::HarnessIncomplete,
        TaskCompletion::Harness(result) if result.flaky => CompletionLabel::HarnessVerifiedFlaky,
        TaskCompletion::Harness(_) if has_override => CompletionLabel::HarnessVerifiedWithOverrides,
        TaskCompletion::Harness(_) => CompletionLabel::HarnessVerified,
        TaskCompletion::Suspended => CompletionLabel::Suspended,
        TaskCompletion::EnvironmentBlocked => CompletionLabel::EnvironmentBlocked,
        TaskCompletion::Failed => CompletionLabel::Failed,
    }
}

#[derive(Clone, Copy, Debug)]
pub struct EvidencePolicy {
    pub preview_bytes: usize,
    pub max_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct EvidenceEntry {
    pub id: String,
    pub task_id: String,
    pub action_id: String,
    pub preview: String,
    pub truncated: bool,
    pub byte_len: u64,
    pub encrypted: bool,
    pub artifact_present: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LedgerEvent {
    pub kind: String,
    pub evidence_id: String,
    pub detail: String,
}

#[derive(Deserialize, Serialize)]
struct LedgerDocument {
    version: u32,
    entries: Vec<EvidenceEntry>,
    events: Vec<LedgerEvent>,
}

pub struct EvidenceLedger {
    root: PathBuf,
    policy: EvidencePolicy,
    key: [u8; 32],
    entries: Vec<EvidenceEntry>,
    events: Vec<LedgerEvent>,
}

impl EvidenceLedger {
    pub fn open(root: &Path, policy: EvidencePolicy) -> Result<Self, String> {
        let mut key = [0_u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        Self::open_with_key(root, policy, key)
    }

    pub fn open_with_key(
        root: &Path,
        policy: EvidencePolicy,
        key: [u8; 32],
    ) -> Result<Self, String> {
        fs::create_dir_all(root).map_err(|error| format!("create evidence store: {error}"))?;
        let index = root.join("ledger.json");
        let document = if index.exists() {
            let document: LedgerDocument = serde_json::from_slice(
                &fs::read(&index).map_err(|error| format!("read Evidence Ledger: {error}"))?,
            )
            .map_err(|error| format!("corrupt Evidence Ledger: {error}"))?;
            if document.version != 1 {
                return Err(format!(
                    "unsupported Evidence Ledger version {}",
                    document.version
                ));
            }
            document
        } else {
            LedgerDocument {
                version: 1,
                entries: Vec::new(),
                events: Vec::new(),
            }
        };
        Ok(Self {
            root: root.to_owned(),
            policy,
            key,
            entries: document.entries,
            events: document.events,
        })
    }
    pub fn entries(&self) -> &[EvidenceEntry] {
        &self.entries
    }
    pub fn events(&self) -> &[LedgerEvent] {
        &self.events
    }

    pub fn record(
        &mut self,
        task_id: &str,
        action_id: &str,
        content: &[u8],
        secrets: &[String],
        sensitive: bool,
    ) -> Result<EvidenceEntry, String> {
        let mut redacted = String::from_utf8_lossy(content).into_owned();
        for secret in secrets {
            if !secret.is_empty() {
                redacted = redacted.replace(secret, "[REDACTED]");
            }
        }
        let bytes = redacted.as_bytes();
        let id = hex_digest(bytes);
        let preview_length = bytes.len().min(self.policy.preview_bytes);
        let preview = String::from_utf8_lossy(&bytes[..preview_length]).into_owned();
        let artifact = if sensitive {
            self.encrypt(bytes)?
        } else {
            bytes.to_vec()
        };
        fs::write(self.root.join(&id), artifact)
            .map_err(|error| format!("write evidence artifact: {error}"))?;
        let entry = EvidenceEntry {
            id: id.clone(),
            task_id: task_id.into(),
            action_id: action_id.into(),
            preview,
            truncated: bytes.len() > preview_length,
            byte_len: bytes.len() as u64,
            encrypted: sensitive,
            artifact_present: true,
        };
        self.entries.push(entry.clone());
        self.enforce_retention()?;
        self.persist()?;
        Ok(entry)
    }

    pub fn verify(&self, id: &str) -> Result<bool, String> {
        let entry = self
            .entries
            .iter()
            .find(|entry| entry.id == id)
            .ok_or_else(|| "evidence entry missing".to_owned())?;
        let stored =
            fs::read(self.root.join(id)).map_err(|_| "evidence artifact missing".to_owned())?;
        let content = if entry.encrypted {
            self.decrypt(&stored)?
        } else {
            stored
        };
        Ok(hex_digest(&content) == entry.id)
    }

    fn encrypt(&self, content: &[u8]) -> Result<Vec<u8>, String> {
        let cipher =
            Aes256Gcm::new_from_slice(&self.key).map_err(|_| "invalid evidence key".to_owned())?;
        let mut nonce_bytes = [0_u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), content)
            .map_err(|_| "encrypt evidence".to_owned())?;
        let mut encoded = nonce_bytes.to_vec();
        encoded.extend(ciphertext);
        Ok(encoded)
    }

    fn decrypt(&self, content: &[u8]) -> Result<Vec<u8>, String> {
        if content.len() < 12 {
            return Err("corrupt encrypted evidence".into());
        }
        let cipher =
            Aes256Gcm::new_from_slice(&self.key).map_err(|_| "invalid evidence key".to_owned())?;
        cipher
            .decrypt(Nonce::from_slice(&content[..12]), &content[12..])
            .map_err(|_| "decrypt evidence".to_owned())
    }

    fn enforce_retention(&mut self) -> Result<(), String> {
        let mut retained: u64 = self
            .entries
            .iter()
            .filter(|entry| entry.artifact_present)
            .map(|entry| entry.byte_len)
            .sum();
        if retained <= self.policy.max_bytes {
            return Ok(());
        }
        for entry in &mut self.entries {
            if retained <= self.policy.max_bytes {
                break;
            }
            if !entry.artifact_present {
                continue;
            }
            let _ = fs::remove_file(self.root.join(&entry.id));
            entry.artifact_present = false;
            retained = retained.saturating_sub(entry.byte_len);
            self.events.push(LedgerEvent {
                kind: "retention".into(),
                evidence_id: entry.id.clone(),
                detail: "artifact removed; hash and summary retained".into(),
            });
        }
        Ok(())
    }

    fn persist(&self) -> Result<(), String> {
        let path = self.root.join("ledger.json");
        let encoded = serde_json::to_vec_pretty(&LedgerDocument {
            version: 1,
            entries: self.entries.clone(),
            events: self.events.clone(),
        })
        .map_err(|error| format!("serialize Evidence Ledger: {error}"))?;
        let store = crate::safe_files::SafeFileStore;
        if path.exists() {
            let snapshot = store.read(&path)?;
            store.write_atomic(&path, &snapshot.version, &encoded)?;
        } else {
            store.create_atomic(&path, &encoded)?;
        }
        Ok(())
    }
}

fn hex_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::fs;
    use uuid::Uuid;

    fn profile_json() -> &'static str {
        r#"{
          // Portable project semantics only.
          "schemaVersion": 1,
          "actions": [
            {
              "id": "test.unit",
              "kind": "exec",
              "program": "cargo",
              "args": ["test", "--package", "${package}"],
              "parameters": ["package"],
              "cwd": ".",
              "timeoutMs": 60000,
              "risk": "readOnly",
              "dependsOn": []
            }
          ],
          "gates": [{"id":"gate.unit","actionId":"test.unit","pathPrefixes":["src/"]}],
          "slots": [{"id":"cargoHome","required":false,"secret":false}]
        }"#
    }

    #[test]
    fn profile_discovery_review_composition_and_drift_are_deterministic() {
        let profile = HarnessProfile::parse_jsonc(profile_json()).unwrap();
        let template = HarnessTemplate::builtin_v1();
        let first = EffectiveHarness::compose(&template, Some(&profile), &[], &[]).unwrap();
        let second = EffectiveHarness::compose(&template, Some(&profile), &[], &[]).unwrap();
        assert_eq!(first.fingerprint, second.fingerprint);
        assert_eq!(first.template_version, "builtin:harness@1");

        let candidates = discover_actions(&[
            DiscoverySource::new(
                "package.json",
                r#"{"scripts":{"test":"vitest","build":"vite build"}}"#,
            ),
            DiscoverySource::new("package.json", r#"{"scripts":{"test":"jest"}}"#),
        ]);
        assert_eq!(candidates.len(), 3);
        assert!(candidates.iter().all(|candidate| !candidate.trusted));
        assert!(candidates
            .windows(2)
            .all(|pair| pair[0].sort_key() <= pair[1].sort_key()));

        let mut trust = TrustStore::default();
        trust.confirm("test.unit", "source-a");
        assert_eq!(trust.assess("test.unit", "source-a"), TrustState::Trusted);
        assert_eq!(trust.assess("test.unit", "source-b"), TrustState::Drifted);
        assert_eq!(trust.assess("gone", "source-a"), TrustState::Unconfirmed);

        assert!(HarnessProfile::parse_jsonc(
            r#"{"schemaVersion":1,"actions":[{"id":"bad","kind":"exec","program":"x","args":[],"parameters":[],"cwd":"C:\\\\secrets","timeoutMs":1,"risk":"readOnly","dependsOn":[]}],"gates":[],"slots":[]}"#
        )
        .unwrap_err()
        .contains("portable"));
    }

    #[test]
    fn typed_actions_gates_baselines_retries_and_completion_are_truthful() {
        let profile = HarnessProfile::parse_jsonc(profile_json()).unwrap();
        let action = &profile.actions[0];
        let mut parameters = BTreeMap::new();
        parameters.insert("package".to_owned(), "core".to_owned());
        let invocation = action
            .prepare(&parameters, Platform::Windows, true)
            .unwrap();
        assert_eq!(invocation.program, "cargo");
        assert_eq!(invocation.args, vec!["test", "--package", "core"]);
        parameters.insert("undeclared".to_owned(), "oops".to_owned());
        assert!(action
            .prepare(&parameters, Platform::Windows, true)
            .is_err());

        let gates = profile.select_gates(&["src/lib.rs".to_owned()]);
        assert_eq!(gates.rationale[0], "gate.unit selected by src/lib.rs");
        assert_eq!(gates.gate_ids, vec!["gate.unit"]);

        let baseline = VerificationBaseline::new("gate.unit", "code-a", "profile-a", "windows", 1);
        assert!(baseline.comparable_with("code-a", "profile-a", "windows", 1));
        assert!(!baseline.comparable_with("code-b", "profile-a", "windows", 1));
        let evaluation = evaluate_attempts(
            &[
                ActionAttempt::failed(1, "predicate failed"),
                ActionAttempt::passed(2),
            ],
            1,
        )
        .unwrap();
        assert!(evaluation.flaky);
        assert_eq!(evaluation.attempts.len(), 2);
        assert_eq!(
            completion_label(TaskCompletion::Harness(&evaluation), false),
            CompletionLabel::HarnessVerifiedFlaky
        );
        assert_eq!(
            completion_label(TaskCompletion::Simple, false),
            CompletionLabel::SimpleCompleted
        );
    }

    #[test]
    fn evidence_is_content_addressed_bounded_redacted_and_retained() {
        let root = std::env::temp_dir().join(format!("picode-evidence-{}", Uuid::new_v4()));
        let mut ledger = EvidenceLedger::open_with_key(
            &root,
            EvidencePolicy {
                preview_bytes: 18,
                max_bytes: 80,
            },
            [9_u8; 32],
        )
        .unwrap();
        let first = ledger
            .record(
                "task-a",
                "test.unit",
                b"token=secret-value\nall checks passed with a very long tail",
                &["secret-value".to_owned()],
                false,
            )
            .unwrap();
        assert!(!first.preview.contains("secret-value"));
        assert!(first.preview.contains("[REDACTED]"));
        assert!(first.truncated);
        assert!(ledger.verify(&first.id).unwrap());
        let _second = ledger
            .record("task-a", "build", &[b'x'; 70], &[], true)
            .unwrap();
        assert!(ledger
            .events()
            .iter()
            .any(|event| event.kind == "retention"));
        assert!(ledger
            .entries()
            .iter()
            .all(|entry| entry.task_id == "task-a"));
        drop(ledger);
        let reopened = EvidenceLedger::open_with_key(
            &root,
            EvidencePolicy {
                preview_bytes: 18,
                max_bytes: 80,
            },
            [9_u8; 32],
        )
        .unwrap();
        assert_eq!(reopened.entries().len(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn typed_action_runner_executes_only_the_reviewed_program_and_cwd() {
        let root = std::env::temp_dir().join(format!("picode-harness-run-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        #[cfg(target_os = "windows")]
        let (program, args) = ("cmd", vec!["/C", "echo", "harness-ok"]);
        #[cfg(not(target_os = "windows"))]
        let (program, args) = ("sh", vec!["-c", "printf harness-ok"]);
        let action = HarnessAction {
            id: "verify.echo".into(),
            kind: ActionKind::Exec,
            program: program.into(),
            args: args.into_iter().map(str::to_owned).collect(),
            parameters: Vec::new(),
            cwd: ".".into(),
            timeout_ms: 5_000,
            risk: ActionRisk::ReadOnly,
            depends_on: Vec::new(),
        };

        let result = execute_action(&root, &action, &BTreeMap::new(), Platform::Windows, false)
            .await
            .unwrap();
        assert_eq!(result.action_id, "verify.echo");
        assert_eq!(result.exit_code, Some(0));
        assert!(result.stdout.contains("harness-ok"));
        assert!(!result.timed_out);

        let escaping = HarnessAction {
            cwd: "../outside".into(),
            ..action
        };
        assert!(
            execute_action(&root, &escaping, &BTreeMap::new(), Platform::Windows, false)
                .await
                .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }
}
