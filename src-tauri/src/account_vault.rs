use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

const VAULT_VERSION: u8 = 1;
const VAULT_AAD: &[u8] = b"picot-account-vault:v1";
const KEYRING_SERVICE: &str = "dev.pi.picot.accounts";
const KEYRING_USER: &str = "vault-key-v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredAccount {
    pub id: String,
    pub provider: String,
    pub pi_provider: String,
    pub label: String,
    pub email: Option<String>,
    pub auth_kind: String,
    pub chat_compatible: bool,
    pub imported_at: u64,
    pub source: Value,
    pub endpoint: Option<Value>,
    pub credentials: Value,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub id: String,
    pub provider: String,
    pub pi_provider: String,
    pub label: String,
    pub email: Option<String>,
    pub auth_kind: String,
    pub chat_compatible: bool,
    pub active: bool,
    pub imported_at: u64,
    pub endpoint: Option<Value>,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VaultDocument {
    #[serde(default = "vault_version")]
    pub version: u8,
    #[serde(default)]
    pub accounts: Vec<StoredAccount>,
    #[serde(default)]
    pub active_by_provider: BTreeMap<String, String>,
}

impl Default for VaultDocument {
    fn default() -> Self {
        Self {
            version: VAULT_VERSION,
            accounts: Vec::new(),
            active_by_provider: BTreeMap::new(),
        }
    }
}

fn vault_version() -> u8 {
    VAULT_VERSION
}

impl VaultDocument {
    pub fn summaries(&self) -> Vec<AccountSummary> {
        self.accounts
            .iter()
            .map(|account| AccountSummary {
                id: account.id.clone(),
                provider: account.provider.clone(),
                pi_provider: account.pi_provider.clone(),
                label: account.label.clone(),
                email: account.email.clone(),
                auth_kind: account.auth_kind.clone(),
                chat_compatible: account.chat_compatible,
                active: self.active_by_provider.get(&account.provider) == Some(&account.id),
                imported_at: account.imported_at,
                endpoint: account.endpoint.clone(),
                metadata: account.metadata.clone(),
            })
            .collect()
    }

