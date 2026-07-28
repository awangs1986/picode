use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PromptBindingDecision {
    pub allowed: bool,
    pub rebound: bool,
    pub requires_continue: bool,
    pub logical_provider: Option<String>,
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionBinding {
    logical_provider: String,
    account_id: String,
    state: String,
}

pub struct AccountBindingStore {
    connection: Mutex<Connection>,
    #[cfg(unix)]
    path: std::path::PathBuf,
}

impl AccountBindingStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Cannot create account-binding directory {}: {error}",
                    parent.display()
                )
            })?;
        }
        let connection = Connection::open(path).map_err(|error| {
            format!(
                "Cannot open account-binding database {}: {error}",
                path.display()
            )
        })?;
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS session_account_bindings (
                    session_id TEXT PRIMARY KEY,
                    logical_provider TEXT NOT NULL,
                    pi_provider TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    state TEXT NOT NULL CHECK(state IN ('active', 'suspended')),
                    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
                );
                CREATE INDEX IF NOT EXISTS session_account_bindings_account
                    ON session_account_bindings(logical_provider, account_id, state);",
            )
            .map_err(|error| format!("Cannot initialize account-binding database: {error}"))?;
        let store = Self {
            connection: Mutex::new(connection),
            #[cfg(unix)]
            path: path.to_path_buf(),
        };
        store.restrict_permissions()?;
        Ok(store)
    }

    #[cfg(unix)]
    fn restrict_permissions(&self) -> Result<(), String> {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600)).map_err(
            |error| {
                format!(
                    "Cannot restrict account-binding permissions {}: {error}",
                    self.path.display()
                )
            },
        )
    }

    #[cfg(not(unix))]
    fn restrict_permissions(&self) -> Result<(), String> {
        Ok(())
    }

    pub fn prepare_prompt(
        &self,
        session_id: &str,
        pi_provider: &str,
        active_account: Option<(&str, &str)>,
        user_confirmed_continue: bool,
    ) -> Result<PromptBindingDecision, String> {
        let session_id = session_id.trim();
        if session_id.is_empty() || session_id.len() > 4096 {
            return Err("A valid chat session is required for account binding".to_string());
        }
        // Chats using pre-existing/custom Pi credentials are bound too. This
        // prevents a later managed-account import from silently taking over an
        // older conversation; that transition still requires “继续”.
        let external_provider = format!("external:{pi_provider}");
        let external_account = format!("unmanaged:{pi_provider}");
        let (logical_provider, active_account_id) =
            active_account.unwrap_or((external_provider.as_str(), external_account.as_str()));
        let connection = self
            .connection
            .lock()
            .map_err(|_| "The account-binding database lock is poisoned".to_string())?;
        let existing = connection
            .query_row(
                "SELECT logical_provider, account_id, state
                 FROM session_account_bindings WHERE session_id = ?1",
                [session_id],
                |row| {
                    Ok(SessionBinding {
                        logical_provider: row.get(0)?,
                        account_id: row.get(1)?,
                        state: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(|error| format!("Cannot read chat account binding: {error}"))?;

        if existing.is_none() {
            connection
                .execute(
                    "INSERT INTO session_account_bindings
                     (session_id, logical_provider, pi_provider, account_id, state)
                     VALUES (?1, ?2, ?3, ?4, 'active')",
                    params![session_id, logical_provider, pi_provider, active_account_id],
                )
                .map_err(|error| format!("Cannot bind chat to account: {error}"))?;
            return Ok(PromptBindingDecision {
                allowed: true,
                rebound: false,
                requires_continue: false,
                logical_provider: Some(logical_provider.to_string()),
                account_id: Some(active_account_id.to_string()),
            });
        }

        let existing = existing.expect("checked above");
        if existing.logical_provider == logical_provider
            && existing.account_id == active_account_id
            && existing.state == "active"
        {
            return Ok(PromptBindingDecision {
                allowed: true,
                rebound: false,
                requires_continue: false,
                logical_provider: Some(logical_provider.to_string()),
                account_id: Some(active_account_id.to_string()),
            });
        }
        if !user_confirmed_continue {
            return Ok(PromptBindingDecision {
                allowed: false,
                rebound: false,
                requires_continue: true,
                logical_provider: Some(logical_provider.to_string()),
                account_id: Some(active_account_id.to_string()),
            });
        }

        connection
            .execute(
                "UPDATE session_account_bindings
                 SET logical_provider = ?2, pi_provider = ?3, account_id = ?4,
                     state = 'active', updated_at = unixepoch()
                 WHERE session_id = ?1",
                params![session_id, logical_provider, pi_provider, active_account_id],
            )
            .map_err(|error| format!("Cannot continue chat with the active account: {error}"))?;
        Ok(PromptBindingDecision {
            allowed: true,
            rebound: true,
            requires_continue: false,
            logical_provider: Some(logical_provider.to_string()),
            account_id: Some(active_account_id.to_string()),
        })
    }

    pub fn suspend_account(
        &self,
        logical_provider: &str,
        account_id: &str,
    ) -> Result<Vec<String>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "The account-binding database lock is poisoned".to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT session_id FROM session_account_bindings
                 WHERE logical_provider = ?1 AND account_id = ?2 AND state = 'active'",
            )
            .map_err(|error| format!("Cannot inspect active account chats: {error}"))?;
        let session_ids = statement
            .query_map(params![logical_provider, account_id], |row| row.get(0))
            .map_err(|error| format!("Cannot query active account chats: {error}"))?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|error| format!("Cannot read active account chats: {error}"))?;
        drop(statement);
        connection
            .execute(
                "UPDATE session_account_bindings
                 SET state = 'suspended', updated_at = unixepoch()
                 WHERE logical_provider = ?1 AND account_id = ?2 AND state = 'active'",
                params![logical_provider, account_id],
            )
            .map_err(|error| format!("Cannot suspend account chats: {error}"))?;
        Ok(session_ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn store() -> (std::path::PathBuf, AccountBindingStore) {
        let root = std::env::temp_dir().join(format!("picot-bindings-{}", Uuid::new_v4()));
        let store = AccountBindingStore::open(&root.join("bindings.sqlite3")).unwrap();
        (root, store)
    }

    #[test]
    fn switching_accounts_requires_an_explicit_continue_before_rebinding() {
        let (root, store) = store();
        let first = store
            .prepare_prompt(
                "session-a",
                "openai-codex",
                Some(("codex", "account-a")),
                false,
            )
            .unwrap();
        assert!(first.allowed);

        let blocked = store
            .prepare_prompt(
                "session-a",
                "openai-codex",
                Some(("codex", "account-b")),
                false,
            )
            .unwrap();
        assert!(!blocked.allowed);
        assert!(blocked.requires_continue);

        let continued = store
            .prepare_prompt(
                "session-a",
                "openai-codex",
                Some(("codex", "account-b")),
                true,
            )
            .unwrap();
        assert!(continued.allowed);
        assert!(continued.rebound);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn suspending_one_provider_does_not_affect_other_provider_chats() {
        let (root, store) = store();
        store
            .prepare_prompt(
                "codex-chat",
                "openai-codex",
                Some(("codex", "codex-a")),
                false,
            )
            .unwrap();
        store
            .prepare_prompt(
                "claude-chat",
                "anthropic",
                Some(("claude", "claude-a")),
                false,
            )
            .unwrap();

        assert_eq!(
            store.suspend_account("codex", "codex-a").unwrap(),
            vec!["codex-chat".to_string()]
        );
        let claude = store
            .prepare_prompt(
                "claude-chat",
                "anthropic",
                Some(("claude", "claude-a")),
                false,
            )
            .unwrap();
        assert!(claude.allowed);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_managed_import_does_not_silently_take_over_an_external_chat() {
        let (root, store) = store();
        assert!(
            store
                .prepare_prompt("legacy-chat", "openai-codex", None, false)
                .unwrap()
                .allowed
        );

        let decision = store
            .prepare_prompt(
                "legacy-chat",
                "openai-codex",
                Some(("codex", "imported-account")),
                false,
            )
            .unwrap();
        assert!(!decision.allowed);
        assert!(decision.requires_continue);
        let _ = std::fs::remove_dir_all(root);
    }
}
