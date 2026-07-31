#![cfg_attr(not(test), allow(dead_code))]

use crate::broker_ws::BrokerWs;
use crate::capability::IndexMatch;
use crate::capability_service::CapabilityService;
use crate::execution::TaskKind;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeLspRequest {
    pub language: String,
    pub operation: String,
    pub path: String,
    pub line: Option<u32>,
    pub character: Option<u32>,
}

#[derive(Clone)]
pub struct CodeIntelligence {
    service: Arc<Mutex<CapabilityService>>,
}

impl CodeIntelligence {
    pub fn new(service: Arc<Mutex<CapabilityService>>) -> Self {
        Self { service }
    }

    pub fn index(&self, task_id: &str, workspace: &Path) -> Result<usize, String> {
        self.service
            .lock()
            .map_err(lock_error)?
            .refresh_index(task_id, workspace)
    }

    pub fn navigate(
        &self,
        task_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<IndexMatch>, String> {
        self.service
            .lock()
            .map_err(lock_error)?
            .search_code(task_id, query, limit)
    }

    /// Routes code navigation through the real scoped LSP implementation in
    /// the embedded Pi extension. There is deliberately no second Rust-side
    /// pseudo session or diagnostics cache.
    pub async fn request_lsp(
        &self,
        broker: &BrokerWs,
        port: u16,
        task_kind: TaskKind,
        request: &CodeLspRequest,
    ) -> Result<Value, String> {
        validate_request(task_kind, request)?;
        broker
            .request_command_to_port(
                port,
                serde_json::json!({
                    "type": "picode_lsp_request",
                    "language": request.language,
                    "operation": request.operation,
                    "path": request.path,
                    "line": request.line,
                    "character": request.character,
                }),
                Duration::from_secs(20),
            )
            .await
    }
}

fn validate_request(task_kind: TaskKind, request: &CodeLspRequest) -> Result<(), String> {
    if task_kind != TaskKind::Harness {
        return Err("LSP is available only to a workspace-bound Harness Task".to_owned());
    }
    if request.language.trim().is_empty()
        || request.operation.trim().is_empty()
        || request.path.trim().is_empty()
    {
        return Err("LSP language, operation, and workspace-relative path are required".to_owned());
    }
    if request.path.contains('\0') {
        return Err("LSP path contains NUL".to_owned());
    }
    Ok(())
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    "Code Intelligence lock is poisoned".to_owned()
}

#[cfg(test)]
mod tests {
    use super::{validate_request, CodeLspRequest};
    use crate::execution::TaskKind;

    #[test]
    fn real_lsp_adapter_is_harness_only_and_requires_a_scoped_request() {
        let request = CodeLspRequest {
            language: "rust".into(),
            operation: "definition".into(),
            path: "src/main.rs".into(),
            line: Some(1),
            character: Some(1),
        };
        assert!(validate_request(TaskKind::Simple, &request).is_err());
        validate_request(TaskKind::Harness, &request).unwrap();

        let missing_path = CodeLspRequest {
            path: "".into(),
            ..request
        };
        assert!(validate_request(TaskKind::Harness, &missing_path).is_err());
    }
}
