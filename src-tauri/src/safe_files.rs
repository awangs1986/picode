#![cfg_attr(not(test), allow(dead_code))]

use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileSnapshot {
    pub bytes: Vec<u8>,
    pub version: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContentAnchor {
    text: String,
    version: String,
}

impl ContentAnchor {
    pub fn new(text: &str) -> Self {
        Self {
            text: text.to_owned(),
            version: content_version(text.as_bytes()),
        }
    }
}

#[derive(Default)]
pub struct SafeFileStore;

impl SafeFileStore {
    pub fn create_atomic(&self, path: &Path, content: &[u8]) -> Result<String, String> {
        if path.exists() {
            return Err("file already exists; read its version before writing".into());
        }
        let parent = path
            .parent()
            .ok_or_else(|| "file has no parent directory".to_owned())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("cannot create {}: {error}", parent.display()))?;
        let temporary = sibling(parent, path, &format!("picode-{}.tmp", Uuid::new_v4()));
        let result = (|| -> Result<(), String> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|error| format!("cannot create {}: {error}", temporary.display()))?;
            file.write_all(content)
                .map_err(|error| format!("cannot write {}: {error}", temporary.display()))?;
            file.sync_all()
                .map_err(|error| format!("cannot sync {}: {error}", temporary.display()))?;
            fs::rename(&temporary, path)
                .map_err(|error| format!("cannot install complete file: {error}"))?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;
        Ok(content_version(content))
    }

    pub fn read(&self, path: &Path) -> Result<FileSnapshot, String> {
        let bytes =
            fs::read(path).map_err(|error| format!("cannot read {}: {error}", path.display()))?;
        Ok(FileSnapshot {
            version: content_version(&bytes),
            bytes,
        })
    }

    pub fn write_atomic(
        &self,
        path: &Path,
        expected_version: &str,
        replacement: &[u8],
    ) -> Result<String, String> {
        let current = self.read(path)?;
        if current.version != expected_version {
            return Err("stale file version; reread before writing".into());
        }
        let parent = path
            .parent()
            .ok_or_else(|| "file has no parent directory".to_owned())?;
        let nonce = Uuid::new_v4();
        let temporary = sibling(parent, path, &format!("picode-{nonce}.tmp"));
        let backup = sibling(parent, path, &format!("picode-{nonce}.bak"));
        let permissions = fs::metadata(path)
            .map_err(|error| format!("cannot inspect {}: {error}", path.display()))?
            .permissions();

        let result = (|| -> Result<(), String> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|error| format!("cannot create {}: {error}", temporary.display()))?;
            file.write_all(replacement)
                .map_err(|error| format!("cannot write {}: {error}", temporary.display()))?;
            file.sync_all()
                .map_err(|error| format!("cannot sync {}: {error}", temporary.display()))?;
            fs::set_permissions(&temporary, permissions)
                .map_err(|error| format!("cannot preserve file permissions: {error}"))?;
            fs::rename(path, &backup)
                .map_err(|error| format!("cannot prepare atomic replacement: {error}"))?;
            if let Err(error) = fs::rename(&temporary, path) {
                let _ = fs::rename(&backup, path);
                return Err(format!("cannot install complete replacement: {error}"));
            }
            fs::remove_file(&backup)
                .map_err(|error| format!("cannot remove replacement backup: {error}"))?;
            Ok(())
        })();

        if result.is_err() {
            let _ = fs::remove_file(&temporary);
            if backup.exists() && !path.exists() {
                let _ = fs::rename(&backup, path);
            }
        }
        result?;
        Ok(content_version(replacement))
    }

    pub fn replace_anchored(
        &self,
        path: &Path,
        expected_version: &str,
        anchor: &ContentAnchor,
        replacement: &str,
    ) -> Result<String, String> {
        let current = self.read(path)?;
        if current.version != expected_version {
            return Err("stale file version; reread before writing".into());
        }
        if content_version(anchor.text.as_bytes()) != anchor.version {
            return Err("content anchor is corrupt".into());
        }
        let text = String::from_utf8(current.bytes)
            .map_err(|_| "anchored patch requires a UTF-8 text file".to_owned())?;
        let mut matched = None;
        for (line_index, line) in text.split('\n').enumerate() {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if line == anchor.text {
                if matched.is_some() {
                    return Err("content anchor is ambiguous; reread with a larger anchor".into());
                }
                matched = Some(line_index);
            }
        }
        let target =
            matched.ok_or_else(|| "content anchor no longer matches; reread".to_owned())?;
        let mut lines: Vec<&str> = text.split('\n').collect();
        let had_cr = lines[target].ends_with('\r');
        let replacement_line = if had_cr {
            format!("{replacement}\r")
        } else {
            replacement.to_owned()
        };
        let mut rebuilt = String::new();
        for (index, line) in lines.drain(..).enumerate() {
            if index > 0 {
                rebuilt.push('\n');
            }
            if index == target {
                rebuilt.push_str(&replacement_line);
            } else {
                rebuilt.push_str(line);
            }
        }
        self.write_atomic(path, expected_version, rebuilt.as_bytes())
    }
}

fn sibling(parent: &Path, path: &Path, suffix: &str) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    parent.join(format!(".{name}.{suffix}"))
}

fn content_version(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::{ContentAnchor, SafeFileStore};

    #[test]
    fn stale_write_is_rejected_without_overwriting_concurrent_user_content() {
        let root = std::env::temp_dir().join(format!("picode-safe-file-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("design.txt");
        std::fs::write(&file, "version one").unwrap();
        let store = SafeFileStore;
        let observed = store.read(&file).unwrap();

        std::fs::write(&file, "user changed this").unwrap();
        assert_eq!(
            store.write_atomic(&file, observed.version.as_str(), b"agent replacement"),
            Err("stale file version; reread before writing".into())
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "user changed this");

        let current = store.read(&file).unwrap();
        store
            .write_atomic(&file, current.version.as_str(), b"agent replacement")
            .unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "agent replacement");

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn optional_content_anchor_cannot_bypass_the_file_version_precondition() {
        let root = std::env::temp_dir().join(format!("picode-safe-patch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("lib.rs");
        std::fs::write(&file, "alpha\nbeta\n").unwrap();
        let store = SafeFileStore;
        let snapshot = store.read(&file).unwrap();
        let anchor = ContentAnchor::new("beta");

        std::fs::write(&file, "alpha\nuser beta\n").unwrap();
        assert!(store
            .replace_anchored(&file, &snapshot.version, &anchor, "BETA")
            .unwrap_err()
            .contains("stale"));

        let current = store.read(&file).unwrap();
        assert!(store
            .replace_anchored(&file, &current.version, &anchor, "BETA")
            .unwrap_err()
            .contains("anchor"));
        let user_anchor = ContentAnchor::new("user beta");
        store
            .replace_anchored(&file, &current.version, &user_anchor, "BETA")
            .unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "alpha\nBETA\n");
        std::fs::remove_dir_all(root).unwrap();
    }
}
