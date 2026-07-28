use crate::account_vault::{AccountSummary, AccountVault, StoredAccount};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const PREVIEW_TTL_MS: u64 = 10 * 60 * 1000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCandidateSummary {
    pub candidate_id: String,
    pub provider: String,
    pub pi_provider: String,
    pub label: String,
    pub email: Option<String>,
    pub auth_kind: String,
    pub chat_compatible: bool,
    pub endpoint: Option<Value>,
    pub warnings: Vec<String>,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub preview_id: String,
    pub provider: String,
    pub candidates: Vec<ImportCandidateSummary>,
    pub warnings: Vec<String>,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportApplyResult {
    pub provider: String,
    pub imported_ids: Vec<String>,
    pub active_account_id: Option<String>,
    pub active_pi_provider: Option<String>,
    pub deactivated_pi_providers: Vec<String>,
    pub accounts: Vec<AccountSummary>,
    #[serde(skip_serializing)]
    pub previous_active_account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountActivationResult {
    pub provider: String,
    pub active_account_id: String,
    pub active_pi_provider: String,
    pub deactivated_pi_providers: Vec<String>,
    pub accounts: Vec<AccountSummary>,
    #[serde(skip_serializing)]
    pub previous_active_account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountDeactivationResult {
    pub provider: String,
    pub deactivated_account_id: String,
    pub deactivated_pi_provider: String,
    pub accounts: Vec<AccountSummary>,
}

#[derive(Clone)]
struct ParsedCandidate {
    summary: ImportCandidateSummary,
    account: StoredAccount,
}

struct PendingPreview {
    provider: String,
    candidates: Vec<ParsedCandidate>,
    expires_at: u64,
}

pub struct AccountImportService {
    vault: Arc<AccountVault>,
    pending: Mutex<HashMap<String, PendingPreview>>,
}

impl AccountImportService {
    pub fn new(vault: Arc<AccountVault>) -> Self {
        Self {
            vault,
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub fn list_accounts(&self) -> Result<Vec<AccountSummary>, String> {
        Ok(self.vault.load()?.summaries())
    }

    pub fn active_account(&self, provider: &str) -> Result<Option<StoredAccount>, String> {
        Ok(self.vault.load()?.active_account(provider).cloned())
    }

    pub fn active_account_for_pi_provider(
        &self,
        pi_provider: &str,
    ) -> Result<Option<StoredAccount>, String> {
        let document = self.vault.load()?;
        Ok(document
            .active_by_provider
            .iter()
            .filter_map(|(provider, account_id)| {
                document.accounts.iter().find(|account| {
                    &account.provider == provider
                        && &account.id == account_id
                        && account.pi_provider == pi_provider
                })
            })
            .next()
            .cloned())
    }

    pub fn restore_active_account(
        &self,
        provider: &str,
        account_id: Option<&str>,
    ) -> Result<(), String> {
        self.vault.update(|document| {
            if let Some(account_id) = account_id {
                let exists = document
                    .accounts
                    .iter()
                    .any(|account| account.provider == provider && account.id == account_id);
                if !exists {
                    return Err("The previous active account is no longer available".to_string());
                }
                document
                    .active_by_provider
                    .insert(provider.to_string(), account_id.to_string());
            } else {
                document.active_by_provider.remove(provider);
            }
            Ok(())
        })
    }

    pub fn activate_stored(&self, account_id: &str) -> Result<AccountActivationResult, String> {
        let current = self.vault.load()?;
        let account = current
            .accounts
            .iter()
            .find(|account| account.id == account_id)
            .cloned()
            .ok_or_else(|| "The selected stored account was not found".to_string())?;
        if !account.chat_compatible {
            return Err("This stored account cannot be activated for Pi chat".to_string());
        }
        let previous = current.active_account(&account.provider).cloned();
        let previous_active_account_id = previous.as_ref().map(|item| item.id.clone());
        let deactivated_pi_providers = previous
            .filter(|item| item.pi_provider != account.pi_provider)
            .map(|item| vec![item.pi_provider])
            .unwrap_or_default();
        let accounts = self.vault.update(|document| {
            document
                .active_by_provider
                .insert(account.provider.clone(), account.id.clone());
            Ok(document.summaries())
        })?;
        Ok(AccountActivationResult {
            provider: account.provider,
            active_account_id: account.id,
            active_pi_provider: account.pi_provider,
            deactivated_pi_providers,
            accounts,
            previous_active_account_id,
        })
    }

    pub fn deactivate_provider(&self, provider: &str) -> Result<AccountDeactivationResult, String> {
        let provider = normalize_provider(provider)?;
        let current = self.vault.load()?;
        let account = current
            .active_account(&provider)
            .cloned()
            .ok_or_else(|| format!("No active {provider} account was found"))?;
        let accounts = self.vault.update(|document| {
            document.active_by_provider.remove(&provider);
            Ok(document.summaries())
        })?;
        Ok(AccountDeactivationResult {
            provider,
            deactivated_account_id: account.id,
            deactivated_pi_provider: account.pi_provider,
            accounts,
        })
    }

    pub fn preview_local(&self, provider: &str) -> Result<ImportPreview, String> {
        let provider = normalize_provider(provider)?;
        let candidates = match provider.as_str() {
            "codex" => preview_local_codex()?,
            "cursor" => preview_local_cursor()?,
            "claude" => preview_local_claude()?,
            _ => return Err(format!("Local import is not supported for {provider}")),
        };
        self.create_preview(provider, candidates)
    }

    pub fn preview_json(
        &self,
        provider: &str,
        content: &str,
        source_name: Option<&str>,
    ) -> Result<ImportPreview, String> {
        if content.trim().is_empty() {
            return Err("The selected JSON file is empty".to_string());
        }
        let provider = normalize_provider(provider)?;
        let source = json!({
            "kind": "json",
            "name": source_name.unwrap_or("manual JSON import"),
        });
        let candidates = match provider.as_str() {
            "codex" => parse_codex_json(content, source)?,
            "cursor" => parse_cursor_json(content, source)?,
            "claude" => parse_claude_json(content, source)?,
            _ => return Err(format!("JSON import is not supported for {provider}")),
        };
        self.create_preview(provider, candidates)
    }

    fn create_preview(
        &self,
        provider: String,
        candidates: Vec<ParsedCandidate>,
    ) -> Result<ImportPreview, String> {
        if candidates.is_empty() {
            return Err(format!("No importable {provider} accounts were found"));
        }
        let now = now_ms();
        let expires_at = now.saturating_add(PREVIEW_TTL_MS);
        let preview_id = Uuid::new_v4().to_string();
        let mut warnings = Vec::new();
        let current = self.vault.load()?;
        if provider == "codex"
            && candidates
                .iter()
                .any(|candidate| candidate.account.auth_kind == "oauth")
            && current
                .active_account("codex")
                .is_some_and(|account| account.auth_kind == "api_key" && account.endpoint.is_some())
        {
            warnings.push(
                "Activating an official Codex OAuth account will keep the current reverse-proxy account but disable it."
                    .to_string(),
            );
        }
        let summaries = candidates
            .iter()
            .map(|candidate| candidate.summary.clone())
            .collect();
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "The account-import preview lock is poisoned".to_string())?;
        pending.retain(|_, preview| preview.expires_at > now);
        pending.insert(
            preview_id.clone(),
            PendingPreview {
                provider: provider.clone(),
                candidates,
                expires_at,
            },
        );
        Ok(ImportPreview {
            preview_id,
            provider,
            candidates: summaries,
            warnings,
            expires_at,
        })
    }

    pub fn apply(
        &self,
        preview_id: &str,
        candidate_ids: &[String],
        activate_candidate_id: Option<&str>,
    ) -> Result<ImportApplyResult, String> {
        if candidate_ids.is_empty() {
            return Err("Select at least one account to import".to_string());
        }
        let preview = self
            .pending
            .lock()
            .map_err(|_| "The account-import preview lock is poisoned".to_string())?
            .remove(preview_id)
            .ok_or_else(|| "The import preview has expired; preview the files again".to_string())?;
        if preview.expires_at <= now_ms() {
            return Err("The import preview has expired; preview the files again".to_string());
        }
        let selected_ids: HashSet<&str> = candidate_ids.iter().map(String::as_str).collect();
        let selected: Vec<ParsedCandidate> = preview
            .candidates
            .into_iter()
            .filter(|candidate| selected_ids.contains(candidate.summary.candidate_id.as_str()))
            .collect();
        if selected.len() != selected_ids.len() {
            return Err("The import selection does not match the preview".to_string());
        }
        let activate_id = activate_candidate_id.map(str::to_string).or_else(|| {
            (selected.len() == 1 && selected[0].account.chat_compatible)
                .then(|| selected[0].summary.candidate_id.clone())
        });
        if let Some(id) = activate_id.as_deref() {
            let Some(candidate) = selected
                .iter()
                .find(|candidate| candidate.summary.candidate_id == id)
            else {
                return Err("The account to activate was not selected for import".to_string());
            };
            if !candidate.account.chat_compatible {
                return Err(
                    "This account can be stored but cannot be activated for Pi chat".to_string(),
                );
            }
        }
        let provider = preview.provider;
        let previous_active = self.vault.load()?.active_account(&provider).cloned();
        let previous_active_account_id = previous_active.as_ref().map(|account| account.id.clone());
        let imported_ids: Vec<String> = selected
            .iter()
            .map(|candidate| candidate.account.id.clone())
            .collect();
        let active_account_id = activate_id.as_deref().and_then(|candidate_id| {
            selected
                .iter()
                .find(|candidate| candidate.summary.candidate_id == candidate_id)
                .map(|candidate| candidate.account.id.clone())
        });
        let active_pi_provider = active_account_id.as_deref().and_then(|account_id| {
            selected
                .iter()
                .find(|candidate| candidate.account.id == account_id)
                .map(|candidate| candidate.account.pi_provider.clone())
        });
        let deactivated_pi_providers = previous_active
            .filter(|account| Some(&account.pi_provider) != active_pi_provider.as_ref())
            .map(|account| vec![account.pi_provider])
            .unwrap_or_default();
        let summaries = self.vault.update(|document| {
            for candidate in &selected {
                if let Some(existing) = document
                    .accounts
                    .iter_mut()
                    .find(|account| account.id == candidate.account.id)
                {
                    *existing = candidate.account.clone();
                } else {
                    document.accounts.push(candidate.account.clone());
                }
            }
            if let Some(account_id) = active_account_id.as_ref() {
                document
                    .active_by_provider
                    .insert(provider.clone(), account_id.clone());
            }
            Ok(document.summaries())
        })?;
        Ok(ImportApplyResult {
            provider,
            imported_ids,
            active_account_id,
            active_pi_provider,
            deactivated_pi_providers,
            accounts: summaries,
            previous_active_account_id,
        })
    }
}

fn normalize_provider(provider: &str) -> Result<String, String> {
    let normalized = provider.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "codex" | "cursor" | "claude" => Ok(normalized),
        _ => Err(format!("Unsupported account provider: {provider}")),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn non_empty(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn first_string(value: &Value, paths: &[&[&str]]) -> Option<String> {
    paths.iter().find_map(|path| {
        let mut current = value;
        for key in *path {
            current = current.get(*key)?;
        }
        non_empty(Some(current))
    })
}

fn stable_id(provider: &str, identity: &str) -> String {
    let digest = Sha256::digest(format!("{provider}\0{identity}").as_bytes());
    let fingerprint: String = digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{provider}-{fingerprint}")
}

fn jwt_payload(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice(&decoded).ok()
}

fn jwt_email(token: &str) -> Option<String> {
    let payload = jwt_payload(token)?;
    first_string(
        &payload,
        &[
            &["email"],
            &["https://api.openai.com/profile", "email"],
            &["profile", "email"],
        ],
    )
}

fn jwt_expiry_ms(token: &str) -> Option<u64> {
    jwt_payload(token)?
        .get("exp")?
        .as_u64()
        .map(|seconds| seconds.saturating_mul(1000))
}

fn codex_account_id(token: &str) -> Option<String> {
    let payload = jwt_payload(token)?;
    first_string(
        &payload,
        &[
            &["https://api.openai.com/auth", "chatgpt_account_id"],
            &["https://api.openai.com/auth", "account_id"],
            &["account_id"],
            &["accountId"],
        ],
    )
}

fn flatten_json_candidates(value: Value) -> Vec<Value> {
    match value {
        Value::Array(values) => values,
        Value::Object(mut object) => {
            if let Some(Value::Array(accounts)) = object.remove("accounts") {
                accounts
            } else {
                vec![Value::Object(object)]
            }
        }
        other => vec![other],
    }
}

fn parse_json_or_lines(content: &str) -> Result<Vec<Value>, String> {
    if let Ok(value) = serde_json::from_str::<Value>(content) {
        return Ok(flatten_json_candidates(value));
    }
    let values: Vec<Value> = content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| {
            serde_json::from_str::<Value>(line).unwrap_or_else(|_| Value::String(line.to_string()))
        })
        .collect();
    if values.is_empty() {
        Err("The selected file is not valid JSON or token-line data".to_string())
    } else {
        Ok(values)
    }
}

#[derive(Default)]
struct CodexProviderConfig {
    base_url: Option<String>,
    provider_id: Option<String>,
    provider_name: Option<String>,
    model: Option<String>,
}

fn codex_home() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("CODEX_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    dirs::home_dir()
        .map(|home| home.join(".codex"))
        .ok_or_else(|| "Cannot find the current user's home directory".to_string())
}

fn read_codex_provider_config(path: &Path) -> CodexProviderConfig {
    let Ok(content) = fs::read_to_string(path) else {
        return CodexProviderConfig::default();
    };
    let Ok(value) = content.parse::<toml::Value>() else {
        return CodexProviderConfig::default();
    };
    let provider_id = value
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .map(str::to_string);
    let provider = provider_id.as_deref().and_then(|id| {
        value
            .get("model_providers")
            .and_then(toml::Value::as_table)
            .and_then(|providers| providers.get(id))
    });
    CodexProviderConfig {
        base_url: value
            .get("openai_base_url")
            .and_then(toml::Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                provider
                    .and_then(|item| item.get("base_url"))
                    .and_then(toml::Value::as_str)
                    .map(str::to_string)
            }),
        provider_id,
        provider_name: provider
            .and_then(|item| item.get("name"))
            .and_then(toml::Value::as_str)
            .map(str::to_string),
        model: value
            .get("model")
            .and_then(toml::Value::as_str)
            .map(str::to_string),
    }
}

fn preview_local_codex() -> Result<Vec<ParsedCandidate>, String> {
    let home = codex_home()?;
    let auth_path = home.join("auth.json");
    let content = fs::read_to_string(&auth_path)
        .map_err(|error| format!("Cannot read {}: {error}", auth_path.display()))?;
    let config = read_codex_provider_config(&home.join("config.toml"));
    let source = json!({
        "kind": "local",
        "application": "Codex",
        "path": auth_path,
    });
    parse_codex_json_with_config(&content, source, Some(&config))
}

fn parse_codex_json(content: &str, source: Value) -> Result<Vec<ParsedCandidate>, String> {
    parse_codex_json_with_config(content, source, None)
}

fn parse_codex_json_with_config(
    content: &str,
    source: Value,
    config: Option<&CodexProviderConfig>,
) -> Result<Vec<ParsedCandidate>, String> {
    let mut candidates = Vec::new();
    for value in parse_json_or_lines(content)? {
        if let Some(candidate) = codex_candidate_from_value(&value, source.clone(), config) {
            candidates.push(candidate);
        }
    }
    if candidates.is_empty() {
        Err("No Codex OAuth token or API key was found in the selected data".to_string())
    } else {
        Ok(candidates)
    }
}

fn codex_candidate_from_value(
    value: &Value,
    source: Value,
    config: Option<&CodexProviderConfig>,
) -> Option<ParsedCandidate> {
    let api_key = first_string(
        value,
        &[
            &["OPENAI_API_KEY"],
            &["openai_api_key"],
            &["api_key"],
            &["apiKey"],
        ],
    );
    let base_url = first_string(
        value,
        &[
            &["base_url"],
            &["api_base_url"],
            &["apiBaseUrl"],
            &["baseUrl"],
        ],
    )
    .or_else(|| config.and_then(|item| item.base_url.clone()));
    let auth_mode = first_string(value, &[&["auth_mode"], &["authMode"]])
        .unwrap_or_default()
        .to_ascii_lowercase();
    if let Some(api_key) = api_key.filter(|_| auth_mode.contains("key") || base_url.is_some()) {
        return Some(codex_api_key_candidate(
            value, api_key, base_url, source, config,
        ));
    }

    let access = first_string(
        value,
        &[
            &["access_token"],
            &["accessToken"],
            &["tokens", "access_token"],
            &["tokens", "accessToken"],
            &["credentials", "access_token"],
            &["credentials", "accessToken"],
        ],
    )
    .or_else(|| match value {
        Value::String(token) if token.split('.').count() == 3 => Some(token.clone()),
        _ => None,
    });
    let refresh = first_string(
        value,
        &[
            &["refresh_token"],
            &["refreshToken"],
            &["session_token"],
            &["sessionToken"],
            &["tokens", "refresh_token"],
            &["tokens", "refreshToken"],
            &["credentials", "refresh_token"],
            &["credentials", "refreshToken"],
        ],
    );
    let access = access?;
    let id_token = first_string(
        value,
        &[
            &["id_token"],
            &["idToken"],
            &["tokens", "id_token"],
            &["tokens", "idToken"],
            &["credentials", "id_token"],
            &["credentials", "idToken"],
        ],
    );
    let email = id_token
        .as_deref()
        .and_then(jwt_email)
        .or_else(|| jwt_email(&access))
        .or_else(|| first_string(value, &[&["email"], &["name"]]));
    let account_id = first_string(
        value,
        &[
            &["account_id"],
            &["accountId"],
            &["tokens", "account_id"],
            &["tokens", "accountId"],
        ],
    )
    .or_else(|| codex_account_id(&access));
    let identity = account_id
        .clone()
        .or_else(|| email.clone())
        .unwrap_or_else(|| stable_id("codex-token", &access));
    let id = stable_id("codex", &identity);
    let label = email
        .clone()
        .unwrap_or_else(|| format!("Codex {}", &id[id.len().saturating_sub(8)..]));
    let mut warnings = Vec::new();
    if refresh.is_none() {
        warnings.push(
            "This Codex JSON has no refresh token; chat will stop when the access token expires."
                .to_string(),
        );
    }
    let expires = jwt_expiry_ms(&access).unwrap_or_else(|| {
        if refresh.is_some() {
            0
        } else {
            now_ms().saturating_add(60 * 60 * 1000)
        }
    });
    let credentials = json!({
        "type": "oauth",
        "access": access,
        "refresh": refresh.clone().unwrap_or_default(),
        "expires": expires,
        "accountId": account_id,
    });
    let account = StoredAccount {
        id,
        provider: "codex".to_string(),
        pi_provider: "openai-codex".to_string(),
        label: label.clone(),
        email: email.clone(),
        auth_kind: "oauth".to_string(),
        chat_compatible: true,
        imported_at: now_ms(),
        source,
        endpoint: None,
        credentials,
        metadata: json!({ "hasRefreshToken": refresh.is_some(), "official": true }),
    };
    Some(ParsedCandidate {
        summary: candidate_summary(&account, warnings),
        account,
    })
}

fn codex_api_key_candidate(
    value: &Value,
    api_key: String,
    base_url: Option<String>,
    source: Value,
    config: Option<&CodexProviderConfig>,
) -> ParsedCandidate {
    let provider_id = first_string(
        value,
        &[&["api_provider_id"], &["apiProviderId"], &["provider_id"]],
    )
    .or_else(|| config.and_then(|item| item.provider_id.clone()))
    .unwrap_or_else(|| {
        if base_url.is_some() {
            "codex-proxy".to_string()
        } else {
            "openai".to_string()
        }
    });
    let provider_name = first_string(
        value,
        &[
            &["api_provider_name"],
            &["apiProviderName"],
            &["provider_name"],
        ],
    )
    .or_else(|| config.and_then(|item| item.provider_name.clone()))
    .unwrap_or_else(|| "Codex reverse proxy".to_string());
    let model = first_string(value, &[&["model"], &["model_name"], &["modelName"]])
        .or_else(|| config.and_then(|item| item.model.clone()));
    let identity = format!(
        "{}\0{}",
        provider_id,
        base_url.as_deref().unwrap_or("official")
    );
    let id = stable_id("codex", &identity);
    let endpoint = base_url.as_ref().map(|url| {
        json!({
            "baseUrl": url,
            "providerId": provider_id,
            "providerName": provider_name,
            "model": model,
            "api": "openai-responses",
        })
    });
    let mut warnings = Vec::new();
    if base_url.is_none() {
        warnings.push(
            "No Base URL was found; this key will use Pi's built-in OpenAI provider.".to_string(),
        );
    }
    let account = StoredAccount {
        id,
        provider: "codex".to_string(),
        pi_provider: provider_id,
        label: provider_name,
        email: None,
        auth_kind: "api_key".to_string(),
        chat_compatible: true,
        imported_at: now_ms(),
        source,
        endpoint,
        credentials: json!({ "type": "api_key", "key": api_key }),
        metadata: json!({ "official": false }),
    };
    ParsedCandidate {
        summary: candidate_summary(&account, warnings),
        account,
    }
}

fn cursor_data_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        return std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|path| path.join("Cursor"))
            .ok_or_else(|| "APPDATA is not available".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        return dirs::home_dir()
            .map(|home| home.join("Library/Application Support/Cursor"))
            .ok_or_else(|| "Cannot find the current user's home directory".to_string());
    }
    #[cfg(target_os = "linux")]
    {
        return dirs::home_dir()
            .map(|home| home.join(".config/Cursor"))
            .ok_or_else(|| "Cannot find the current user's home directory".to_string());
    }
    #[allow(unreachable_code)]
    Err("Cursor local import is supported only on Windows, macOS, and Linux".to_string())
}

fn preview_local_cursor() -> Result<Vec<ParsedCandidate>, String> {
    let db_path = cursor_data_dir()?
        .join("User")
        .join("globalStorage")
        .join("state.vscdb");
    if !db_path.exists() {
        return Err(format!(
            "Cursor account database was not found: {}",
            db_path.display()
        ));
    }
    let connection = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Cannot open Cursor account database: {error}"))?;
    let read = |key: &str| -> Option<String> {
        connection
            .query_row("SELECT value FROM ItemTable WHERE key = ?1", [key], |row| {
                row.get::<_, String>(0)
            })
            .optional()
            .ok()
            .flatten()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    let access = read("cursorAuth/accessToken")
        .ok_or_else(|| "Cursor is installed, but no signed-in account was found".to_string())?;
    let email = read("cursorAuth/cachedEmail");
    let refresh = read("cursorAuth/refreshToken");
    let auth_id = read("cursorAuth/authId");
    let source = json!({
        "kind": "local",
        "application": "Cursor",
        "path": db_path,
    });
    Ok(vec![cursor_desktop_candidate(
        access, refresh, auth_id, email, source,
    )])
}

fn parse_cursor_json(content: &str, source: Value) -> Result<Vec<ParsedCandidate>, String> {
    let mut candidates = Vec::new();
    for value in parse_json_or_lines(content)? {
        if let Some(api_key) = first_string(
            &value,
            &[
                &["CURSOR_API_KEY"],
                &["cursor_api_key"],
                &["apiKey"],
                &["api_key"],
            ],
        ) {
            let label = first_string(&value, &[&["name"], &["label"]])
                .unwrap_or_else(|| "Cursor SDK".to_string());
            let id = stable_id("cursor", &format!("sdk\0{label}"));
            let account = StoredAccount {
                id,
                provider: "cursor".to_string(),
                pi_provider: "cursor".to_string(),
                label,
                email: first_string(&value, &[&["email"]]),
                auth_kind: "api_key".to_string(),
                chat_compatible: true,
                imported_at: now_ms(),
                source: source.clone(),
                endpoint: None,
                credentials: json!({ "type": "api_key", "key": api_key }),
                metadata: json!({ "credentialKind": "cursor_sdk_api_key" }),
            };
            candidates.push(ParsedCandidate {
                summary: candidate_summary(&account, Vec::new()),
                account,
            });
            continue;
        }
        let access = first_string(
            &value,
            &[
                &["access_token"],
                &["accessToken"],
                &["token"],
                &["cursor_access_token"],
            ],
        );
        if let Some(access) = access {
            candidates.push(cursor_desktop_candidate(
                access,
                first_string(
                    &value,
                    &[
                        &["refresh_token"],
                        &["refreshToken"],
                        &["cursor_refresh_token"],
                    ],
                ),
                first_string(
                    &value,
                    &[&["auth_id"], &["authId"], &["workos_id"], &["workosId"]],
                ),
                first_string(&value, &[&["email"], &["cachedEmail"], &["cursor_email"]]),
                source.clone(),
            ));
        }
    }
    if candidates.is_empty() {
        Err("No Cursor account token or Cursor SDK API key was found".to_string())
    } else {
        Ok(candidates)
    }
}

fn cursor_desktop_candidate(
    access: String,
    refresh: Option<String>,
    auth_id: Option<String>,
    email: Option<String>,
    source: Value,
) -> ParsedCandidate {
    let identity = auth_id
        .clone()
        .or_else(|| email.clone())
        .unwrap_or_else(|| stable_id("cursor-token", &access));
    let id = stable_id("cursor", &identity);
    let label = email
        .clone()
        .unwrap_or_else(|| format!("Cursor {}", &id[id.len().saturating_sub(8)..]));
    let account = StoredAccount {
        id,
        provider: "cursor".to_string(),
        pi_provider: "cursor".to_string(),
        label: label.clone(),
        email: email.clone(),
        auth_kind: "oauth".to_string(),
        chat_compatible: false,
        imported_at: now_ms(),
        source,
        endpoint: None,
        credentials: json!({
            "accessToken": access,
            "refreshToken": refresh,
            "authId": auth_id,
        }),
        metadata: json!({ "credentialKind": "cursor_desktop_session" }),
    };
    ParsedCandidate {
        summary: candidate_summary(
            &account,
            vec![
                "Cursor Desktop/CLI OAuth cannot be used by pi-cursor-sdk. Import is available for account backup, but chat requires a Cursor SDK API Key."
                    .to_string(),
            ],
        ),
        account,
    }
}

fn claude_config_dir() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    dirs::home_dir()
        .map(|home| home.join(".claude"))
        .ok_or_else(|| "Cannot find the current user's home directory".to_string())
}

fn preview_local_claude() -> Result<Vec<ParsedCandidate>, String> {
    let config_dir = claude_config_dir()?;
    let credentials_path = config_dir.join(".credentials.json");
    let credentials = read_claude_credentials(&config_dir, &credentials_path)?;
    let local_config = config_dir.join(".config.json");
    let global_config = dirs::home_dir()
        .map(|home| home.join(".claude.json"))
        .ok_or_else(|| "Cannot find the current user's home directory".to_string())?;
    let config_path = if local_config.exists() {
        local_config
    } else {
        global_config
    };
    let config: Value = serde_json::from_slice(
        &fs::read(&config_path)
            .map_err(|error| format!("Cannot read {}: {error}", config_path.display()))?,
    )
    .map_err(|error| format!("Invalid Claude account config: {error}"))?;
    let source = json!({
        "kind": "local",
        "application": "Claude Code",
        "credentialsPath": credentials_path,
        "configPath": config_path,
    });
    claude_candidate_from_snapshots(credentials, config, source).map(|candidate| vec![candidate])
}

fn read_claude_credentials(_config_dir: &Path, path: &Path) -> Result<Value, String> {
    if path.exists() {
        return serde_json::from_slice(
            &fs::read(path).map_err(|error| format!("Cannot read {}: {error}", path.display()))?,
        )
        .map_err(|error| format!("Invalid Claude credentials JSON: {error}"));
    }
    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir().ok_or_else(|| "Cannot find the home directory".to_string())?;
        let scoped =
            _config_dir != home.join(".claude") || std::env::var_os("CLAUDE_CONFIG_DIR").is_some();
        let service = if scoped {
            let digest = Sha256::digest(_config_dir.to_string_lossy().as_bytes());
            let suffix: String = digest[..4]
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            format!("Claude Code-credentials-{suffix}")
        } else {
            "Claude Code-credentials".to_string()
        };
        let account = std::env::var("USER")
            .or_else(|_| std::env::var("LOGNAME"))
            .unwrap_or_else(|_| "claude-code-user".to_string());
        let output = std::process::Command::new("security")
            .args([
                "find-generic-password",
                "-a",
                &account,
                "-w",
                "-s",
                &service,
            ])
            .output()
            .map_err(|error| {
                format!("Cannot read the Claude Code macOS Keychain entry: {error}")
            })?;
        if output.status.success() {
            return serde_json::from_slice(&output.stdout)
                .map_err(|error| format!("Invalid Claude Code Keychain credentials: {error}"));
        }
    }
    Err(format!(
        "Claude Code credentials were not found: {}",
        path.display()
    ))
}

fn parse_claude_json(content: &str, source: Value) -> Result<Vec<ParsedCandidate>, String> {
    let value: Value =
        serde_json::from_str(content).map_err(|error| format!("Invalid Claude JSON: {error}"))?;
    let mut candidates = Vec::new();
    for item in flatten_json_candidates(value) {
        let credentials = item
            .get("claude_credentials_raw")
            .or_else(|| item.get("claudeCredentialsRaw"))
            .or_else(|| item.get("credentials"))
            .cloned()
            .unwrap_or_else(|| {
                if item.get("claudeAiOauth").is_some() {
                    item.clone()
                } else {
                    Value::Null
                }
            });
        let config = item
            .get("claude_config_raw")
            .or_else(|| item.get("claudeConfigRaw"))
            .or_else(|| item.get("config"))
            .cloned()
            .unwrap_or_else(|| {
                if item.get("oauthAccount").is_some() {
                    item.clone()
                } else {
                    Value::Null
                }
            });
        if let Ok(candidate) = claude_candidate_from_snapshots(credentials, config, source.clone())
        {
            candidates.push(candidate);
        }
    }
    if candidates.is_empty() {
        Err("No Claude OAuth credentials and account profile were found".to_string())
    } else {
        Ok(candidates)
    }
}

fn claude_candidate_from_snapshots(
    credentials: Value,
    config: Value,
    source: Value,
) -> Result<ParsedCandidate, String> {
    let oauth = credentials
        .get("claudeAiOauth")
        .ok_or_else(|| "Claude credentials are missing claudeAiOauth".to_string())?;
    let access = first_string(oauth, &[&["accessToken"], &["access_token"]])
        .ok_or_else(|| "Claude credentials are missing accessToken".to_string())?;
    let refresh = first_string(oauth, &[&["refreshToken"], &["refresh_token"]]);
    let expires = oauth
        .get("expiresAt")
        .or_else(|| oauth.get("expires_at"))
        .and_then(Value::as_u64)
        .or_else(|| jwt_expiry_ms(&access))
        .unwrap_or_else(|| {
            if refresh.is_some() {
                0
            } else {
                now_ms() + 60 * 60 * 1000
            }
        });
    let oauth_account = config.get("oauthAccount").unwrap_or(&Value::Null);
    let email = first_string(
        oauth_account,
        &[&["emailAddress"], &["email"], &["email_address"]],
    )
    .or_else(|| first_string(&config, &[&["email"]]))
    .or_else(|| first_string(oauth, &[&["profile", "account", "email"]]))
    .or_else(|| jwt_email(&access));
    let account_uuid = first_string(
        oauth_account,
        &[&["accountUuid"], &["account_uuid"], &["id"]],
    );
    let organization_uuid = first_string(
        oauth_account,
        &[&["organizationUuid"], &["organization_uuid"]],
    );
    let identity = account_uuid
        .clone()
        .or_else(|| email.clone())
        .unwrap_or_else(|| stable_id("claude-token", &access));
    let id = stable_id("claude", &identity);
    let label = email
        .clone()
        .unwrap_or_else(|| format!("Claude {}", &id[id.len().saturating_sub(8)..]));
    let mut warnings = Vec::new();
    if refresh.is_none() {
        warnings.push(
            "This Claude JSON has no refresh token; chat will stop when the access token expires."
                .to_string(),
        );
    }
    let account = StoredAccount {
        id,
        provider: "claude".to_string(),
        pi_provider: "anthropic".to_string(),
        label,
        email,
        auth_kind: "oauth".to_string(),
        chat_compatible: true,
        imported_at: now_ms(),
        source,
        endpoint: None,
        credentials: json!({
            "type": "oauth",
            "access": access,
            "refresh": refresh.clone().unwrap_or_default(),
            "expires": expires,
        }),
        metadata: json!({
            "hasRefreshToken": refresh.is_some(),
            "accountUuid": account_uuid,
            "organizationUuid": organization_uuid,
        }),
    };
    Ok(ParsedCandidate {
        summary: candidate_summary(&account, warnings),
        account,
    })
}

fn candidate_summary(account: &StoredAccount, warnings: Vec<String>) -> ImportCandidateSummary {
    ImportCandidateSummary {
        candidate_id: account.id.clone(),
        provider: account.provider.clone(),
        pi_provider: account.pi_provider.clone(),
        label: account.label.clone(),
        email: account.email.clone(),
        auth_kind: account.auth_kind.clone(),
        chat_compatible: account.chat_compatible,
        endpoint: account.endpoint.clone(),
        warnings,
        metadata: account.metadata.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account_vault::VaultDocument;
    use std::collections::BTreeMap;

    fn source() -> Value {
        json!({ "kind": "test" })
    }

    #[test]
    fn parses_official_codex_auth_json_into_pi_oauth_shape() {
        let candidate = parse_codex_json(
            r#"{
              "tokens": {
                "id_token": "header.eyJlbWFpbCI6Im1lQGV4YW1wbGUuY29tIn0.sig",
                "access_token": "header.eyJleHAiOjIwMDAwMDAwMDB9.sig",
                "refresh_token": "refresh-secret",
                "account_id": "acct-1"
              }
            }"#,
            source(),
        )
        .unwrap()
        .remove(0);
        assert_eq!(candidate.account.pi_provider, "openai-codex");
        assert_eq!(candidate.account.email.as_deref(), Some("me@example.com"));
        assert_eq!(candidate.account.credentials["type"], "oauth");
        assert_eq!(candidate.account.credentials["refresh"], "refresh-secret");
        assert!(candidate.account.chat_compatible);
    }

    #[test]
    fn imports_codex_reverse_proxy_settings_and_aliases() {
        let candidate = parse_codex_json(
            r#"{
              "authMode": "apikey",
              "OPENAI_API_KEY": "cpa_secret",
              "apiBaseUrl": "https://proxy.example/v1",
              "api_provider_id": "my-cpa",
              "model": "gpt-5-codex"
            }"#,
            source(),
        )
        .unwrap()
        .remove(0);
        assert_eq!(candidate.account.pi_provider, "my-cpa");
        assert_eq!(
            candidate.account.endpoint.as_ref().unwrap()["baseUrl"],
            "https://proxy.example/v1"
        );
        assert_eq!(candidate.account.credentials["key"], "cpa_secret");
    }

    #[test]
    fn cursor_desktop_oauth_is_storable_but_not_claimed_as_sdk_compatible() {
        let candidate = parse_cursor_json(
            r#"{
              "cachedEmail": "cursor@example.com",
              "accessToken": "desktop-access",
              "refreshToken": "desktop-refresh",
              "authId": "auth-1"
            }"#,
            source(),
        )
        .unwrap()
        .remove(0);
        assert!(!candidate.account.chat_compatible);
        assert_eq!(
            candidate.account.metadata["credentialKind"],
            "cursor_desktop_session"
        );
        assert!(!candidate.summary.warnings.is_empty());
    }

    #[test]
    fn cursor_sdk_api_key_is_chat_compatible() {
        let candidate = parse_cursor_json(
            r#"{"CURSOR_API_KEY":"cursor-key","name":"Work SDK"}"#,
            source(),
        )
        .unwrap()
        .remove(0);
        assert!(candidate.account.chat_compatible);
        assert_eq!(candidate.account.pi_provider, "cursor");
        assert_eq!(candidate.account.credentials["type"], "api_key");
    }

    #[test]
    fn parses_cockpit_style_claude_snapshot_json() {
        let candidate = parse_claude_json(
            r#"{
              "claudeCredentialsRaw": {
                "claudeAiOauth": {
                  "accessToken": "claude-access",
                  "refreshToken": "claude-refresh",
                  "expiresAt": 2000000000000
                }
              },
              "claudeConfigRaw": {
                "oauthAccount": {
                  "emailAddress": "claude@example.com",
                  "accountUuid": "account-1",
                  "organizationUuid": "org-1"
                }
              }
            }"#,
            source(),
        )
        .unwrap()
        .remove(0);
        assert_eq!(
            candidate.account.email.as_deref(),
            Some("claude@example.com")
        );
        assert_eq!(candidate.account.pi_provider, "anthropic");
        assert_eq!(candidate.account.credentials["refresh"], "claude-refresh");
    }

    #[test]
    fn restores_the_previous_vault_activation_after_external_sync_failure() {
        let root = std::env::temp_dir().join(format!("picot-import-restore-{}", Uuid::new_v4()));
        let vault = Arc::new(AccountVault::with_key(
            root.join("accounts.vault"),
            [9_u8; 32],
        ));
        let mut first =
            parse_codex_json(r#"{"authMode":"apikey","OPENAI_API_KEY":"one"}"#, source())
                .unwrap()
                .remove(0)
                .account;
        first.id = "codex-one".to_string();
        let mut second = first.clone();
        second.id = "codex-two".to_string();
        second.label = "Second".to_string();
        vault
            .replace(&VaultDocument {
                version: 1,
                accounts: vec![first, second],
                active_by_provider: BTreeMap::from([(
                    "codex".to_string(),
                    "codex-two".to_string(),
                )]),
            })
            .unwrap();
        let service = AccountImportService::new(vault.clone());

        let activation = service.activate_stored("codex-one").unwrap();
        assert_eq!(
            activation.previous_active_account_id.as_deref(),
            Some("codex-two")
        );
        assert_eq!(activation.active_account_id, "codex-one");
        let deactivation = service.deactivate_provider("codex").unwrap();
        assert_eq!(deactivation.deactivated_account_id, "codex-one");
        assert!(vault.load().unwrap().active_account("codex").is_none());

        service
            .restore_active_account("codex", Some("codex-one"))
            .unwrap();
        assert_eq!(
            vault.load().unwrap().active_by_provider.get("codex"),
            Some(&"codex-one".to_string())
        );

        service.restore_active_account("codex", None).unwrap();
        assert!(!vault
            .load()
            .unwrap()
            .active_by_provider
            .contains_key("codex"));
        let _ = fs::remove_dir_all(root);
    }
}
