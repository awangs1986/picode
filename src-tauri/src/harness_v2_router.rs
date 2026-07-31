use crate::acp_adapter::{AcpAdapter, AcpRuntimeAction};
use crate::broker_ws::BrokerWs;
use crate::code_intelligence::{CodeIntelligence, CodeLspRequest};
use crate::completion_engine::{CompletionEngine, CompletionRequest};
use crate::context_engine::{ContextEngine, ContextItem};
use crate::delegation_engine::{DelegationEngine, DelegationOptions};
use crate::extension_manager::ExtensionManager;
use crate::guidance_policy::{GuidancePolicy, GuidanceRequest};
use crate::hook_manager::{HookConfig, HookManager};
use crate::orchestration::{DelegatedWork, RoutingEvaluations, SubagentModelPolicy};
use crate::pi_manager::PiManager;
use crate::runtime_coordinator::RuntimeTarget;
use crate::runtime_spine::RuntimeSpine;
use crate::task_control::TaskControl;
use crate::work_manager::WorkManager;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub struct HarnessV2Router<'a> {
    pub manager: &'a Arc<PiManager>,
    pub broker: &'a Arc<BrokerWs>,
    pub task_control: &'a Arc<Mutex<TaskControl>>,
    pub spine: &'a Arc<Mutex<RuntimeSpine>>,
    pub acp: &'a Arc<AcpAdapter>,
    pub work: &'a Arc<WorkManager>,
    pub context: &'a Arc<ContextEngine>,
    pub code: &'a Arc<CodeIntelligence>,
    pub hooks: &'a Arc<HookManager>,
    pub extensions: &'a Arc<ExtensionManager>,
}