    pub fn active_account(&self, provider: &str) -> Option<&StoredAccount> {
        let id = self.active_by_provider.get(provider)?;
        self.accounts.iter().find(|account| &account.id == id)
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedEnvelope {
    version: u8,
    algorithm: String,
    nonce: String,
    ciphertext: String,
}

pub struct AccountVault {
    path: PathBuf,
    #[cfg(test)]
    key_override: Option<[u8; 32]>,
    operation_lock: Mutex<()>,
}

impl AccountVault {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            #[cfg(test)]
            key_override: None,
            operation_lock: Mutex::new(()),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_key(path: PathBuf, key: [u8; 32]) -> Self {
        Self {
            path,
            key_override: Some(key),
            operation_lock: Mutex::new(()),
        }
    }

    fn key(&self) -> Result<[u8; 32], String> {
        #[cfg(test)]
        if let Some(key) = self.key_override {
            return Ok(key);
        }

        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|error| {
            format!("Cannot open the operating-system credential store: {error}")
        })?;
        match entry.get_secret() {
            Ok(secret) => secret.try_into().map_err(|_| {
                "The Picode account-vault key has an invalid length; recovery is required".to_string()
            }),
            Err(keyring::Error::NoEntry) => {
                let mut key = [0_u8; 32];
                OsRng.fill_bytes(&mut key);
                entry.set_secret(&key).map_err(|error| {
                    format!("Cannot save the account-vault key in the operating-system credential store: {error}")
                })?;
                Ok(key)
            }
            Err(error) => Err(format!(
                "Cannot read the account-vault key from the operating-system credential store: {error}"
            )),
        }
    }

    pub fn load(&self) -> Result<VaultDocument, String> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| "The account vault lock is poisoned".to_string())?;
        self.load_unlocked()
    }

    #[cfg(test)]
    pub fn replace(&self, document: &VaultDocument) -> Result<(), String> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| "The account vault lock is poisoned".to_string())?;
        self.save_unlocked(document)
    }

    pub fn update<T>(
        &self,
        operation: impl FnOnce(&mut VaultDocument) -> Result<T, String>,
    ) -> Result<T, String> {
        let _guard = self
            .operation_lock
            .lock()
            .map_err(|_| "The account vault lock is poisoned".to_string())?;
        let mut document = self.load_unlocked()?;
        let result = operation(&mut document)?;
        self.save_unlocked(&document)?;
        Ok(result)
    }

    fn load_unlocked(&self) -> Result<VaultDocument, String> {
        if !self.path.exists() {
            return Ok(VaultDocument {
                version: VAULT_VERSION,
                ..VaultDocument::default()
            });
        }
        let encoded = fs::read(&self.path).map_err(|error| {
            format!("Cannot read account vault {}: {error}", self.path.display())
        })?;
        let envelope: EncryptedEnvelope = serde_json::from_slice(&encoded)
            .map_err(|error| format!("Invalid account-vault envelope: {error}"))?;
        if envelope.version != VAULT_VERSION || envelope.algorithm != "AES-256-GCM" {
            return Err(format!(
                "Unsupported account-vault format: version {}, algorithm {}",
                envelope.version, envelope.algorithm
            ));
        }
        let nonce = BASE64
            .decode(envelope.nonce)
            .map_err(|error| format!("Invalid account-vault nonce: {error}"))?;
        if nonce.len() != 12 {
            return Err("Invalid account-vault nonce length".to_string());
        }
        let ciphertext = BASE64
            .decode(envelope.ciphertext)
            .map_err(|error| format!("Invalid account-vault ciphertext: {error}"))?;
        let key = self.key()?;
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| "Cannot initialize account-vault encryption".to_string())?;
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                aes_gcm::aead::Payload {
                    msg: &ciphertext,
                    aad: VAULT_AAD,
                },
            )
            .map_err(|_| {
                "Cannot decrypt the account vault; the system credential may have changed"
                    .to_string()
            })?;
        let document: VaultDocument = serde_json::from_slice(&plaintext)
            .map_err(|error| format!("Invalid decrypted account-vault data: {error}"))?;
        if document.version != VAULT_VERSION {
            return Err(format!(
                "Unsupported decrypted account-vault version: {}",
                document.version
            ));
        }
        Ok(document)
    }

    fn save_unlocked(&self, document: &VaultDocument) -> Result<(), String> {
        if document.version != VAULT_VERSION {
            return Err(format!(
                "Refusing to write unsupported account-vault version: {}",
                document.version
            ));
        }
        let plaintext = serde_json::to_vec(document)
            .map_err(|error| format!("Cannot encode account-vault data: {error}"))?;
        let mut nonce = [0_u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let key = self.key()?;
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| "Cannot initialize account-vault encryption".to_string())?;
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                aes_gcm::aead::Payload {
                    msg: &plaintext,
                    aad: VAULT_AAD,
                },
            )
            .map_err(|_| "Cannot encrypt account-vault data".to_string())?;
        let envelope = EncryptedEnvelope {
            version: VAULT_VERSION,
            algorithm: "AES-256-GCM".to_string(),
            nonce: BASE64.encode(nonce),
            ciphertext: BASE64.encode(ciphertext),
        };
        let encoded = serde_json::to_vec_pretty(&envelope)
            .map_err(|error| format!("Cannot encode account-vault envelope: {error}"))?;
        atomic_write(&self.path, &encoded)
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Account-vault path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Cannot create account-vault directory {}: {error}",
            parent.display()
        )
    })?;
    let temporary = parent.join(format!(".picot-accounts-{}.tmp", Uuid::new_v4().simple()));
    let result = (|| {
        let mut file = fs::File::create(&temporary)
            .map_err(|error| format!("Cannot create temporary account vault: {error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("Cannot write temporary account vault: {error}"))?;
        file.write_all(b"\n")
            .map_err(|error| format!("Cannot finish temporary account vault: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Cannot sync temporary account vault: {error}"))?;
        fs::rename(&temporary, path).map_err(|error| {
            format!(
                "Cannot atomically replace account vault {}: {error}",
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
            "Cannot restrict account-vault permissions {}: {error}",
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

    fn test_vault() -> (PathBuf, AccountVault) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("picot-account-vault-{nonce}"));
        let vault = AccountVault::with_key(root.join("accounts.vault"), [7_u8; 32]);
        (root, vault)
    }

    fn account(id: &str, label: &str) -> StoredAccount {
        StoredAccount {
            id: id.to_string(),
            provider: "codex".to_string(),
            pi_provider: "openai-codex".to_string(),
            label: label.to_string(),
            email: Some(format!("{id}@example.com")),
            auth_kind: "oauth".to_string(),
            chat_compatible: true,
            imported_at: 1,
            source: json!({ "kind": "json" }),
            endpoint: None,
            credentials: json!({ "access": "secret-access", "refresh": "secret-refresh" }),
            metadata: json!({}),
        }
    }

    #[test]
    fn encrypts_round_trips_and_never_writes_credentials_in_plaintext() {
        let (root, vault) = test_vault();
        let document = VaultDocument {
            version: VAULT_VERSION,
            accounts: vec![account("a", "Account A")],
            active_by_provider: BTreeMap::from([("codex".to_string(), "a".to_string())]),
        };
        vault.replace(&document).unwrap();
        assert_eq!(vault.load().unwrap(), document);
        let raw = fs::read_to_string(root.join("accounts.vault")).unwrap();
        assert!(!raw.contains("secret-access"));
        assert!(!raw.contains("secret-refresh"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn summaries_do_not_expose_credentials_and_track_one_active_account() {
        let document = VaultDocument {
            version: VAULT_VERSION,
            accounts: vec![account("a", "Account A"), account("b", "Account B")],
            active_by_provider: BTreeMap::from([("codex".to_string(), "b".to_string())]),
        };
        let summaries = document.summaries();
        assert!(!summaries[0].active);
        assert!(summaries[1].active);
        let serialized = serde_json::to_string(&summaries).unwrap();
        assert!(!serialized.contains("secret-access"));
    }

    #[test]
    fn rejects_tampered_ciphertext() {
        let (root, vault) = test_vault();
        vault.replace(&VaultDocument::default()).unwrap();
        let path = root.join("accounts.vault");
        let mut envelope: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        envelope["ciphertext"] = Value::String(BASE64.encode([0_u8; 48]));
        fs::write(&path, serde_json::to_vec(&envelope).unwrap()).unwrap();
        assert!(vault.load().unwrap_err().contains("Cannot decrypt"));
        fs::remove_dir_all(root).unwrap();
    }
}
