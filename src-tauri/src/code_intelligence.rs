#![cfg_attr(not(test), allow(dead_code))]

use crate::capability::IndexMatch;
use crate::capability_service::{encode_lsp_frame, CapabilityService};
use crate::execution::TaskKind;
use crate::work_manager::{StartProcess, WorkKind, WorkManager, WorkStatus};
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
    work: Arc<WorkManager>,
}

impl CodeIntelligence {
    pub fn new(service: Arc<Mutex<CapabilityService>>, work: Arc<WorkManager>) -> Self {
        Self { service, work }
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

    pub async fn request_lsp(
        &self,
        task_id: &str,
        run_id: &str,
        workspace: &Path,
        task_kind: TaskKind,
        request: &CodeLspRequest,
    ) -> Result<Value, String> {
        let (executable, args) = language_server(&request.language)?;
        self.request_lsp_with_server(
            task_id,
            run_id,
            workspace,
            task_kind,
            request,
            executable,
            args,
            Duration::from_secs(15),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn request_lsp_with_server(
        &self,
        task_id: &str,
        run_id: &str,
        workspace: &Path,
        task_kind: TaskKind,
        request: &CodeLspRequest,
        executable: String,
        args: Vec<String>,
        timeout: Duration,
    ) -> Result<Value, String> {
        validate_request(task_kind, request)?;
        let workspace = workspace
            .canonicalize()
            .map_err(|error| format!("resolve LSP workspace: {error}"))?;
        let file = workspace
            .join(&request.path)
            .canonicalize()
            .map_err(|error| format!("resolve LSP source: {error}"))?;
        if !file.starts_with(&workspace) || file == workspace {
            return Err("LSP source file must stay inside the task workspace".into());
        }
        let source =
            std::fs::read_to_string(&file).map_err(|error| format!("read LSP source: {error}"))?;
        if source.len() > 1024 * 1024 {
            return Err("LSP source file exceeds the 1 MiB model-facing limit".into());
        }
        let method = lsp_method(&request.operation)?;
        let uri = file_uri(&file);
        let position = serde_json::json!({
            "line": request.line.unwrap_or(1).saturating_sub(1),
            "character": request.character.unwrap_or(1).saturating_sub(1),
        });
        let params = match request.operation.as_str() {
            "documentSymbols" => serde_json::json!({"textDocument": {"uri": uri}}),
            "references" => serde_json::json!({
                "textDocument": {"uri": uri}, "position": position,
                "context": {"includeDeclaration": true}
            }),
            _ => serde_json::json!({"textDocument": {"uri": uri}, "position": position}),
        };
        let work = self.work.start_process(&StartProcess {
            task_id: task_id.into(),
            run_id: run_id.into(),
            kind: WorkKind::Lsp,
            component_id: Some("rust-lsp".into()),
            executable,
            args,
            environment: Default::default(),
            cwd: workspace.to_string_lossy().into_owned(),
            timeout_ms: timeout.as_millis().min(u64::MAX as u128) as u64,
        })?;
        let deadline = std::time::Instant::now() + timeout;
        let request_result = async {
            self.write_lsp_messages(
                &work.id,
                &[serde_json::json!({
                    "jsonrpc": "2.0", "id": 1, "method": "initialize",
                    "params": {"processId": std::process::id(), "rootUri": file_uri(&workspace), "capabilities": {}, "clientInfo": {"name": "Picode", "version": "2"}}
                })],
            )?;
            let initialized = self.wait_lsp_response(&work.id, 1, deadline).await?;
            if let Some(error) = initialized.get("error") {
                return Err(format!("LSP initialize failed: {error}"));
            }
            self.write_lsp_messages(
                &work.id,
                &[
                    serde_json::json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}),
                    serde_json::json!({
                        "jsonrpc": "2.0", "method": "textDocument/didOpen",
                        "params": {"textDocument": {"uri": uri, "languageId": request.language, "version": 1, "text": source}}
                    }),
                    serde_json::json!({"jsonrpc": "2.0", "id": 2, "method": method, "params": params}),
                ],
            )?;
            let response = self.wait_lsp_response(&work.id, 2, deadline).await?;
            if let Some(error) = response.get("error") {
                return Err(format!("LSP request failed: {error}"));
            }
            Ok(serde_json::json!({
                "result": response.get("result").cloned().unwrap_or(Value::Null),
                "language": request.language,
                "operation": request.operation,
                "path": request.path,
            }))
        }
        .await;
        if self.work.status(&work.id)?.status == WorkStatus::Running {
            let _ = self.work.cancel(&work.id);
        }
        request_result
    }

    fn write_lsp_messages(&self, work_id: &str, messages: &[Value]) -> Result<(), String> {
        let mut input = Vec::new();
        for message in messages {
            input.extend(encode_lsp_frame(message)?);
        }
        for chunk in input.chunks(32 * 1024) {
            self.work.write_stdin(work_id, chunk)?;
        }
        Ok(())
    }

    async fn wait_lsp_response(
        &self,
        work_id: &str,
        expected_id: u64,
        deadline: std::time::Instant,
    ) -> Result<Value, String> {
        loop {
            let current = self.work.status(work_id)?;
            if let Some(response) = lsp_response(&current.bounded_output, expected_id)? {
                return Ok(response);
            }
            if current.status != WorkStatus::Running {
                return Err(current
                    .termination_result
                    .unwrap_or_else(|| "LSP process exited before returning a response".into()));
            }
            if std::time::Instant::now() >= deadline {
                return Err("LSP request timed out".into());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

fn language_server(language: &str) -> Result<(String, Vec<String>), String> {
    match language {
        "rust" => Ok(("rust-analyzer".into(), Vec::new())),
        "typescript" | "javascript" => {
            Ok(("typescript-language-server".into(), vec!["--stdio".into()]))
        }
        "python" => Ok(("pyright-langserver".into(), vec!["--stdio".into()])),
        "csharp" => Ok(("csharp-ls".into(), Vec::new())),
        "cpp" | "c" => Ok(("clangd".into(), Vec::new())),
        _ => Err(format!(
            "No Picode LSP adapter is configured for {language}"
        )),
    }
}

fn lsp_method(operation: &str) -> Result<&'static str, String> {
    match operation {
        "hover" => Ok("textDocument/hover"),
        "definition" => Ok("textDocument/definition"),
        "references" => Ok("textDocument/references"),
        "documentSymbols" => Ok("textDocument/documentSymbol"),
        _ => Err(format!("Unsupported LSP operation: {operation}")),
    }
}

fn file_uri(path: &Path) -> String {
    let value = path
        .to_string_lossy()
        .replace('\\', "/")
        .replace(' ', "%20");
    if value.starts_with('/') {
        format!("file://{value}")
    } else {
        format!("file:///{value}")
    }
}

fn lsp_response(bytes: &[u8], expected_id: u64) -> Result<Option<Value>, String> {
    let mut offset = 0;
    while offset < bytes.len() {
        let remaining = &bytes[offset..];
        let Some(header_start) = remaining
            .windows("Content-Length:".len())
            .position(|window| window.eq_ignore_ascii_case(b"Content-Length:"))
        else {
            return Ok(None);
        };
        let frame = &remaining[header_start..];
        let Some(header_end) = frame.windows(4).position(|window| window == b"\r\n\r\n") else {
            return Ok(None);
        };
        let header = std::str::from_utf8(&frame[..header_end])
            .map_err(|_| "LSP response header is not UTF-8".to_owned())?;
        let length = header
            .lines()
            .find_map(|line| line.split_once(':').map(|(_, value)| value.trim()))
            .and_then(|value| value.parse::<usize>().ok())
            .ok_or_else(|| "LSP response has invalid Content-Length".to_owned())?;
        if length > 4 * 1024 * 1024 {
            return Err("LSP response exceeds 4 MiB".into());
        }
        let body_start = header_end + 4;
        let body_end = body_start + length;
        if frame.len() < body_end {
            return Ok(None);
        }
        let response: Value = serde_json::from_slice(&frame[body_start..body_end])
            .map_err(|error| format!("LSP returned invalid JSON: {error}"))?;
        if response.get("id").and_then(Value::as_u64) == Some(expected_id) {
            return Ok(Some(response));
        }
        offset += header_start + body_end;
    }
    Ok(None)
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
    use super::{validate_request, CodeIntelligence, CodeLspRequest};
    use crate::capability_service::{read_lsp_frame, write_lsp_frame, CapabilityService};
    use crate::execution::TaskKind;
    use crate::orchestration_service::OrchestrationService;
    use crate::work_manager::{WorkKind, WorkManager, WorkStatus};
    use std::sync::{Arc, Mutex};

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

    #[test]
    #[ignore]
    fn lsp_protocol_fixture() {
        let stdin = std::io::stdin();
        let mut input = stdin.lock();
        let stdout = std::io::stdout();
        let mut output = stdout.lock();
        loop {
            let request = read_lsp_frame(&mut input, 2 * 1024 * 1024).expect("read LSP request");
            if request.get("id").and_then(serde_json::Value::as_u64) == Some(1) {
                write_lsp_frame(
                    &mut output,
                    &serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": 1,
                        "result": {"capabilities": {}}
                    }),
                )
                .expect("write LSP initialize response");
            }
            if request.get("id").and_then(serde_json::Value::as_u64) == Some(2) {
                write_lsp_frame(
                    &mut output,
                    &serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": 2,
                        "result": {"contents": "fixture hover"}
                    }),
                )
                .expect("write LSP response");
                return;
            }
        }
    }

