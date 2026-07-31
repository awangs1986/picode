use crate::extension_service::ExtensionService;
use crate::orchestration_service::OrchestrationService;
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

/// Production-facing extension seam. The durable service is deliberately an
/// implementation detail; GUI, monitoring and task lifecycle code hold this
/// manager so the service can be replaced without another public state model.
pub struct ExtensionManager {
    service: ExtensionService,
}

impl ExtensionManager {
    pub fn open(root: &Path, orchestration: Arc<OrchestrationService>) -> Result<Self, String> {
        Ok(Self {
            service: ExtensionService::open(root, orchestration)?,
        })
    }
}

impl Deref for ExtensionManager {
    type Target = ExtensionService;

    fn deref(&self) -> &Self::Target {
        &self.service
    }
}
