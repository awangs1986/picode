use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

pub const CLIENT_PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClientSurface {
    Gui,
    Tui,
    Headless,
    Remote,
}

impl ClientSurface {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gui => "gui",
            Self::Tui => "tui",
            Self::Headless => "headless",
            Self::Remote => "remote",
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClientHello {
    pub client_id: String,
    pub surface: ClientSurface,
    pub protocol_version: u32,
}

#[derive(Clone, Debug)]
pub struct SharedClientFacts {
    pub accounts: Value,
    pub sessions: Value,
    pub live_chats: Value,
    pub tasks: Value,
    pub extensions: Value,
    pub work: Value,
    pub runtime: Value,
    pub packages: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedClientSnapshot {
    pub protocol_version: u32,
    pub client_id: String,
    pub surface: ClientSurface,
    pub generated_at: u64,
    pub accounts: Value,
    pub sessions: Value,
    pub live_chats: Value,
    pub tasks: Value,
    pub extensions: Value,
    pub work: Value,
    pub runtime: Value,
    pub packages: Vec<String>,
}

pub trait SharedSnapshotSource: Send + Sync {
    fn collect(&self) -> Result<SharedClientFacts, String>;
}

pub struct ClientGateway {
    source: Arc<dyn SharedSnapshotSource>,
    max_snapshot_bytes: usize,
}

impl ClientGateway {
    pub fn new(source: Arc<dyn SharedSnapshotSource>, max_snapshot_bytes: usize) -> Self {
        Self {
            source,
            max_snapshot_bytes,
        }
    }

