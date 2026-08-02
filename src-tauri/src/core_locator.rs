use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use uuid::Uuid;

pub const CORE_LOCATOR_PROTOCOL_VERSION: u32 = 1;
pub const CORE_LOCATOR_FILE: &str = "core-locator.json";
const MAX_LOCATOR_BYTES: u64 = 1024;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreLocator {
    pub protocol_version: u32,
    pub host: String,
    pub broker_port: u16,
    pub pid: u32,
    pub written_at: u64,
}

impl CoreLocator {
    pub fn new(broker_port: u16, pid: u32, written_at: u64) -> Self {
        Self {
            protocol_version: CORE_LOCATOR_PROTOCOL_VERSION,
            host: "127.0.0.1".into(),
            broker_port,
            pid,
            written_at,
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.protocol_version != CORE_LOCATOR_PROTOCOL_VERSION {
            return Err(format!(
                "Unsupported Core locator protocol {}; expected {}",
                self.protocol_version, CORE_LOCATOR_PROTOCOL_VERSION
            ));
        }
        if self.host != "127.0.0.1" {
            return Err("Core locator must address the IPv4 loopback host".into());
        }
        if self.broker_port == 0 || self.pid == 0 {
            return Err("Core locator port and process ID must be non-zero".into());
        }
        Ok(())
    }
}

pub fn write_locator(path: &Path, locator: &CoreLocator) -> Result<(), String> {
    locator.validate()?;
    let bytes = serde_json::to_vec(locator)
        .map_err(|error| format!("Cannot encode Core locator: {error}"))?;
    if bytes.len() as u64 > MAX_LOCATOR_BYTES {
        return Err("Core locator exceeds its size limit".into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Core locator path must have a parent".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Create Core locator directory: {error}"))?;
    let temp = parent.join(format!(
        ".core-locator-{}-{}.tmp",
        std::process::id(),
        Uuid::new_v4().simple()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|error| format!("Create staged Core locator: {error}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Write staged Core locator: {error}"))?;
        replace_file(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(not(windows))]
fn replace_file(staged: &Path, target: &Path) -> Result<(), String> {
    fs::rename(staged, target).map_err(|error| format!("Publish Core locator: {error}"))
}

#[cfg(windows)]
fn replace_file(staged: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let staged = staged
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            staged.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        return Err(format!(
            "Publish Core locator: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

pub fn read_locator(path: &Path) -> Result<CoreLocator, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("Read Core locator metadata: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_LOCATOR_BYTES {
        return Err("Core locator is not a bounded regular file".into());
    }
    let locator: CoreLocator = serde_json::from_slice(
        &fs::read(path).map_err(|error| format!("Read Core locator: {error}"))?,
    )
    .map_err(|error| format!("Parse Core locator: {error}"))?;
    locator.validate()?;
    Ok(locator)
}

pub fn remove_owned_locator(path: &Path, owner_pid: u32) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if read_locator(path)?.pid != owner_pid {
        return Ok(());
    }
    fs::remove_file(path).map_err(|error| format!("Remove Core locator: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{read_locator, remove_owned_locator, write_locator, CoreLocator};
    use std::fs;
    use uuid::Uuid;

    fn root(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("picode-core-locator-{label}-{}", Uuid::new_v4()))
    }

    #[test]
    fn publishes_and_reads_a_bounded_local_core_locator_atomically() {
        let root = root("roundtrip");
        let path = root.join("core-locator.json");
        let locator = CoreLocator::new(47821, 1234, 42);

        write_locator(&path, &locator).unwrap();
        assert_eq!(read_locator(&path).unwrap(), locator);
        assert!(fs::metadata(&path).unwrap().len() < 1024);

        remove_owned_locator(&path, 9999).unwrap();
        assert!(path.is_file());
        remove_owned_locator(&path, 1234).unwrap();
        assert!(!path.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_stale_invalid_and_non_loopback_locator_data() {
        let root = root("invalid");
        let path = root.join("core-locator.json");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            &path,
            r#"{"protocolVersion":99,"host":"0.0.0.0","brokerPort":47821,"pid":1,"writtenAt":1}"#,
        )
        .unwrap();

        assert!(read_locator(&path).unwrap_err().contains("protocol"));
        let _ = fs::remove_dir_all(root);
    }
}
