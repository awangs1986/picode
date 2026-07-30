#![cfg_attr(not(test), allow(dead_code))]

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use uuid::Uuid;
use zeroize::Zeroize;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SecretReference {
    Temporary { id: String, task_id: String },
    File { path: PathBuf },
    Environment { name: String },
    Credential { service: String, account: String },
}

pub struct ResolvedSecret(Vec<u8>);

impl ResolvedSecret {
    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for ResolvedSecret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Clone, Debug)]
struct TemporarySecret {
    task_id: String,
    path: PathBuf,
}

pub struct SecretStore {
    root: PathBuf,
    key: [u8; 32],
    temporary: BTreeMap<String, TemporarySecret>,
}

impl SecretStore {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&root).map_err(|error| {
            format!(
                "cannot create protected temporary secret area {}: {error}",
                root.display()
            )
        })?;
        restrict_directory(&root)?;
        let mut key = [0_u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        Ok(Self {
            root,
            key,
            temporary: BTreeMap::new(),
        })
    }

    pub fn put_temporary(
        &mut self,
        task_id: &str,
        secret: &[u8],
    ) -> Result<SecretReference, String> {
        if task_id.trim().is_empty() || secret.is_empty() {
            return Err("task id and temporary secret are required".into());
        }
        let id = Uuid::new_v4().to_string();
        let path = self.root.join(format!("{id}.secret"));
        let mut nonce = [0_u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let cipher = Aes256Gcm::new_from_slice(&self.key)
            .map_err(|_| "cannot initialize temporary secret encryption".to_owned())?;
        let encrypted = cipher
            .encrypt(Nonce::from_slice(&nonce), secret)
            .map_err(|_| "cannot encrypt temporary secret".to_owned())?;
        let mut document = Vec::with_capacity(nonce.len() + encrypted.len());
        document.extend_from_slice(&nonce);
        document.extend_from_slice(&encrypted);
        std::fs::write(&path, document)
            .map_err(|error| format!("cannot store encrypted temporary secret: {error}"))?;
        restrict_file(&path)?;
        self.temporary.insert(
            id.clone(),
            TemporarySecret {
                task_id: task_id.to_owned(),
                path,
            },
        );
        Ok(SecretReference::Temporary {
            id,
            task_id: task_id.to_owned(),
        })
    }

    pub fn resolve(&self, reference: &SecretReference) -> Result<ResolvedSecret, String> {
        match reference {
            SecretReference::Temporary { id, task_id } => {
                let stored = self
                    .temporary
                    .get(id)
                    .filter(|stored| stored.task_id == *task_id)
                    .ok_or_else(|| "temporary secret is unavailable".to_owned())?;
                let document = std::fs::read(&stored.path)
                    .map_err(|_| "temporary secret is unavailable".to_owned())?;
                if document.len() < 13 {
                    return Err("temporary secret is damaged".into());
                }
                let cipher = Aes256Gcm::new_from_slice(&self.key)
                    .map_err(|_| "cannot initialize temporary secret decryption".to_owned())?;
                let bytes = cipher
                    .decrypt(Nonce::from_slice(&document[..12]), &document[12..])
                    .map_err(|_| "temporary secret is damaged".to_owned())?;
                Ok(ResolvedSecret(bytes))
            }
            SecretReference::File { path } => std::fs::read(path)
                .map(ResolvedSecret)
                .map_err(|error| format!("cannot resolve referenced secret file: {error}")),
            SecretReference::Environment { name } => std::env::var_os(name)
                .map(|value| ResolvedSecret(value.to_string_lossy().as_bytes().to_vec()))
                .ok_or_else(|| format!("secret environment variable {name} is unavailable")),
            SecretReference::Credential { service, account } => {
                keyring::Entry::new(service, account)
                    .map_err(|error| format!("cannot open operating-system credential: {error}"))?
                    .get_password()
                    .map(|value| ResolvedSecret(value.into_bytes()))
                    .map_err(|error| format!("cannot resolve operating-system credential: {error}"))
            }
        }
    }

    pub fn finish_task(&mut self, task_id: &str) -> Result<(), String> {
        let ids: Vec<String> = self
            .temporary
            .iter()
            .filter(|(_, secret)| secret.task_id == task_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(secret) = self.temporary.remove(&id) {
                match std::fs::remove_file(&secret.path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(format!(
                            "cannot destroy task temporary secret {}: {error}",
                            secret.path.display()
                        ));
                    }
                }
            }
        }
        Ok(())
    }
}

impl Drop for SecretStore {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

#[cfg(unix)]
fn restrict_directory(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("cannot protect temporary secret directory: {error}"))
}

#[cfg(not(unix))]
fn restrict_directory(_path: &std::path::Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn restrict_file(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("cannot protect temporary secret file: {error}"))
}

#[cfg(not(unix))]
fn restrict_file(_path: &std::path::Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{SecretReference, SecretStore};

    #[test]
    fn temporary_secrets_are_encrypted_and_cleanup_never_deletes_user_reference_files() {
        let root = std::env::temp_dir().join(format!("picode-secrets-{}", uuid::Uuid::new_v4()));
        let user_file = root.join("user-owned-password.txt");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&user_file, "ssh-password").unwrap();
        let mut store = SecretStore::new(root.join("owned")).unwrap();
        let temporary = store.put_temporary("task-a", b"one-off-token").unwrap();
        let file_reference = SecretReference::File {
            path: user_file.clone(),
        };

        assert_eq!(
            store.resolve(&temporary).unwrap().as_slice(),
            b"one-off-token"
        );
        assert_eq!(
            store.resolve(&file_reference).unwrap().as_slice(),
            b"ssh-password"
        );
        let owned_bytes = std::fs::read_dir(root.join("owned"))
            .unwrap()
            .flat_map(|entry| std::fs::read(entry.unwrap().path()).unwrap())
            .collect::<Vec<_>>();
        assert!(!String::from_utf8_lossy(&owned_bytes).contains("one-off-token"));
        assert!(!serde_json::to_string(&temporary)
            .unwrap()
            .contains("one-off-token"));

        store.finish_task("task-a").unwrap();
        assert!(user_file.exists());
        assert!(store.resolve(&temporary).is_err());

        std::fs::remove_dir_all(root).unwrap();
    }
}
