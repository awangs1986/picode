use crate::account_vault::StoredAccount;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub struct PiAuthSynchronizer {
    auth_path: PathBuf,
    models_path: PathBuf,
}

impl PiAuthSynchronizer {
    pub fn for_current_user() -> Result<Self, String> {
        let home = dirs::home_dir()
            .ok_or_else(|| "Cannot find the current user's home directory".to_string())?;
        let agent_dir = home.join(".pi").join("agent");
        Ok(Self {
            auth_path: agent_dir.join("auth.json"),
            models_path: agent_dir.join("models.json"),
        })
    }

    #[cfg(test)]
    fn new(auth_path: PathBuf, models_path: PathBuf) -> Self {
        Self {
            auth_path,
            models_path,
        }
    }

    pub fn activate(
        &self,
        account: &StoredAccount,
        deactivated_pi_providers: &[String],
    ) -> Result<(), String> {
        if !account.chat_compatible {
            return Err("This account cannot be activated for Pi chat".to_string());
        }
        validate_credential(&account.credentials)?;
        let merged_models = account
            .endpoint
            .as_ref()
            .map(|endpoint| self.merge_endpoint_value(&account.pi_provider, endpoint))
            .transpose()?;
        let mut auth = read_object(&self.auth_path, "Pi auth")?;
        for provider in deactivated_pi_providers {
            if provider != &account.pi_provider {
                auth.remove(provider);
            }
        }
        auth.insert(account.pi_provider.clone(), account.credentials.clone());
        // Write models first. If the credential write then fails, the extra
        // provider definition is inert and the caller can safely restore the
        // previous vault activation without exposing a half-active account.
        if let Some(models) = merged_models {
            atomic_write_json(&self.models_path, &models)?;
        }
        atomic_write_json(&self.auth_path, &Value::Object(auth))
    }

    pub fn save_custom_provider(
        &self,
        provider_id: &str,
        display_name: &str,
        api: &str,
        base_url: &str,
        api_key: &str,
        model_ids: &[String],
    ) -> Result<(), String> {
        let provider_id = provider_id.trim();
        if provider_id.is_empty()
            || provider_id.len() > 64
            || !provider_id
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
        {
            return Err(
                "Provider ID must contain only letters, numbers, hyphens, underscores, or dots"
                    .to_string(),
            );
        }
        if matches!(provider_id, "openai-codex" | "anthropic" | "cursor") {
            return Err(
                "Choose a unique Provider ID so this custom API does not replace a managed agent account"
                    .to_string(),
            );
        }
        let display_name = display_name.trim();
        if display_name.is_empty() || display_name.len() > 100 {
            return Err("Provider name must be between 1 and 100 characters".to_string());
        }
        if !matches!(
            api,
            "openai-completions" | "openai-responses" | "anthropic-messages"
        ) {
            return Err("Unsupported custom provider API format".to_string());
        }
        let base_url = base_url.trim().trim_end_matches('/');
        let parsed_url = reqwest::Url::parse(base_url)
            .map_err(|_| "Base URL must be a valid HTTP or HTTPS URL".to_string())?;
        if !matches!(parsed_url.scheme(), "http" | "https")
            || parsed_url.host_str().is_none()
            || !parsed_url.username().is_empty()
            || parsed_url.password().is_some()
        {
            return Err(
                "Base URL must be a valid HTTP or HTTPS URL without credentials".to_string(),
            );
        }
        let api_key = api_key.trim();
        if api_key.is_empty() {
            return Err("API key is required".to_string());
        }
        let mut seen = HashSet::new();
        let models: Vec<String> = model_ids
            .iter()
            .map(|model| model.trim())
            .filter(|model| !model.is_empty())
            .filter(|model| seen.insert((*model).to_string()))
            .map(str::to_string)
            .collect();
        if models.is_empty() || models.len() > 500 || models.iter().any(|model| model.len() > 256) {
            return Err("Provide between 1 and 500 valid model IDs".to_string());
        }
        let account = StoredAccount {
            id: format!("custom-{provider_id}"),
            provider: format!("custom:{provider_id}"),
            pi_provider: provider_id.to_string(),
            label: display_name.to_string(),
            email: None,
            auth_kind: "api_key".to_string(),
            chat_compatible: true,
            imported_at: 0,
            source: serde_json::json!({ "kind": "custom_provider_form" }),
            endpoint: Some(serde_json::json!({
                "baseUrl": base_url,
                "providerId": provider_id,
                "providerName": display_name,
                "api": api,
                "models": models,
            })),
            credentials: serde_json::json!({ "type": "api_key", "key": api_key }),
            metadata: serde_json::json!({}),
        };
        self.activate(&account, &[])
    }

    pub fn deactivate(&self, pi_provider: &str) -> Result<(), String> {
        let pi_provider = pi_provider.trim();
        if pi_provider.is_empty() {
            return Err("Pi provider is required".to_string());
        }
        let mut auth = read_object(&self.auth_path, "Pi auth")?;
        auth.remove(pi_provider);
        atomic_write_json(&self.auth_path, &Value::Object(auth))
    }

