use crate::extension_service::ExtensionService;
use crate::work_manager::WorkManager;
use serde::{Deserialize, Serialize};
use std::ops::Deref;
use std::path::Path;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionLifecycle {
    Discovered,
    Enabled,
    Trusted,
    Running,
}

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

/// Production-facing extension seam. The durable service is deliberately an
/// implementation detail; GUI, monitoring and task lifecycle code hold this
/// manager so the service can be replaced without another public state model.
pub struct ExtensionManager {
    service: ExtensionService,
}

impl ExtensionManager {
    pub fn open(root: &Path, work: Arc<WorkManager>) -> Result<Self, String> {
        Ok(Self {
            service: ExtensionService::open(root, work)?,
        })
    }
}

impl Deref for ExtensionManager {
    type Target = ExtensionService;

    fn deref(&self) -> &Self::Target {
        &self.service
    }
}

#[cfg(test)]
mod tests {
    use super::Permission;
    use super::{ExtensionLifecycle, ExtensionManager};
    use crate::extension_service::{ExtensionManifest, ResourceLimits};
    use crate::orchestration_service::OrchestrationService;
    use crate::work_manager::WorkManager;
    use std::collections::BTreeSet;
    use std::sync::Arc;

    fn manager(label: &str) -> (std::path::PathBuf, ExtensionManager) {
        let root = std::env::temp_dir().join(format!(
            "picode-extension-manager-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let jobs = Arc::new(OrchestrationService::open(&root.join("jobs"), 4096).unwrap());
        let work = Arc::new(WorkManager::new(jobs));
        let manager = ExtensionManager::open(&root.join("extensions"), work).unwrap();
        (root, manager)
    }

    fn manifest(id: &str) -> ExtensionManifest {
        ExtensionManifest::new(
            id,
            1,
            std::env::current_exe().unwrap(),
            vec!["--help".into()],
            BTreeSet::from([Permission::ProcessExecute]),
            ResourceLimits {
                max_memory_bytes: 64 * 1024 * 1024,
                max_output_bytes: 4096,
            },
        )
    }

    #[test]
    fn enabled_and_trusted_are_distinct_nonresident_states() {
        let (root, manager) = manager("four-state");
        manager.install(manifest("formatter")).unwrap();
        let discovered = manager.snapshot();
        assert_eq!(
            discovered.lifecycle[0].state,
            ExtensionLifecycle::Discovered
        );
        assert!(!discovered.lifecycle[0].model_discoverable);
        assert!(discovered.processes.is_empty());

        manager.set_enabled("formatter", true).unwrap();
        let enabled = manager.snapshot();
        assert_eq!(enabled.lifecycle[0].state, ExtensionLifecycle::Enabled);
        assert!(enabled.lifecycle[0].model_discoverable);
        assert!(enabled.processes.is_empty());

        manager.set_trusted("formatter", true).unwrap();
        let trusted = manager.snapshot();
        assert_eq!(trusted.lifecycle[0].state, ExtensionLifecycle::Trusted);
        assert!(trusted.processes.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn manifest_v2_rejects_malicious_or_unreviewed_source_changes() {
        let (root, manager) = manager("manifest-v2");
        let mut malicious = manifest("remote-tool");
        malicious.source = "https://example.invalid/tool".into();
        malicious.source_ref = Some("main".into());
        assert!(manager
            .install(malicious)
            .unwrap_err()
            .contains("pinned full commit SHA"));

        let mut pinned = manifest("remote-tool");
        pinned.source = "https://example.invalid/tool".into();
        pinned.source_ref = Some("a".repeat(40));
        pinned.source_hash = Some("b".repeat(64));
        manager.install(pinned.clone()).unwrap();
        pinned.schema_version = 2;
        pinned.version = "schema-2".into();
        pinned.source_hash = Some("c".repeat(64));
        assert!(manager
            .migrate("remote-tool", pinned, false)
            .unwrap_err()
            .contains("SHA change"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn executable_sha_drift_revokes_trust_before_any_process_starts() {
        let (root, manager) = manager("sha-drift");
        let mut changed = manifest("changed-tool");
        let staged = root.join("changed-tool.exe");
        std::fs::copy(&changed.executable, &staged).unwrap();
        changed.executable = staged.clone();
        manager.install(changed).unwrap();
        manager.set_enabled("changed-tool", true).unwrap();
        manager.set_trusted("changed-tool", true).unwrap();
        std::fs::write(&staged, b"tampered after trust").unwrap();
        assert!(manager
            .start_extension(
                "changed-tool",
                "task-a",
                "run-a",
                &root,
                std::time::Duration::from_secs(1),
            )
            .unwrap_err()
            .contains("SHA changed"));
        let snapshot = manager.snapshot();
        assert_eq!(snapshot.lifecycle[0].state, ExtensionLifecycle::Enabled);
        assert!(snapshot.processes.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn trusted_extension_cannot_use_an_undeclared_permission() {
        let (root, manager) = manager("permission-boundary");
        manager.install(manifest("local-tool")).unwrap();
        manager.set_enabled("local-tool", true).unwrap();
        manager.set_trusted("local-tool", true).unwrap();
        assert!(manager
            .authorize_permission("local-tool", Permission::Network)
            .unwrap_err()
            .contains("permission denied"));
        assert!(manager.snapshot().processes.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
