use crate::harness::{
    discover_actions, execute_action, ActionCandidate, ActionExecution, ActionKind, ActionRisk,
    CompletionGate, DiscoverySource, EvidenceEntry, EvidenceLedger, EvidencePolicy, HarnessAction,
    HarnessProfile, LocalSlot, Platform,
};
use crate::safe_files::SafeFileStore;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

const EVIDENCE_KEYRING_SERVICE: &str = "dev.pi.picode.evidence";
const EVIDENCE_KEYRING_USER: &str = "default";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessReview {
    pub task_id: String,
    pub workspace: String,
    pub profile_exists: bool,
    pub profile: Option<HarnessProfile>,
    pub candidates: Vec<ActionCandidate>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmedHarness {
    pub task_id: String,
    pub profile_path: String,
    pub profile: HarnessProfile,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRunResult {
    pub passed: bool,
    pub execution: ActionExecution,
    pub evidence: EvidenceEntry,
}

#[derive(Default, Deserialize, Serialize)]
struct TrustDocument {
    version: u32,
    fingerprints: BTreeMap<String, String>,
}

pub struct HarnessService {
    root: PathBuf,
    key_override: Option<[u8; 32]>,
}

impl HarnessService {
    pub fn new(root: PathBuf, key_override: Option<[u8; 32]>) -> Result<Self, String> {
        fs::create_dir_all(&root)
            .map_err(|error| format!("create Harness service state: {error}"))?;
        Ok(Self { root, key_override })
    }

    pub fn review(&self, task_id: &str, workspace: &Path) -> Result<HarnessReview, String> {
        let workspace = canonical_workspace(workspace)?;
        let profile_path = workspace.join(".picode").join("harness.jsonc");
        let profile = if profile_path.exists() {
            Some(HarnessProfile::parse_jsonc(
                &fs::read_to_string(&profile_path)
                    .map_err(|error| format!("read Harness Profile: {error}"))?,
            )?)
        } else {
            None
        };
        let trust = self.load_trust(task_id)?;
        let mut candidates = discover_actions(&discovery_sources(&workspace)?);
        for candidate in &mut candidates {
            candidate.trusted = trust
                .fingerprints
                .get(&candidate.id)
                .is_some_and(|fingerprint| fingerprint == &candidate.source_fingerprint);
        }
        Ok(HarnessReview {
            task_id: task_id.to_owned(),
            workspace: workspace.to_string_lossy().into_owned(),
            profile_exists: profile.is_some(),
            profile,
            candidates,
        })
    }

    pub fn confirm_profile(
        &self,
        task_id: &str,
        workspace: &Path,
        selected_ids: &[String],
    ) -> Result<ConfirmedHarness, String> {
        let workspace = canonical_workspace(workspace)?;
        let selected: BTreeSet<&str> = selected_ids.iter().map(String::as_str).collect();
        if selected.is_empty() {
            return Err("at least one reviewed Harness Action must be selected".into());
        }
        let candidates = discover_actions(&discovery_sources(&workspace)?);
        if selected
            .iter()
            .any(|id| !candidates.iter().any(|candidate| candidate.id == *id))
        {
            return Err("a selected Harness Action is no longer present in discovery".into());
        }
        let chosen: Vec<&ActionCandidate> = candidates
            .iter()
            .filter(|candidate| selected.contains(candidate.id.as_str()))
            .collect();
        let actions = chosen
            .iter()
            .map(|candidate| HarnessAction {
                id: candidate.id.clone(),
                kind: ActionKind::Shell,
                program: candidate.command.clone(),
                args: Vec::new(),
                parameters: Vec::new(),
                cwd: ".".into(),
                timeout_ms: 120_000,
                risk: ActionRisk::ReadOnly,
                depends_on: Vec::new(),
            })
            .collect::<Vec<_>>();
        let gates = chosen
            .iter()
            .map(|candidate| CompletionGate {
                id: format!("gate.{}", candidate.id),
                action_id: candidate.id.clone(),
                path_prefixes: Vec::new(),
            })
            .collect();
        let profile = HarnessProfile {
            schema_version: 1,
            actions,
            gates,
            slots: Vec::<LocalSlot>::new(),
        };
        let encoded = serde_json::to_vec_pretty(&profile)
            .map_err(|error| format!("encode Harness Profile: {error}"))?;
        let profile_path = workspace.join(".picode").join("harness.jsonc");
        write_versioned(&profile_path, &encoded)?;
        let trust = TrustDocument {
            version: 1,
            fingerprints: chosen
                .iter()
                .map(|candidate| (candidate.id.clone(), candidate.source_fingerprint.clone()))
                .collect(),
        };
        self.save_trust(task_id, &trust)?;
        Ok(ConfirmedHarness {
            task_id: task_id.to_owned(),
            profile_path: profile_path.to_string_lossy().into_owned(),
            profile,
        })
    }

    pub async fn run_action(
        &self,
        task_id: &str,
        workspace: &Path,
        action_id: &str,
        parameters: &BTreeMap<String, String>,
        risk_approved: bool,
    ) -> Result<HarnessRunResult, String> {
        let workspace = canonical_workspace(workspace)?;
        let profile_path = workspace.join(".picode").join("harness.jsonc");
        let profile = HarnessProfile::parse_jsonc(
            &fs::read_to_string(&profile_path)
                .map_err(|error| format!("read confirmed Harness Profile: {error}"))?,
        )?;
        let action = profile
            .actions
            .iter()
            .find(|action| action.id == action_id)
            .ok_or_else(|| "Harness Action is not declared in the confirmed Profile".to_owned())?;
        let platform = current_platform();
        let execution =
            execute_action(&workspace, action, parameters, platform, risk_approved).await?;
        let passed = execution.exit_code == Some(0) && !execution.timed_out;
        let evidence_content = format!(
            "action={}\nexit={:?}\ntimeout={}\nstdout:\n{}\nstderr:\n{}",
            action.id, execution.exit_code, execution.timed_out, execution.stdout, execution.stderr
        );
        let evidence = self.record_external_evidence(
            task_id,
            action_id,
            evidence_content.as_bytes(),
            &[],
            true,
        )?;
        Ok(HarnessRunResult {
            passed,
            execution,
            evidence,
        })
    }

    /// Record bounded metadata from an optional Harness capability such as DAP.
    /// The caller is responsible for keeping the content free of raw secrets or
    /// unbounded protocol payloads; the Evidence Ledger still applies redaction,
    /// encryption, and retention before the reference is attached to a task.
    pub fn record_external_evidence(
        &self,
        task_id: &str,
        action_id: &str,
        content: &[u8],
        secrets: &[String],
        sensitive: bool,
    ) -> Result<EvidenceEntry, String> {
        let mut ledger = EvidenceLedger::open_with_key(
            &self.root.join("evidence").join(task_key(task_id)),
            EvidencePolicy {
                preview_bytes: 8 * 1024,
                max_bytes: 256 * 1024 * 1024,
            },
            self.evidence_key()?,
        )?;
        ledger.record(task_id, action_id, content, secrets, sensitive)
    }

    fn trust_path(&self, task_id: &str) -> PathBuf {
        self.root
            .join("trust")
            .join(format!("{}.json", task_key(task_id)))
    }

    fn load_trust(&self, task_id: &str) -> Result<TrustDocument, String> {
        let path = self.trust_path(task_id);
        if !path.exists() {
            return Ok(TrustDocument {
                version: 1,
                ..TrustDocument::default()
            });
        }
        let document: TrustDocument = serde_json::from_slice(
            &fs::read(&path).map_err(|error| format!("read Harness trust: {error}"))?,
        )
        .map_err(|error| format!("corrupt Harness trust: {error}"))?;
        if document.version != 1 {
            return Err(format!(
                "unsupported Harness trust version {}",
                document.version
            ));
        }
        Ok(document)
    }

    fn save_trust(&self, task_id: &str, trust: &TrustDocument) -> Result<(), String> {
        let encoded = serde_json::to_vec_pretty(trust)
            .map_err(|error| format!("encode Harness trust: {error}"))?;
        write_versioned(&self.trust_path(task_id), &encoded)
    }

    fn evidence_key(&self) -> Result<[u8; 32], String> {
        if let Some(key) = self.key_override {
            return Ok(key);
        }
        let entry = keyring::Entry::new(EVIDENCE_KEYRING_SERVICE, EVIDENCE_KEYRING_USER)
            .map_err(|error| format!("open evidence credential: {error}"))?;
        match entry.get_secret() {
            Ok(secret) => secret
                .try_into()
                .map_err(|_| "evidence credential has an invalid length".to_owned()),
            Err(keyring::Error::NoEntry) => {
                let mut key = [0_u8; 32];
                OsRng.fill_bytes(&mut key);
                entry
                    .set_secret(&key)
                    .map_err(|error| format!("save evidence credential: {error}"))?;
                Ok(key)
            }
            Err(error) => Err(format!("read evidence credential: {error}")),
        }
    }
}

fn canonical_workspace(workspace: &Path) -> Result<PathBuf, String> {
    let workspace = workspace
        .canonicalize()
        .map_err(|error| format!("resolve bound Harness workspace: {error}"))?;
    if !workspace.is_dir() {
        return Err("bound Harness workspace is not a directory".into());
    }
    Ok(workspace)
}

fn discovery_sources(workspace: &Path) -> Result<Vec<DiscoverySource>, String> {
    let mut paths = vec![workspace.join("package.json")];
    if let Ok(entries) = fs::read_dir(workspace) {
        for entry in entries.flatten().take(200) {
            let candidate = entry.path().join("package.json");
            if candidate.is_file() {
                paths.push(candidate);
            }
        }
    }
    paths.sort();
    paths.dedup();
    let mut sources = Vec::new();
    for path in paths {
        if !path.is_file() {
            continue;
        }
        let relative = path.strip_prefix(workspace).unwrap_or(&path);
        sources.push(DiscoverySource::new(
            &relative.to_string_lossy().replace('\\', "/"),
            &fs::read_to_string(&path)
                .map_err(|error| format!("read discovery source {}: {error}", path.display()))?,
        ));
    }
    Ok(sources)
}

fn write_versioned(path: &Path, content: &[u8]) -> Result<(), String> {
    let store = SafeFileStore;
    if path.exists() {
        let snapshot = store.read(path)?;
        store.write_atomic(path, &snapshot.version, content)?;
    } else {
        store.create_atomic(path, content)?;
    }
    Ok(())
}

fn task_key(task_id: &str) -> String {
    format!("{:x}", Sha256::digest(task_id.as_bytes()))
}

fn current_platform() -> Platform {
    #[cfg(target_os = "windows")]
    return Platform::Windows;
    #[cfg(target_os = "linux")]
    return Platform::Linux;
    #[cfg(target_os = "macos")]
    return Platform::Macos;
    #[allow(unreachable_code)]
    Platform::Linux
}

#[cfg(test)]
mod tests {
    use super::HarnessService;
    use std::collections::BTreeMap;
    use std::fs;
    use uuid::Uuid;

    #[tokio::test]
    async fn review_confirmation_and_execution_are_one_explicit_harness_flow() {
        let root = std::env::temp_dir().join(format!("picode-harness-service-{}", Uuid::new_v4()));
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(
            workspace.join("package.json"),
            r#"{"scripts":{"verify":"echo harness-ok","unselected":"echo no"}}"#,
        )
        .unwrap();
        let service = HarnessService::new(root.join("state"), Some([3_u8; 32])).unwrap();

        let review = service.review("task-a", &workspace).unwrap();
        assert_eq!(review.candidates.len(), 2);
        assert!(!review.profile_exists);
        let confirmed = service
            .confirm_profile("task-a", &workspace, &["package.verify".into()])
            .unwrap();
        assert_eq!(confirmed.profile.actions.len(), 1);
        assert!(workspace.join(".picode/harness.jsonc").exists());

        let result = service
            .run_action(
                "task-a",
                &workspace,
                "package.verify",
                &BTreeMap::new(),
                true,
            )
            .await
            .unwrap();
        assert!(result.passed);
        assert!(result.execution.stdout.contains("harness-ok"));
        assert!(result.evidence.encrypted);
        fs::remove_dir_all(root).unwrap();
    }
}