    fn merge_endpoint_value(&self, provider_id: &str, endpoint: &Value) -> Result<Value, String> {
        let base_url = endpoint
            .get("baseUrl")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Imported reverse-proxy settings are missing Base URL".to_string())?;
        let mut root = read_object(&self.models_path, "Pi models")?;
        let providers = root
            .entry("providers".to_string())
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or_else(|| "Pi models.json field 'providers' must be an object".to_string())?;
        let provider = providers
            .entry(provider_id.to_string())
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or_else(|| format!("Pi model provider '{provider_id}' must be an object"))?;
        provider.insert("baseUrl".to_string(), Value::String(base_url.to_string()));
        provider.insert(
            "api".to_string(),
            Value::String(
                endpoint
                    .get("api")
                    .and_then(Value::as_str)
                    .unwrap_or("openai-responses")
                    .to_string(),
            ),
        );
        if let Some(name) = endpoint
            .get("providerName")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            provider.insert("name".to_string(), Value::String(name.to_string()));
        }
        if let Some(model_id) = endpoint
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let models = provider
                .entry("models".to_string())
                .or_insert_with(|| Value::Array(Vec::new()))
                .as_array_mut()
                .ok_or_else(|| {
                    format!("Pi model provider '{provider_id}' models must be an array")
                })?;
            let exists = models
                .iter()
                .any(|model| model.get("id").and_then(Value::as_str) == Some(model_id));
            if !exists {
                models.push(serde_json::json!({ "id": model_id }));
            }
        }
        if let Some(model_ids) = endpoint.get("models").and_then(Value::as_array) {
            let models = provider
                .entry("models".to_string())
                .or_insert_with(|| Value::Array(Vec::new()))
                .as_array_mut()
                .ok_or_else(|| {
                    format!("Pi model provider '{provider_id}' models must be an array")
                })?;
            for model_id in model_ids.iter().filter_map(Value::as_str) {
                if !models
                    .iter()
                    .any(|model| model.get("id").and_then(Value::as_str) == Some(model_id))
                {
                    models.push(serde_json::json!({ "id": model_id }));
                }
            }
        }
        Ok(Value::Object(root))
    }
}

fn validate_credential(credential: &Value) -> Result<(), String> {
    let object = credential
        .as_object()
        .ok_or_else(|| "Imported Pi credential must be a JSON object".to_string())?;
    match object.get("type").and_then(Value::as_str) {
        Some("api_key") if object.get("key").and_then(Value::as_str).is_some() => Ok(()),
        Some("oauth")
            if object.get("access").and_then(Value::as_str).is_some()
                && object.get("refresh").and_then(Value::as_str).is_some()
                && object.get("expires").and_then(Value::as_u64).is_some() =>
        {
            Ok(())
        }
        Some(kind) => Err(format!("Imported Pi credential has invalid {kind} fields")),
        None => Err("Imported Pi credential is missing its type".to_string()),
    }
}

fn read_object(path: &Path, label: &str) -> Result<Map<String, Value>, String> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let bytes = fs::read(path)
        .map_err(|error| format!("Cannot read {label} file {}: {error}", path.display()))?;
    serde_json::from_slice::<Value>(&bytes)
        .map_err(|error| format!("Invalid {label} JSON {}: {error}", path.display()))?
        .as_object()
        .cloned()
        .ok_or_else(|| {
            format!(
                "{label} file must contain a JSON object: {}",
                path.display()
            )
        })
}

