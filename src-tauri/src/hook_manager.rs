#![cfg_attr(not(test), allow(dead_code))]

use crate::work_manager::{StartCommand, WorkManager, WorkStatus};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookConfig {
    pub id: String,
    pub event: String,
    pub executable: String,
    #[serde(default)]
    pub arguments: Vec<String>,
    pub cwd: String,
    pub timeout_ms: u64,
    #[serde(default)]
    pub fail_open: bool,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub trusted: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HookState {
    Skipped,
    Passed,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookOutcome {
    pub hook_id: String,
    pub state: HookState,
    pub work_id: Option<String>,
    pub verification_allowed: bool,
    pub message: String,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HookStateFile {
    schema_version: u32,
    hooks: BTreeMap<String, HookConfig>,
}

pub struct HookManager {
    root: PathBuf,
    state: Mutex<HookStateFile>,
    work: Arc<WorkManager>,
}

impl HookManager {
    pub fn open(root: &Path, work: Arc<WorkManager>) -> Result<Self, String> {
        fs::create_dir_all(root).map_err(|error| format!("create hook store: {error}"))?;
        let path = root.join("state.json");
        let state = if path.exists() {
            serde_json::from_slice(
                &fs::read(&path).map_err(|error| format!("read hooks: {error}"))?,
            )
            .map_err(|error| format!("parse hooks: {error}"))?
        } else {
            HookStateFile {
                schema_version: 1,
                hooks: BTreeMap::new(),
            }
        };
        if state.schema_version != 1 {
            return Err("unsupported hook state schema".to_owned());
        }
        let manager = Self {
            root: root.to_owned(),
            state: Mutex::new(state),
            work,
        };
        manager.persist()?;
        Ok(manager)
    }

    pub fn install(&self, mut config: HookConfig) -> Result<(), String> {
        if config.id.trim().is_empty()
            || config.event.trim().is_empty()
            || config.executable.trim().is_empty()
            || config.timeout_ms == 0
            || config.timeout_ms > 60_000
        {
            return Err(
                "hook identity, event, executable, and bounded timeout are required".to_owned(),
            );
        }
        config.enabled = false;
        config.trusted = false;
        let mut state = self.state.lock().map_err(lock_error)?;
        if state.hooks.insert(config.id.clone(), config).is_some() {
            return Err("hook already exists".to_owned());
        }
        drop(state);
        self.persist()
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        let mut state = self.state.lock().map_err(lock_error)?;
        state
            .hooks
            .get_mut(id)
            .ok_or_else(|| "hook is not installed".to_owned())?
            .enabled = enabled;
        drop(state);
        self.persist()
    }

    pub fn set_trusted(&self, id: &str, trusted: bool) -> Result<(), String> {
        let mut state = self.state.lock().map_err(lock_error)?;
        let hook = state
            .hooks
            .get_mut(id)
            .ok_or_else(|| "hook is not installed".to_owned())?;
        if !hook.enabled {
            return Err("enable the hook before changing trust".to_owned());
        }
        hook.trusted = trusted;
        drop(state);
        self.persist()
    }

    pub fn invoke(
        &self,
        event: &str,
        task_id: &str,
        run_id: &str,
    ) -> Result<Vec<HookOutcome>, String> {
        let hooks = self
            .state
            .lock()
            .map_err(lock_error)?
            .hooks
            .values()
            .filter(|hook| hook.event == event)
            .cloned()
            .collect::<Vec<_>>();
        let mut outcomes = Vec::new();
        for hook in hooks {
            if !hook.enabled {
                outcomes.push(HookOutcome {
                    hook_id: hook.id,
                    state: HookState::Skipped,
                    work_id: None,
                    verification_allowed: false,
                    message: "hook is disabled".into(),
                });
                continue;
            }
            if !hook.trusted {
                outcomes.push(HookOutcome {
                    hook_id: hook.id,
                    state: HookState::Failed,
                    work_id: None,
                    verification_allowed: false,
                    message: "hook is not trusted".into(),
                });
                continue;
            }
            let work = self.work.start_command(&StartCommand {
                task_id: task_id.to_owned(),
                run_id: run_id.to_owned(),
                executable: hook.executable,
                args: hook.arguments,
                cwd: hook.cwd,
                timeout_ms: hook.timeout_ms,
            })?;
            let finished = self.work.wait(
                &work.id,
                Duration::from_millis(hook.timeout_ms.saturating_add(100)),
            )?;
            let passed = finished.status == WorkStatus::Completed;
            outcomes.push(HookOutcome {
                hook_id: hook.id,
                state: if passed {
                    HookState::Passed
                } else {
                    HookState::Failed
                },
                work_id: Some(work.id),
                verification_allowed: passed,
                message: if passed {
                    "hook completed".into()
                } else if hook.fail_open {
                    "hook failed; workflow may continue but verification is blocked".into()
                } else {
                    "hook failed".into()
                },
            });
        }
        Ok(outcomes)
    }

    pub fn list(&self) -> Result<Vec<HookConfig>, String> {
        Ok(self
            .state
            .lock()
            .map_err(lock_error)?
            .hooks
            .values()
            .cloned()
            .collect())
    }

    fn persist(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(&*self.state.lock().map_err(lock_error)?)
            .map_err(|error| format!("encode hooks: {error}"))?;
        let temporary = self.root.join(".state.json.tmp");
        fs::write(&temporary, bytes).map_err(|error| format!("write hooks: {error}"))?;
        fs::rename(&temporary, self.root.join("state.json"))
            .map_err(|error| format!("publish hooks: {error}"))
    }
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> String {
    "Hook Manager lock is poisoned".to_owned()
}

#[cfg(test)]
mod tests {
    use super::{HookConfig, HookManager, HookState};
    use crate::orchestration_service::OrchestrationService;
    use crate::work_manager::WorkManager;
    use std::fs;
    use std::sync::Arc;

    #[test]
    #[ignore]
    fn failing_hook_fixture() {
        panic!("controlled hook failure");
    }

    #[test]
    fn disabled_and_untrusted_hooks_are_zero_process_and_fail_open_never_verifies() {
        let root = std::env::temp_dir().join(format!("picode-hooks-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let orchestration = Arc::new(OrchestrationService::open(&root.join("jobs"), 1024).unwrap());
        let work = Arc::new(WorkManager::new(orchestration));
        let hooks = HookManager::open(&root.join("hooks"), work.clone()).unwrap();
        hooks
            .install(HookConfig {
                id: "stop-check".into(),
                event: "before_complete".into(),
                executable: std::env::current_exe()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                arguments: vec![
                    "--ignored".into(),
                    "--exact".into(),
                    "hook_manager::tests::failing_hook_fixture".into(),
                    "--nocapture".into(),
                ],
                cwd: root.to_string_lossy().into_owned(),
                timeout_ms: 5_000,
                fail_open: true,
                enabled: true,
                trusted: true,
            })
            .unwrap();
        assert!(work.snapshot().unwrap().is_empty());
        hooks.set_enabled("stop-check", true).unwrap();
        let untrusted = hooks.invoke("before_complete", "task-a", "run-a").unwrap();
        assert_eq!(untrusted[0].state, HookState::Failed);
        assert!(!untrusted[0].verification_allowed);
        hooks.set_trusted("stop-check", true).unwrap();
        let failed = hooks.invoke("before_complete", "task-a", "run-a").unwrap();
        assert_eq!(failed[0].state, HookState::Failed);
        assert!(!failed[0].verification_allowed);
        assert!(failed[0].message.contains("verification is blocked"));
        drop(hooks);
        drop(work);
        fs::remove_dir_all(root).unwrap();
    }
}
