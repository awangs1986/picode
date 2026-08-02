use serde_json::{Map, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use uuid::Uuid;

pub const CURSOR_SDK_PACKAGE: &str = "npm:pi-cursor-sdk@0.1.61";
pub const CURSOR_SDK_PACKAGE_NAME: &str = "pi-cursor-sdk";
pub const CURSOR_OAUTH_PACKAGE_NAME: &str = "@rahularya01/pi-cursor";

/// Owns every filesystem and environment boundary used by Picode's embedded
/// Pi runtime. Picode configuration is deliberately separate from a user's
/// standalone Pi configuration, while the legacy session directory remains
/// the transcript authority so GUI and TUI can continue existing chats.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PiRuntimeProfile {
    agent_dir: PathBuf,
    session_dir: PathBuf,
    legacy_agent_dir: PathBuf,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProfileMigration {
    pub settings_imported: bool,
    pub removed_cursor_packages: usize,
}

impl PiRuntimeProfile {
    pub fn new(app_data_dir: &Path, home_dir: &Path) -> Self {
        let legacy_agent_dir = home_dir.join(".pi").join("agent");
        Self {
            agent_dir: app_data_dir.join("pi-runtime").join("agent"),
            session_dir: legacy_agent_dir.join("sessions"),
            legacy_agent_dir,
        }
    }

    pub fn for_current_user(app_data_dir: &Path) -> Result<Self, String> {
        let home = dirs::home_dir()
            .ok_or_else(|| "Cannot find the current user's home directory".to_string())?;
        Ok(Self::new(app_data_dir, &home))
    }

    pub fn agent_dir(&self) -> &Path {
        &self.agent_dir
    }

    #[cfg(test)]
    pub fn session_dir(&self) -> &Path {
        &self.session_dir
    }

    #[cfg(test)]
    pub fn legacy_agent_dir(&self) -> &Path {
        &self.legacy_agent_dir
    }

    pub fn npm_bin_dir(&self) -> PathBuf {
        self.agent_dir.join("npm").join("node_modules").join(".bin")
    }

    pub fn initialize(&self) -> Result<ProfileMigration, String> {
        fs::create_dir_all(&self.agent_dir).map_err(|error| {
            format!(
                "Cannot create Picode Pi runtime directory {}: {error}",
                self.agent_dir.display()
            )
        })?;

        let target = self.agent_dir.join("settings.json");
        let source = self.legacy_agent_dir.join("settings.json");
        let target_existed = target.exists();
        let settings_imported = !target_existed && source.exists();
        let mut settings = if target_existed {
            read_settings(&target)?
        } else if source.exists() {
            read_settings(&source)?
        } else {
            Map::new()
        };
        let removed_cursor_packages = remove_cursor_packages(&mut settings, !target_existed);
        atomic_write_json(&target, &Value::Object(settings))?;

        // Credentials and provider endpoints are intentionally not copied.
        // AccountVault materializes active accounts into this profile after
        // startup, keeping the operating-system credential store authoritative.
        Ok(ProfileMigration {
            settings_imported,
            removed_cursor_packages,
        })
    }

    pub fn apply_to_command(&self, command: &mut Command) {
        command
            .env("PI_CODING_AGENT_DIR", &self.agent_dir)
            .env("PI_CODING_AGENT_SESSION_DIR", &self.session_dir);
    }

    pub fn environment(&self) -> [(String, String); 2] {
        [
            (
                "PI_CODING_AGENT_DIR".to_string(),
                self.agent_dir.to_string_lossy().into_owned(),
            ),
            (
                "PI_CODING_AGENT_SESSION_DIR".to_string(),
                self.session_dir.to_string_lossy().into_owned(),
            ),
        ]
    }
}

pub fn package_source_contains(source: &str, package_name: &str) -> bool {
    let source = source.trim();
    source == package_name
        || source == format!("npm:{package_name}")
        || source.strip_prefix("npm:").is_some_and(|candidate| {
            candidate == package_name || package_version_matches(candidate, package_name)
        })
        || package_version_matches(source, package_name)
}

fn package_version_matches(source: &str, package_name: &str) -> bool {
    source
        .strip_prefix(package_name)
        .is_some_and(|suffix| suffix.starts_with('@'))
}

fn remove_cursor_packages(settings: &mut Map<String, Value>, remove_formal_sdk: bool) -> usize {
    let Some(packages) = settings.get_mut("packages").and_then(Value::as_array_mut) else {
        return 0;
    };
    let before = packages.len();
    packages.retain(|entry| {
        let source = entry
            .as_str()
            .or_else(|| entry.get("source").and_then(Value::as_str));
        !source.is_some_and(|source| {
            package_source_contains(source, CURSOR_OAUTH_PACKAGE_NAME)
                || (package_source_contains(source, CURSOR_SDK_PACKAGE_NAME)
                    && (remove_formal_sdk || source.trim() != CURSOR_SDK_PACKAGE))
        })
    });
    before - packages.len()
}

fn read_settings(path: &Path) -> Result<Map<String, Value>, String> {
    let bytes = fs::read(path)
        .map_err(|error| format!("Cannot read Pi settings {}: {error}", path.display()))?;
    serde_json::from_slice::<Value>(&bytes)
        .map_err(|error| format!("Invalid Pi settings JSON {}: {error}", path.display()))?
        .as_object()
        .cloned()
        .ok_or_else(|| format!("Pi settings must be a JSON object: {}", path.display()))
}

fn atomic_write_json(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Pi settings path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create {}: {error}", parent.display()))?;
    let temporary = parent.join(format!(".picode-runtime-{}.tmp", Uuid::new_v4().simple()));
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Cannot encode Picode Pi settings: {error}"))?;
    let result = (|| {
        let mut file = fs::File::create(&temporary)
            .map_err(|error| format!("Cannot create {}: {error}", temporary.display()))?;
        file.write_all(&bytes)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Cannot write {}: {error}", temporary.display()))?;
        fs::rename(&temporary, path)
            .map_err(|error| format!("Cannot install {}: {error}", path.display()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    fn root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "picode-runtime-profile-{label}-{}",
            Uuid::new_v4().simple()
        ))
    }

    #[test]
    fn isolates_configuration_but_keeps_legacy_transcript_authority() {
        let base = root("paths");
        let profile = PiRuntimeProfile::new(&base.join("app"), &base.join("home"));

        assert_eq!(profile.agent_dir(), base.join("app/pi-runtime/agent"));
        assert_eq!(profile.session_dir(), base.join("home/.pi/agent/sessions"));
        assert_ne!(profile.agent_dir(), profile.legacy_agent_dir());
    }

    #[test]
    fn migration_preserves_settings_and_removes_both_cursor_implementations() {
        let base = root("migration");
        let app = base.join("app");
        let home = base.join("home");
        let legacy = home.join(".pi/agent");
        fs::create_dir_all(&legacy).unwrap();
        let original = json!({
            "theme": "light",
            "defaultProvider": "cursor",
            "packages": [
                "npm:@rahularya01/pi-cursor@1.4.0",
                { "source": "npm:pi-cursor-sdk@0.1.60", "extensions": ["+index.ts"] },
                "git:github.com/mattpocock/skills",
                "npm:pi-subagents@0.37.2"
            ]
        });
        fs::write(
            legacy.join("settings.json"),
            serde_json::to_vec_pretty(&original).unwrap(),
        )
        .unwrap();
        fs::write(legacy.join("auth.json"), r#"{"cursor":{"key":"secret"}}"#).unwrap();

        let profile = PiRuntimeProfile::new(&app, &home);
        let outcome = profile.initialize().unwrap();

        assert!(outcome.settings_imported);
        assert_eq!(outcome.removed_cursor_packages, 2);
        let migrated: Value =
            serde_json::from_slice(&fs::read(profile.agent_dir().join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(migrated["theme"], "light");
        assert_eq!(migrated["packages"].as_array().unwrap().len(), 2);
        assert!(!profile.agent_dir().join("auth.json").exists());
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(legacy.join("settings.json")).unwrap())
                .unwrap(),
            original
        );

        let second = profile.initialize().unwrap();
        assert!(!second.settings_imported);
        assert_eq!(second.removed_cursor_packages, 0);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn child_environment_contains_both_owned_paths() {
        let base = root("environment");
        let profile = PiRuntimeProfile::new(&base.join("app"), &base.join("home"));
        let environment = profile
            .environment()
            .into_iter()
            .collect::<BTreeMap<_, _>>();

        assert_eq!(
            environment["PI_CODING_AGENT_DIR"],
            profile.agent_dir().to_string_lossy().as_ref()
        );
        assert_eq!(
            environment["PI_CODING_AGENT_SESSION_DIR"],
            profile.session_dir().to_string_lossy().as_ref()
        );
    }

    #[test]
    fn initialized_profile_keeps_the_exact_formal_sdk_pin() {
        let base = root("formal-pin");
        let profile = PiRuntimeProfile::new(&base.join("app"), &base.join("home"));
        fs::create_dir_all(profile.agent_dir()).unwrap();
        fs::write(
            profile.agent_dir().join("settings.json"),
            serde_json::to_vec(&json!({
                "packages": [CURSOR_SDK_PACKAGE, "npm:@rahularya01/pi-cursor@1.4.0"]
            }))
            .unwrap(),
        )
        .unwrap();

        let outcome = profile.initialize().unwrap();
        assert_eq!(outcome.removed_cursor_packages, 1);
        let settings: Value =
            serde_json::from_slice(&fs::read(profile.agent_dir().join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(settings["packages"], json!([CURSOR_SDK_PACKAGE]));
        let _ = fs::remove_dir_all(base);
    }
}