fn atomic_write_json(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Pi configuration path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Cannot create Pi configuration directory {}: {error}",
            parent.display()
        )
    })?;
    let temporary = parent.join(format!(".picot-pi-config-{}.tmp", Uuid::new_v4().simple()));
    let encoded = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Cannot encode Pi configuration: {error}"))?;
    let result = (|| {
        let mut file = fs::File::create(&temporary)
            .map_err(|error| format!("Cannot create temporary Pi configuration: {error}"))?;
        file.write_all(&encoded)
            .map_err(|error| format!("Cannot write temporary Pi configuration: {error}"))?;
        file.write_all(b"\n")
            .map_err(|error| format!("Cannot finish temporary Pi configuration: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Cannot sync temporary Pi configuration: {error}"))?;
        fs::rename(&temporary, path).map_err(|error| {
            format!(
                "Cannot atomically replace Pi configuration {}: {error}",
                path.display()
            )
        })?;
        restrict_permissions(path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| {
        format!(
            "Cannot restrict Pi configuration permissions {}: {error}",
            path.display()
        )
    })
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn setup() -> (PathBuf, PiAuthSynchronizer) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("picot-pi-auth-sync-{nonce}"));
        let sync = PiAuthSynchronizer::new(root.join("auth.json"), root.join("models.json"));
        (root, sync)
    }

    fn proxy_account() -> StoredAccount {
        StoredAccount {
            id: "codex-proxy-account".to_string(),
            provider: "codex".to_string(),
            pi_provider: "my-cpa".to_string(),
            label: "My CPA".to_string(),
            email: None,
            auth_kind: "api_key".to_string(),
            chat_compatible: true,
            imported_at: 1,
            source: json!({}),
            endpoint: Some(json!({
                "baseUrl": "https://proxy.example/v1",
                "providerName": "My CPA",
                "api": "openai-responses",
                "model": "gpt-5-codex"
            })),
            credentials: json!({ "type": "api_key", "key": "cpa_secret" }),
            metadata: json!({}),
        }
    }

    #[test]
    fn activates_proxy_without_overwriting_unrelated_pi_configuration() {
        let (root, sync) = setup();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("auth.json"),
            r#"{"anthropic":{"type":"api_key","key":"keep"}}"#,
        )
        .unwrap();
        fs::write(
            root.join("models.json"),
            r#"{"providers":{"ollama":{"baseUrl":"http://localhost:11434/v1"}},"unknown":true}"#,
        )
        .unwrap();

        sync.activate(&proxy_account(), &[]).unwrap();

        let auth: Value =
            serde_json::from_slice(&fs::read(root.join("auth.json")).unwrap()).unwrap();
        assert_eq!(auth["anthropic"]["key"], "keep");
        assert_eq!(auth["my-cpa"]["key"], "cpa_secret");
        let models: Value =
            serde_json::from_slice(&fs::read(root.join("models.json")).unwrap()).unwrap();
        assert_eq!(models["unknown"], true);
        assert_eq!(
            models["providers"]["ollama"]["baseUrl"],
            "http://localhost:11434/v1"
        );
        assert_eq!(
            models["providers"]["my-cpa"]["models"][0]["id"],
            "gpt-5-codex"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn official_codex_activation_removes_only_the_managed_proxy_credential() {
        let (root, sync) = setup();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("auth.json"),
            r#"{"my-cpa":{"type":"api_key","key":"old"},"anthropic":{"type":"api_key","key":"keep"}}"#,
        )
        .unwrap();
        let mut official = proxy_account();
        official.pi_provider = "openai-codex".to_string();
        official.endpoint = None;
        official.auth_kind = "oauth".to_string();
        official.credentials = json!({
            "type": "oauth",
            "access": "access",
            "refresh": "refresh",
            "expires": 2000000000000_u64
        });

        sync.activate(&official, &["my-cpa".to_string()]).unwrap();

        let auth: Value =
            serde_json::from_slice(&fs::read(root.join("auth.json")).unwrap()).unwrap();
        assert!(auth.get("my-cpa").is_none());
        assert_eq!(auth["anthropic"]["key"], "keep");
        assert_eq!(auth["openai-codex"]["access"], "access");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_models_configuration_does_not_partially_activate_a_proxy() {
        let (root, sync) = setup();
        fs::create_dir_all(&root).unwrap();
        let original_auth = r#"{"anthropic":{"type":"api_key","key":"keep"}}"#;
        fs::write(root.join("auth.json"), original_auth).unwrap();
        fs::write(root.join("models.json"), r#"{"providers":[]}"#).unwrap();

        assert!(sync.activate(&proxy_account(), &[]).is_err());

        let auth: Value =
            serde_json::from_slice(&fs::read(root.join("auth.json")).unwrap()).unwrap();
        assert_eq!(auth["anthropic"]["key"], "keep");
        assert!(auth.get("my-cpa").is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn saves_multiple_custom_api_providers_without_replacing_existing_ones() {
        let (root, sync) = setup();
        sync.save_custom_provider(
            "deepseek",
            "DeepSeek",
            "openai-completions",
            "https://api.deepseek.example/v1",
            "deepseek-secret",
            &["deepseek-chat".to_string(), "deepseek-reasoner".to_string()],
        )
        .unwrap();
        sync.save_custom_provider(
            "claude-proxy",
            "Claude proxy",
            "anthropic-messages",
            "https://claude.example/v1",
            "claude-secret",
            &["claude-custom".to_string()],
        )
        .unwrap();

        let auth: Value =
            serde_json::from_slice(&fs::read(root.join("auth.json")).unwrap()).unwrap();
        assert_eq!(auth["deepseek"]["key"], "deepseek-secret");
        assert_eq!(auth["claude-proxy"]["key"], "claude-secret");
        let models: Value =
            serde_json::from_slice(&fs::read(root.join("models.json")).unwrap()).unwrap();
        assert_eq!(
            models["providers"]["deepseek"]["models"][1]["id"],
            "deepseek-reasoner"
        );
        assert_eq!(
            models["providers"]["claude-proxy"]["api"],
            "anthropic-messages"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deactivating_an_account_keeps_unrelated_provider_credentials() {
        let (root, sync) = setup();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("auth.json"),
            r#"{"openai-codex":{"type":"oauth","access":"old","refresh":"r","expires":1},"anthropic":{"type":"api_key","key":"keep"}}"#,
        )
        .unwrap();

        sync.deactivate("openai-codex").unwrap();

        let auth: Value =
            serde_json::from_slice(&fs::read(root.join("auth.json")).unwrap()).unwrap();
        assert!(auth.get("openai-codex").is_none());
        assert_eq!(auth["anthropic"]["key"], "keep");
        fs::remove_dir_all(root).unwrap();
    }
}