impl HarnessV2Router<'_> {
    pub fn owns(command: &str) -> bool {
        matches!(
            command,
            "acp_request"
                | "runtime_spine_events"
                | "runtime_spine_state"
                | "work_snapshot"
                | "work_status"
                | "work_wait"
                | "work_cancel"
                | "context_v2_prepare"
                | "context_v2_store_artifact"
                | "context_v2_fetch_artifact"
                | "completion_evaluate"
                | "code_lsp_request"
                | "delegation_plan"
                | "hook_list"
                | "hook_install"
                | "hook_set_enabled"
                | "hook_set_trusted"
                | "hook_invoke"
                | "guidance_decide"
        )
    }

    pub async fn handle(
        &self,
        command: &str,
        args: &Value,
        local_client: bool,
    ) -> Option<Result<Value, String>> {
        if !Self::owns(command) {
            return None;
        }
        if !local_client {
            return Some(Err(
                "This control is available only from the local desktop app".to_owned(),
            ));
        }
        Some(self.handle_owned(command, args).await)
    }

    async fn handle_owned(&self, command: &str, args: &Value) -> Result<Value, String> {
        let arg_str = |key: &str| args.get(key).and_then(Value::as_str).map(str::to_owned);
        let arg_bool = |key: &str| args.get(key).and_then(Value::as_bool);
        match command {
            "acp_request" => {
                let request = args.get("request").ok_or("request is required")?;
                let source_port = args
                    .get("sourcePort")
                    .and_then(Value::as_u64)
                    .and_then(|port| u16::try_from(port).ok());
                let response = self.acp.handle(request, crate::unix_millis())?;
                for action in &response.actions {
                    let port = crate::resolve_control_port(source_port, self.broker)?;
                    match action {
                        AcpRuntimeAction::Prompt {
                            session_id,
                            request_id,
                            message,
                        } => {
                            self.broker.send_command_to_port(
                                port,
                                serde_json::json!({
                                    "type": "prompt",
                                    "message": message,
                                    "sessionId": session_id,
                                    "requestId": request_id,
                                }),
                            )?;
                            self.acp.acknowledge_prompt_delivery(
                                session_id,
                                request_id,
                                crate::unix_millis(),
                            )?;
                        }
                        AcpRuntimeAction::Cancel { .. } => self
                            .manager
                            .send_rpc(port, serde_json::json!({ "type": "abort" }))?,
                    }
                }
                encode(response, "ACP response")
            }
            "runtime_spine_events" => {
                let target: RuntimeTarget = decode_required(args, "target", "runtime target")?;
                let cursor = args.get("cursor").and_then(Value::as_u64).unwrap_or(0);
                let events = self
                    .spine
                    .lock()
                    .map_err(|_| "Runtime Spine lock is poisoned".to_owned())?
                    .events_after(&target, cursor)
                    .map_err(|error| format!("Cannot replay runtime events: {error:?}"))?;
                encode(events, "runtime events")
            }
            "runtime_spine_state" => {
                let target: RuntimeTarget = decode_required(args, "target", "runtime target")?;
                let state = self
                    .spine
                    .lock()
                    .map_err(|_| "Runtime Spine lock is poisoned".to_owned())?
                    .session_state(&target)
                    .map_err(|error| format!("Cannot read runtime state: {error:?}"))?;
                encode(state, "runtime state")
            }
            "work_snapshot" => encode(self.work.snapshot()?, "work snapshot"),
            "work_status" => encode(
                self.work
                    .status(&arg_str("workId").ok_or("workId is required")?)?,
                "work status",
            ),
            "work_wait" => {
                let id = arg_str("workId").ok_or("workId is required")?;
                let timeout = args
                    .get("timeoutMs")
                    .and_then(Value::as_u64)
                    .unwrap_or(30_000)
                    .min(60_000);
                encode(
                    self.work.wait(&id, Duration::from_millis(timeout))?,
                    "work result",
                )
            }
            "work_cancel" => encode(
                self.work
                    .cancel(&arg_str("workId").ok_or("workId is required")?)?,
                "work cancellation",
            ),
            "context_v2_prepare" => {
                let items: Vec<ContextItem> = decode_required(args, "items", "context items")?;
                let budget = args
                    .get("budget")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok())
                    .ok_or("budget is required")?;
                encode(self.context.prepare_turn(&items, budget)?, "context plan")
            }
            "context_v2_store_artifact" => {
                let content = arg_str("content").ok_or("content is required")?;
                let secrets = args
                    .get("declaredSecrets")
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                encode(self.context.store_artifact(&content, &secrets)?, "artifact")
            }
            "context_v2_fetch_artifact" => {
                let id = arg_str("id").ok_or("id is required")?;
                Ok(serde_json::json!({
                    "id": id,
                    "content": self.context.fetch_artifact(&id)?,
                }))
            }
            "completion_evaluate" => {
                let request: CompletionRequest =
                    decode_required(args, "request", "completion request")?;
                encode(
                    CompletionEngine::evaluate_request(&request),
                    "completion decision",
                )
            }
            "code_lsp_request" => {
                self.extensions.authorize_catalog_component("rust-lsp")?;
                let task_id = arg_str("taskId").ok_or("taskId is required")?;
                let request: CodeLspRequest = decode_required(args, "request", "LSP request")?;
                let kind = self
                    .task_control
                    .lock()
                    .map_err(|_| "Task Control lock is poisoned".to_owned())?
                    .task_kind(&task_id)?;
                let workspace = self
                    .task_control
                    .lock()
                    .map_err(|_| "Task Control lock is poisoned".to_owned())?
                    .task_working_dir(&task_id)?;
                let run_id = arg_str("agentRunId").unwrap_or_else(|| format!("lsp:{task_id}"));
                self.code
                    .request_lsp(&task_id, &run_id, &workspace, kind, &request)
                    .await
            }
            "delegation_plan" => {
                let work: DelegatedWork = decode_required(args, "work", "delegated work")?;
                let policy: SubagentModelPolicy = decode_required(args, "policy", "model policy")?;
                let qualified = args
                    .get("qualifiedModels")
                    .and_then(Value::as_array)
                    .ok_or("qualifiedModels must be an array")?
                    .iter()
                    .map(|value| {
                        value
                            .as_str()
                            .map(str::to_owned)
                            .ok_or("every qualified model must be a string")
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let options: DelegationOptions =
                    decode_required(args, "options", "delegation options")?;
                let evaluations = RoutingEvaluations::from_qualified(&work.class, &qualified);
                encode(
                    DelegationEngine::plan_with_options(&work, &policy, &evaluations, &options)?,
                    "delegation plan",
                )
            }
            "guidance_decide" => {
                let request: GuidanceRequest =
                    decode_required(args, "request", "guidance request")?;
                encode(GuidancePolicy::decide(&request), "guidance decision")
            }
            "hook_list" => encode(self.hooks.list()?, "hooks"),
            "hook_install" => {
                let config: HookConfig = decode_required(args, "config", "hook config")?;
                self.hooks.install(config)?;
                Ok(Value::Null)
            }
            "hook_set_enabled" => {
                self.hooks.set_enabled(
                    &arg_str("id").ok_or("id is required")?,
                    arg_bool("enabled").ok_or("enabled is required")?,
                )?;
                Ok(Value::Null)
            }
            "hook_set_trusted" => {
                self.hooks.set_trusted(
                    &arg_str("id").ok_or("id is required")?,
                    arg_bool("trusted").ok_or("trusted is required")?,
                )?;
                Ok(Value::Null)
            }
            "hook_invoke" => encode(
                self.hooks.invoke(
                    &arg_str("event").ok_or("event is required")?,
                    &arg_str("taskId").ok_or("taskId is required")?,
                    &arg_str("runId").ok_or("runId is required")?,
                )?,
                "hook outcomes",
            ),
            _ => unreachable!("owned commands are exhaustive"),
        }
    }
}

fn decode_required<T: serde::de::DeserializeOwned>(
    args: &Value,
    key: &str,
    label: &str,
) -> Result<T, String> {
    serde_json::from_value(
        args.get(key)
            .cloned()
            .ok_or_else(|| format!("{key} is required"))?,
    )
    .map_err(|error| format!("Invalid {label}: {error}"))
}

fn encode(value: impl serde::Serialize, label: &str) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| format!("Cannot encode {label}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::HarnessV2Router;

    #[test]
    fn router_owns_the_harness_v2_surface_but_not_account_commands() {
        assert!(HarnessV2Router::owns("runtime_spine_events"));
        assert!(HarnessV2Router::owns("runtime_spine_state"));
        assert!(!HarnessV2Router::owns("runtime_spine_record"));
        assert!(HarnessV2Router::owns("code_lsp_request"));
        assert!(HarnessV2Router::owns("guidance_decide"));
        assert!(!HarnessV2Router::owns("account_list"));
    }
}
