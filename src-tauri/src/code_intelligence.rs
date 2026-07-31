#![cfg_attr(not(test), allow(dead_code))]

use crate::capability::IndexMatch;
use crate::capability_service::CapabilityService;
use crate::execution::TaskKind;
use std::path::Path;
use std::sync::{Arc, Mutex};

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

    pub fn start_lsp(
        &self,
        task_id: &str,
        task_kind: TaskKind,
        language: &str,
        scope: &str,
        at: u64,
    ) -> Result<String, String> {
        self.service
            .lock()
            .map_err(lock_error)?
            .start_lsp(task_id, task_kind, language, scope, at)
    }

    pub fn record_diagnostics(
        &self,
        session_id: &str,
        path: &str,
        version: &str,
        diagnostics: Vec<String>,
    ) -> Result<(), String> {
        self.service
            .lock()
            .map_err(lock_error)?
            .record_lsp_diagnostics(session_id, path, version, diagnostics)
    }

    pub fn diagnose(
        &self,
        session_id: &str,
        path: &str,
        version: &str,
    ) -> Result<Vec<String>, String> {
        self.service
            .lock()
            .map_err(lock_error)?
            .lsp_diagnostics(session_id, path, version)
    }

    pub fn shutdown(&self, session_id: &str) -> Result<(), String> {
        self.service
            .lock()
            .map_err(lock_error)?
            .shutdown_lsp(session_id)
    }

    pub fn running_count(&self) -> Result<usize, String> {
        Ok(self.service.lock().map_err(lock_error)?.running_lsp_count())
    }
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    "Code Intelligence lock is poisoned".to_owned()
}

#[cfg(test)]
mod tests {
    use super::CodeIntelligence;
    use crate::capability_service::CapabilityService;
    use crate::execution::TaskKind;
    use std::fs;
    use std::sync::{Arc, Mutex};

    #[test]
    fn lazy_lsp_rejects_simple_tasks_and_stale_diagnostics_then_shuts_down() {
        let root = std::env::temp_dir().join(format!("picode-code-intel-{}", uuid::Uuid::new_v4()));
        let service = Arc::new(Mutex::new(CapabilityService::open(&root).unwrap()));
        let intelligence = CodeIntelligence::new(service);
        assert!(intelligence
            .start_lsp("simple", TaskKind::Simple, "rust", "src", 1)
            .is_err());

        let session = intelligence
            .start_lsp("harness", TaskKind::Harness, "rust", "src", 2)
            .unwrap();
        intelligence
            .record_diagnostics(&session, "src/main.rs", "v1", vec!["error: broken".into()])
            .unwrap();
        assert!(intelligence
            .diagnose(&session, "src/main.rs", "v2")
            .is_err());
        assert_eq!(
            intelligence
                .diagnose(&session, "src/main.rs", "v1")
                .unwrap(),
            vec!["error: broken"]
        );
        intelligence.shutdown(&session).unwrap();
        assert_eq!(intelligence.running_count().unwrap(), 0);
        drop(intelligence);
        fs::remove_dir_all(root).unwrap();
    }
}
