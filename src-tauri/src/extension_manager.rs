#![cfg_attr(not(test), allow(dead_code))]

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionLifecycle {
    Discovered,
    Enabled,
    Trusted,
    Running,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedExtensionManifest {
    pub id: String,
    pub name: String,
    pub source: String,
    pub source_ref: Option<String>,
    pub components: Vec<String>,
    pub executable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedExtensionView {
    pub manifest: ManagedExtensionManifest,
    pub lifecycle: ExtensionLifecycle,
    pub model_discoverable: bool,
}

pub struct ExtensionManager {
    extensions: BTreeMap<String, ManagedExtensionView>,
}

impl ExtensionManager {
    pub fn new() -> Self {
        Self {
            extensions: BTreeMap::new(),
        }
    }

    pub fn discover(&mut self, manifest: ManagedExtensionManifest) -> Result<(), String> {
        if manifest.id.trim().is_empty() || manifest.name.trim().is_empty() {
            return Err("Extension id and name are required".to_owned());
        }
        if self.extensions.contains_key(&manifest.id) {
            return Err("Extension is already discovered".to_owned());
        }
        if manifest.executable
            && manifest.source.starts_with("http")
            && manifest.source_ref.as_deref().is_none_or(str::is_empty)
        {
            return Err("Remote executable extension requires a pinned source ref".to_owned());
        }
        self.extensions.insert(
            manifest.id.clone(),
            ManagedExtensionView {
                manifest,
                lifecycle: ExtensionLifecycle::Discovered,
                model_discoverable: false,
            },
        );
        Ok(())
    }

    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> Result<(), String> {
        let extension = self.extension_mut(id)?;
        if extension.lifecycle == ExtensionLifecycle::Running {
            return Err("Stop the extension before changing enabled state".to_owned());
        }
        if enabled {
            if extension.lifecycle == ExtensionLifecycle::Discovered {
                extension.lifecycle = ExtensionLifecycle::Enabled;
            }
            extension.model_discoverable = true;
        } else {
            extension.lifecycle = ExtensionLifecycle::Discovered;
            extension.model_discoverable = false;
        }
        Ok(())
    }

    pub fn set_trusted(&mut self, id: &str, trusted: bool) -> Result<(), String> {
        let extension = self.extension_mut(id)?;
        if extension.lifecycle == ExtensionLifecycle::Running {
            return Err("Stop the extension before changing trust".to_owned());
        }
        if extension.lifecycle == ExtensionLifecycle::Discovered {
            return Err("Enable the extension before changing trust".to_owned());
        }
        extension.lifecycle = if trusted {
            ExtensionLifecycle::Trusted
        } else {
            ExtensionLifecycle::Enabled
        };
        Ok(())
    }

    pub fn start(&mut self, id: &str) -> Result<(), String> {
        let extension = self.extension_mut(id)?;
        if extension.lifecycle == ExtensionLifecycle::Discovered {
            return Err("Extension is disabled".to_owned());
        }
        if extension.manifest.executable && extension.lifecycle != ExtensionLifecycle::Trusted {
            return Err("Extension is not trusted".to_owned());
        }
        extension.lifecycle = ExtensionLifecycle::Running;
        Ok(())
    }

    pub fn stop(&mut self, id: &str) -> Result<(), String> {
        let extension = self.extension_mut(id)?;
        if extension.lifecycle != ExtensionLifecycle::Running {
            return Err("Extension is not running".to_owned());
        }
        extension.lifecycle = if extension.manifest.executable {
            ExtensionLifecycle::Trusted
        } else {
            ExtensionLifecycle::Enabled
        };
        Ok(())
    }

    pub fn inspect(&self, id: &str) -> Result<ManagedExtensionView, String> {
        self.extensions
            .get(id)
            .cloned()
            .ok_or_else(|| "Unknown extension".to_owned())
    }

    fn extension_mut(&mut self, id: &str) -> Result<&mut ManagedExtensionView, String> {
        self.extensions
            .get_mut(id)
            .ok_or_else(|| "Unknown extension".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::{ExtensionLifecycle, ExtensionManager, ManagedExtensionManifest};

    fn firstmate() -> ManagedExtensionManifest {
        ManagedExtensionManifest {
            id: "firstmate".to_owned(),
            name: "Firstmate".to_owned(),
            source: "https://github.com/kunchenguid/firstmate".to_owned(),
            source_ref: Some("pinned-commit".to_owned()),
            components: vec!["agent".to_owned(), "gui-entry".to_owned()],
            executable: true,
        }
    }

    #[test]
    fn caller_must_enable_and_trust_executable_code_before_it_can_run() {
        let mut manager = ExtensionManager::new();
        manager.discover(firstmate()).unwrap();
        let discovered = manager.inspect("firstmate").unwrap();
        assert_eq!(discovered.lifecycle, ExtensionLifecycle::Discovered);
        assert!(!discovered.model_discoverable);

        manager.set_enabled("firstmate", true).unwrap();
        let enabled = manager.inspect("firstmate").unwrap();
        assert_eq!(enabled.lifecycle, ExtensionLifecycle::Enabled);
        assert!(enabled.model_discoverable);
        assert_eq!(
            manager.start("firstmate").unwrap_err(),
            "Extension is not trusted"
        );

        manager.set_trusted("firstmate", true).unwrap();
        manager.start("firstmate").unwrap();
        assert_eq!(
            manager.inspect("firstmate").unwrap().lifecycle,
            ExtensionLifecycle::Running
        );
        assert!(manager.set_enabled("firstmate", false).is_err());
        manager.stop("firstmate").unwrap();
        manager.set_enabled("firstmate", false).unwrap();
        assert_eq!(
            manager.inspect("firstmate").unwrap().lifecycle,
            ExtensionLifecycle::Discovered
        );
        assert!(!manager.inspect("firstmate").unwrap().model_discoverable);
    }
}
