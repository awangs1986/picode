use crate::account_vault::StoredAccount;
use serde_json::{Map, Value};
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
}