    pub fn connect(
        &self,
        hello: &ClientHello,
        generated_at: u64,
    ) -> Result<SharedClientSnapshot, String> {
        if hello.protocol_version != CLIENT_PROTOCOL_VERSION {
            return Err(format!(
                "Unsupported client protocol version {}; expected {}",
                hello.protocol_version, CLIENT_PROTOCOL_VERSION
            ));
        }
        if !valid_client_id(&hello.client_id) {
            return Err(
                "Invalid client ID; use 1–128 ASCII letters, numbers, '.', '_', '-', or ':'"
                    .to_owned(),
            );
        }
        let facts = self.source.collect()?;
        let snapshot = SharedClientSnapshot {
            protocol_version: CLIENT_PROTOCOL_VERSION,
            client_id: hello.client_id.clone(),
            surface: hello.surface,
            generated_at,
            accounts: facts.accounts,
            sessions: facts.sessions,
            live_chats: facts.live_chats,
            tasks: facts.tasks,
            extensions: facts.extensions,
            work: facts.work,
            runtime: facts.runtime,
            packages: facts.packages,
        };
        let value = serde_json::to_value(&snapshot)
            .map_err(|error| format!("Cannot encode shared client snapshot: {error}"))?;
        if contains_secret_bearing_key(&value) {
            return Err("Shared client snapshot contains a secret-bearing field".to_owned());
        }
        let encoded = serde_json::to_vec(&value)
            .map_err(|error| format!("Cannot size shared client snapshot: {error}"))?;
        if encoded.len() > self.max_snapshot_bytes {
            return Err(format!(
                "Shared client snapshot must remain bounded ({} > {} bytes)",
                encoded.len(),
                self.max_snapshot_bytes
            ));
        }
        Ok(snapshot)
    }
}

fn valid_client_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-:".contains(&byte))
}

fn contains_secret_bearing_key(value: &Value) -> bool {
    const BLOCKED: &[&str] = &[
        "apikey",
        "accesstoken",
        "refreshtoken",
        "password",
        "credential",
        "credentials",
        "secretvalue",
        "plaintextsecret",
    ];
    match value {
        Value::Object(object) => object.iter().any(|(key, nested)| {
            let normalized = key
                .chars()
                .filter(|character| character.is_ascii_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect::<String>();
            BLOCKED.contains(&normalized.as_str()) || contains_secret_bearing_key(nested)
        }),
        Value::Array(items) => items.iter().any(contains_secret_bearing_key),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ClientGateway, ClientHello, ClientSurface, SharedClientFacts, SharedSnapshotSource,
        CLIENT_PROTOCOL_VERSION,
    };
    use serde_json::json;
    use std::sync::Arc;

    struct FixedSource(SharedClientFacts);

    impl SharedSnapshotSource for FixedSource {
        fn collect(&self) -> Result<SharedClientFacts, String> {
            Ok(self.0.clone())
        }
    }

    fn source(accounts: serde_json::Value) -> Arc<dyn SharedSnapshotSource> {
        Arc::new(FixedSource(SharedClientFacts {
            accounts,
            sessions: json!([{ "id": "chat-a", "title": "Ship it" }]),
            live_chats: json!([{ "sessionId": "chat-a", "sourcePort": 47821 }]),
            tasks: json!({ "tasks": [{ "id": "task-a" }] }),
            extensions: json!({ "lifecycle": [{ "id": "skill-a", "state": "enabled" }] }),
            work: json!([]),
            runtime: json!({ "instances": [] }),
            packages: vec!["npm:pi-subagents@0.37.2".into()],
        }))
    }

    #[test]
    fn gui_and_tui_connect_through_the_same_bounded_secret_free_interface() {
        let gateway = ClientGateway::new(
            source(json!([{ "id": "codex-a", "label": "Personal Codex" }])),
            16 * 1024,
        );
        let gui = gateway
            .connect(
                &ClientHello {
                    client_id: "gui-window-a".into(),
                    surface: ClientSurface::Gui,
                    protocol_version: CLIENT_PROTOCOL_VERSION,
                },
                42,
            )
            .unwrap();
        let tui = gateway
            .connect(
                &ClientHello {
                    client_id: "tui-pane-a".into(),
                    surface: ClientSurface::Tui,
                    protocol_version: CLIENT_PROTOCOL_VERSION,
                },
                43,
            )
            .unwrap();

        assert_eq!(gui.accounts, tui.accounts);
        assert_eq!(gui.tasks, tui.tasks);
        assert_eq!(gui.sessions, tui.sessions);
        assert_eq!(gui.live_chats, tui.live_chats);
        assert_eq!(gui.extensions, tui.extensions);
        assert_eq!(gui.packages, tui.packages);
        assert_eq!(gui.generated_at, 42);
        assert_eq!(tui.surface, ClientSurface::Tui);
    }

    #[test]
    fn rejects_unknown_protocol_invalid_identity_secrets_and_oversized_snapshots() {
        let unknown = ClientGateway::new(source(json!([])), 4096)
            .connect(
                &ClientHello {
                    client_id: "gui-a".into(),
                    surface: ClientSurface::Gui,
                    protocol_version: CLIENT_PROTOCOL_VERSION + 1,
                },
                1,
            )
            .unwrap_err();
        assert!(unknown.contains("protocol"));

        let invalid = ClientGateway::new(source(json!([])), 4096)
            .connect(
                &ClientHello {
                    client_id: "contains whitespace".into(),
                    surface: ClientSurface::Gui,
                    protocol_version: CLIENT_PROTOCOL_VERSION,
                },
                1,
            )
            .unwrap_err();
        assert!(invalid.contains("client ID"));

        let secret = ClientGateway::new(source(json!([{ "apiKey": "do-not-leak" }])), 4096)
            .connect(
                &ClientHello {
                    client_id: "tui-a".into(),
                    surface: ClientSurface::Tui,
                    protocol_version: CLIENT_PROTOCOL_VERSION,
                },
                1,
            )
            .unwrap_err();
        assert!(secret.contains("secret-bearing"));

        let oversized = ClientGateway::new(source(json!([{ "label": "x".repeat(4096) }])), 512)
            .connect(
                &ClientHello {
                    client_id: "headless-a".into(),
                    surface: ClientSurface::Headless,
                    protocol_version: CLIENT_PROTOCOL_VERSION,
                },
                1,
            )
            .unwrap_err();
        assert!(oversized.contains("bounded"));
    }
}