    #[tokio::test]
    async fn lsp_protocol_requests_run_through_work_manager() {
        let root =
            std::env::temp_dir().join(format!("picode-code-intelligence-{}", uuid::Uuid::new_v4()));
        let workspace = root.join("workspace");
        std::fs::create_dir_all(workspace.join("src")).unwrap();
        std::fs::write(workspace.join("src/main.rs"), "fn main() {}\n").unwrap();
        let capability = Arc::new(Mutex::new(
            CapabilityService::open(&root.join("capabilities")).unwrap(),
        ));
        let work = Arc::new(WorkManager::new(Arc::new(
            OrchestrationService::open(&root.join("jobs"), 4 * 1024 * 1024).unwrap(),
        )));
        let code = CodeIntelligence::new(capability, work.clone());
        let request = CodeLspRequest {
            language: "rust".into(),
            operation: "hover".into(),
            path: "src/main.rs".into(),
            line: Some(1),
            character: Some(1),
        };
        let response = code
            .request_lsp_with_server(
                "task-a",
                "run-a",
                &workspace,
                TaskKind::Harness,
                &request,
                std::env::current_exe()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                vec![
                    "--ignored".into(),
                    "--exact".into(),
                    "code_intelligence::tests::lsp_protocol_fixture".into(),
                    "--nocapture".into(),
                ],
                std::time::Duration::from_secs(5),
            )
            .await
            .unwrap();

        assert_eq!(response["result"]["contents"], "fixture hover");
        let snapshot = work.snapshot().unwrap();
        let handle = snapshot
            .iter()
            .find(|item| item.component_id.as_deref() == Some("rust-lsp"))
            .unwrap();
        assert_eq!(handle.kind, WorkKind::Lsp);
        assert_ne!(handle.status, WorkStatus::Running);
        drop(snapshot);
        drop(code);
        drop(work);
        let mut removed = false;
        for _ in 0..20 {
            match std::fs::remove_dir_all(&root) {
                Ok(()) => {
                    removed = true;
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(error) => panic!("remove LSP protocol fixture: {error}"),
            }
        }
        assert!(removed, "LSP protocol fixture artifacts remained busy");
    }
}
