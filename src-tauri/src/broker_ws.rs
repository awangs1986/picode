use futures_util::future::BoxFuture;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::net::{Ipv4Addr, SocketAddrV4};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const PROTOCOL_VERSION: u8 = 1;

type Tx = mpsc::UnboundedSender<String>;
pub type UpstreamEventObserver = Arc<dyn Fn(u16, Value) + Send + Sync>;

/// Emits an intermediate progress frame for an in-flight `broker_control`
/// request (e.g. updater download chunks). The broker wires this to the
/// requesting client's socket, tagged with the original `requestId`.
pub type ProgressSink = Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientContext {
    pub connection_id: u64,
    pub client_id: String,
    pub surface: String,
    pub local: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveChatRoute {
    pub session_id: String,
    pub source_port: u16,
}

/// Async handler for `broker_control` requests. Given a command name + args
/// (+ a progress sink for streaming ops) it resolves to `Ok(result_json)` or
/// `Err(message)`. Injected from main.rs so the broker can run process/window
/// lifecycle and native ops on behalf of any client (desktop WebView, remote,
/// mobile) without main.rs and broker_ws forming a circular dependency.
pub type ControlHandler = Arc<
    dyn Fn(String, Value, ProgressSink, ClientContext) -> BoxFuture<'static, Result<Value, String>>
        + Send
        + Sync,
>;

#[derive(Default)]
struct BrokerInner {
    ui_clients: Mutex<HashMap<u64, Tx>>,
    upstreams: Mutex<HashMap<u16, Tx>>,
    routes: Mutex<HashMap<String, u16>>,
    disabled_ports: Mutex<HashSet<u16>>,
    active_port: Mutex<Option<u16>>,
    next_client_id: AtomicU64,
    control_handler: Mutex<Option<ControlHandler>>,
    upstream_event_observer: Mutex<Option<UpstreamEventObserver>>,
}

#[derive(Clone)]
pub struct BrokerWs {
    port: u16,
    inner: Arc<BrokerInner>,
}

impl BrokerWs {
    pub fn start() -> Result<Self, String> {
        let std_listener = std::net::TcpListener::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0))
            .map_err(|e| format!("Failed to bind broker websocket: {}", e))?;
        std_listener
            .set_nonblocking(true)
            .map_err(|e| format!("Failed to configure broker websocket: {}", e))?;
        let port = std_listener
            .local_addr()
            .map_err(|e| format!("Failed to read broker websocket address: {}", e))?
            .port();
        let broker = Self {
            port,
            inner: Arc::new(BrokerInner::default()),
        };
        let server = broker.clone();
        tauri::async_runtime::spawn(async move {
            let listener = match TcpListener::from_std(std_listener) {
                Ok(listener) => listener,
                Err(err) => {
                    log::error!("[broker-ws] failed to create Tokio listener: {}", err);
                    return;
                }
            };
            server.run(listener).await;
        });
        Ok(broker)
    }

    pub fn url(&self) -> String {
        format!("ws://127.0.0.1:{}/ui-ws", self.port)
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn set_active_port(&self, port: u16) {
        *self.inner.active_port.lock().unwrap() = Some(port);
    }

    pub fn active_port(&self) -> Option<u16> {
        *self.inner.active_port.lock().unwrap()
    }

    pub fn port_for_session(&self, session_id: &str) -> Option<u16> {
        self.inner
            .routes
            .lock()
            .unwrap()
            .get(session_id.trim())
            .copied()
    }

    pub fn live_chat_routes(&self) -> Vec<LiveChatRoute> {
        let mut routes = self
            .inner
            .routes
            .lock()
            .unwrap()
            .iter()
            .map(|(session_id, source_port)| LiveChatRoute {
                session_id: session_id.clone(),
                source_port: *source_port,
            })
            .collect::<Vec<_>>();
        routes.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        routes
    }

    /// Number of pi upstream connections the broker is currently maintaining.
    /// Used to detect when a global `active_port` fallback would be ambiguous:
    /// with more than one live pi process (multi-window / multi-workspace) the
    /// active_port belongs to whichever window registered most recently, so it
    /// cannot be safely used to guess the target of an unaddressed command.
    pub fn live_upstream_count(&self) -> usize {
        self.inner.upstreams.lock().unwrap().len()
    }

    /// Send a host-originated extension command through the same WebSocket
    /// transport used by the UI. Extension-only commands are not understood by
    /// pi's stdin RPC protocol, so they must be wrapped as a broker command.
    pub fn send_command_to_port(&self, port: u16, payload: Value) -> Result<(), String> {
        self.ensure_upstream(port);
        let upstream_tx = self
            .inner
            .upstreams
            .lock()
            .unwrap()
            .get(&port)
            .cloned()
            .ok_or_else(|| format!("Pi process on port {port} is unavailable"))?;
        let request_id = self.inner.next_client_id.fetch_add(1, Ordering::Relaxed);
        upstream_tx
            .send(
                json!({
                    "type": "broker_command",
                    "protocolVersion": PROTOCOL_VERSION,
                    "requestId": format!("host-{request_id}"),
                    "sourcePort": port,
                    "payload": payload,
                })
                .to_string(),
            )
            .map_err(|_| format!("Pi process on port {port} is unavailable"))
    }

    /// Install the handler used to execute `broker_control` requests. Called
    /// once from main.rs after PiManager + BrokerWs exist.
    pub fn set_control_handler(&self, handler: ControlHandler) {
        *self.inner.control_handler.lock().unwrap() = Some(handler);
    }

    pub fn set_upstream_event_observer(&self, observer: UpstreamEventObserver) {
        *self.inner.upstream_event_observer.lock().unwrap() = Some(observer);
    }

    pub fn register_session(&self, port: u16, session_id: &str) {
        log::info!(
            "[broker-ws] register_session port={} session_id={}",
            port,
            session_id
        );
        self.inner.disabled_ports.lock().unwrap().remove(&port);
        self.set_active_port(port);
        self.set_route(port, session_id);
        self.ensure_upstream(port);
    }

    /// Like `register_session` but does NOT promote this port to active_port.
    /// Use for background/dedicated session processes that should not become
    /// the default command target.
    pub fn track_background_session(&self, port: u16, session_id: &str) {
        self.inner.disabled_ports.lock().unwrap().remove(&port);
        self.set_route(port, session_id);
        self.ensure_upstream(port);
    }

    /// Point `session_id` at `port`, first evicting any other session id that
    /// previously resolved to this port.
    ///
    /// A `pi --mode rpc` process drives exactly ONE active session at a time, so
    /// a port maps to at most one session id. An in-place `new_session` /
    /// `switch_session` reuses the same port for a *different* session; without
    /// this eviction the PREVIOUS session id would keep pointing here. Because
    /// `resolve_command_port` consults the session-id route BEFORE `sourcePort`,
    /// a command still tagged with that now-defunct session would be silently
    /// misrouted into whatever session currently occupies the port — and would
    /// even override a correct `sourcePort` hint. Evicting stale entries keeps
    /// the routing table 1:1 with live sessions (fixes F1 + F2).
    fn set_route(&self, port: u16, session_id: &str) {
        let session_id = session_id.trim();
        let mut routes = self.inner.routes.lock().unwrap();
        // Drop every other session id resolving to this port; keep only the
        // entry for `session_id` itself (so a repeated learn stays idempotent).
        routes.retain(|existing, routed| *routed != port || existing == session_id);
        if !session_id.is_empty() {
            routes.insert(session_id.to_string(), port);
        }
    }

    pub fn unregister_port(&self, port: u16) {
        log::info!("[broker-ws] unregister_port port={}", port);
        self.inner.disabled_ports.lock().unwrap().insert(port);
        self.inner.upstreams.lock().unwrap().remove(&port);
        self.inner
            .routes
            .lock()
            .unwrap()
            .retain(|_, routed| *routed != port);
        let mut active = self.inner.active_port.lock().unwrap();
        if *active == Some(port) {
            *active = None;
        }
    }

    async fn run(self, listener: TcpListener) {
        loop {
            match listener.accept().await {
                Ok((stream, peer)) => {
                    let broker = self.clone();
                    tauri::async_runtime::spawn(async move {
                        broker
                            .handle_ui_client(stream, peer.ip().is_loopback())
                            .await;
                    });
                }
                Err(err) => {
                    log::warn!("[broker-ws] accept failed: {}", err);
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
            }
        }
    }

    async fn handle_ui_client(self, stream: TcpStream, local_client: bool) {
        let ws = match tokio_tungstenite::accept_async(stream).await {
            Ok(ws) => ws,
            Err(err) => {
                log::warn!("[broker-ws] UI websocket handshake failed: {}", err);
                return;
            }
        };
        let client_id = self.inner.next_client_id.fetch_add(1, Ordering::Relaxed);
        let (mut writer, mut reader) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        self.inner
            .ui_clients
            .lock()
            .unwrap()
            .insert(client_id, tx.clone());

        // Capability handshake: tell the client whether native (OS/window) ops
        // are available. Inside the desktop app a control handler is installed
        // (native:true); a bare broker without a handler can only forward chat.
        let native = self.inner.control_handler.lock().unwrap().is_some();
        let _ = tx.send(
            json!({
                "type": "capabilities",
                "protocolVersion": PROTOCOL_VERSION,
                "brokerConnectionId": client_id,
                "native": native,
            })
            .to_string(),
        );

        let writer_task = tauri::async_runtime::spawn(async move {
            while let Some(message) = rx.recv().await {
                if writer.send(Message::Text(message)).await.is_err() {
                    break;
                }
            }
        });

        while let Some(item) = reader.next().await {
            match item {
                Ok(Message::Text(text)) => {
                    self.route_ui_message(&text, &tx, local_client, client_id)
                }
                Ok(Message::Close(_)) => break,
                Ok(_) => {}
                Err(err) => {
                    log::warn!("[broker-ws] UI websocket read failed: {}", err);
                    break;
                }
            }
        }

        self.inner.ui_clients.lock().unwrap().remove(&client_id);
        writer_task.abort();
    }

    fn route_ui_message(&self, text: &str, client_tx: &Tx, local_client: bool, connection_id: u64) {
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            log::warn!("[broker-ws] invalid UI message");
            return;
        };

        // `broker_control` requests are NOT forwarded to a pi upstream — they are
        // process/window lifecycle or native ops handled by the host (Rust).
        // Dispatch to the injected control handler and reply to this client only.
        if value.get("type").and_then(Value::as_str) == Some("broker_control") {
            self.dispatch_control(&value, client_tx, local_client, connection_id);
            return;
        }

        let Some(port) = self.resolve_command_port(&value) else {
            log::warn!(
                "[broker-ws] no route for UI command={} request_id={:?} session_id={:?} source_port={:?}",
                value
                    .pointer("/payload/type")
                    .and_then(Value::as_str)
                    .unwrap_or_else(|| value.get("type").and_then(Value::as_str).unwrap_or("unknown")),
                value.get("requestId").and_then(Value::as_str),
                value.get("sessionId").and_then(Value::as_str),
                value.get("sourcePort").and_then(Value::as_u64),
            );
            self.notify_undeliverable(client_tx, &value, "no_route");
            return;
        };
        log::info!(
            "[broker-ws] route command={} request_id={:?} session_id={:?} source_port={:?} -> port={}",
            value.pointer("/payload/type").and_then(Value::as_str).unwrap_or_else(|| {
                value.get("type").and_then(Value::as_str).unwrap_or("unknown")
            }),
            value.get("requestId").and_then(Value::as_str),
            value.get("sessionId").and_then(Value::as_str),
            value.get("sourcePort").and_then(Value::as_u64),
            port
        );
        self.ensure_upstream(port);
        let upstream_tx = self.inner.upstreams.lock().unwrap().get(&port).cloned();
        // A `broker_command` is fire-and-forget on the wire, so a routing/delivery
        // failure here would otherwise vanish silently — the user sees their
        // prompt echoed but the agent never receives it. Reply to the sender with
        // a `command_undeliverable` frame (tagged with the original requestId) so
        // the UI can surface the loss instead of hanging (F3). `ensure_upstream`
        // queues into the channel even while reconnecting, so a `None` tx (or a
        // closed channel) means the port is genuinely gone (killed/disabled).
        let delivered = match upstream_tx {
            Some(tx) => tx.send(text.to_string()).is_ok(),
            None => false,
        };
        if !delivered {
            log::warn!("[broker-ws] upstream {} unavailable; command dropped", port);
            self.notify_undeliverable(client_tx, &value, "upstream_unavailable");
        }
    }

    /// Reply to the originating UI client that a `broker_command` could not be
    /// delivered. Tagged with the original `requestId` so the frontend can
    /// correlate it to the in-flight prompt and surface a visible error.
    fn notify_undeliverable(&self, client_tx: &Tx, value: &Value, reason: &str) {
        let request_id = value.get("requestId").and_then(Value::as_str).unwrap_or("");
        let command = value
            .pointer("/payload/type")
            .and_then(Value::as_str)
            .or_else(|| value.get("type").and_then(Value::as_str))
            .unwrap_or("");
        let _ = client_tx.send(
            json!({
                "type": "command_undeliverable",
                "protocolVersion": PROTOCOL_VERSION,
                "requestId": request_id,
                "command": command,
                "reason": reason,
                "sessionId": value.get("sessionId").cloned().unwrap_or(Value::Null),
            })
            .to_string(),
        );
    }

    fn dispatch_control(
        &self,
        value: &Value,
        client_tx: &Tx,
        local_client: bool,
        connection_id: u64,
    ) {
        let request_id = value
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let command = value
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let args = value.get("args").cloned().unwrap_or(Value::Null);
        let client_id = value
            .get("clientId")
            .and_then(Value::as_str)
            .filter(|id| {
                !id.is_empty()
                    && id.len() <= 128
                    && id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"._-:".contains(&byte))
            })
            .map(str::to_owned)
            .unwrap_or_else(|| format!("connection-{connection_id}"));
        let surface = value
            .get("clientSurface")
            .and_then(Value::as_str)
            .filter(|surface| matches!(*surface, "gui" | "tui" | "headless" | "remote"))
            .unwrap_or(if local_client { "gui" } else { "remote" })
            .to_owned();
        let client = ClientContext {
            connection_id,
            client_id,
            surface,
            local: local_client,
        };

        let handler = self.inner.control_handler.lock().unwrap().clone();
        let tx = client_tx.clone();

        let Some(handler) = handler else {
            let _ = tx.send(
                json!({
                    "type": "control_response",
                    "requestId": request_id,
                    "ok": false,
                    "error": "Control commands are not available on this server",
                })
                .to_string(),
            );
            return;
        };

        // Progress sink: streams intermediate frames (e.g. updater download
        // chunks) back to the requesting client, tagged with the requestId.
        let progress_tx = tx.clone();
        let progress_request_id = request_id.clone();
        let sink: ProgressSink = Arc::new(move |data: Value| {
            let _ = progress_tx.send(
                json!({
                    "type": "control_progress",
                    "requestId": progress_request_id,
                    "data": data,
                })
                .to_string(),
            );
        });

        log::info!(
            "[broker-ws] control command={} request_id={}",
            command,
            request_id
        );
        tauri::async_runtime::spawn(async move {
            let response = match handler(command.clone(), args, sink, client).await {
                Ok(result) => json!({
                    "type": "control_response",
                    "requestId": request_id,
                    "ok": true,
                    "result": result,
                }),
                Err(error) => {
                    log::warn!("[broker-ws] control command {} failed: {}", command, error);
                    json!({
                        "type": "control_response",
                        "requestId": request_id,
                        "ok": false,
                        "error": error,
                    })
                }
            };
            let _ = tx.send(response.to_string());
        });
    }

    fn resolve_command_port(&self, value: &Value) -> Option<u16> {
        let session_id = value
            .get("sessionId")
            .and_then(Value::as_str)
            .or_else(|| value.pointer("/payload/sessionId").and_then(Value::as_str))
            .or_else(|| {
                value
                    .pointer("/payload/sessionFile")
                    .and_then(Value::as_str)
            })
            .or_else(|| {
                value
                    .pointer("/payload/sessionPath")
                    .and_then(Value::as_str)
            });
        let source_port = value
            .get("sourcePort")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok());
        let command = value
            .pointer("/payload/type")
            .and_then(Value::as_str)
            .or_else(|| value.get("type").and_then(Value::as_str));
        if let Some(session_id) = session_id {
            if let Some(port) = self.inner.routes.lock().unwrap().get(session_id).copied() {
                // The session route is authoritative — it is learned from real
                // upstream traffic and kept 1:1 with live sessions by set_route.
                // A disagreeing sourcePort means the client's foreground-port
                // hint has drifted; trust the route but make it observable so a
                // genuine misroute can never hide (F2).
                if let Some(source_port) = source_port {
                    if source_port != port {
                        log::warn!(
                            "[broker-ws] route/source_port disagree: session_id={} -> port={} but source_port={}; trusting session route",
                            session_id,
                            port,
                            source_port
                        );
                    }
                }
                return Some(port);
            }

            // Prompts are durable writes to a conversation. If the UI names a
            // session that the broker cannot currently resolve, sourcePort may
            // still point at the previously viewed chat while a dedicated Pi
            // process is starting (or after a failed switch). Falling back in
            // that state writes both the user message and assistant response to
            // the wrong session. Fail closed and let command_undeliverable put
            // the text back in the composer so the user can retry safely.
            if !session_id.trim().is_empty() && command == Some("prompt") {
                return None;
            }
        }
        if let Some(source_port) = source_port {
            return Some(source_port);
        }
        // Last resort: the global active_port. Safe only when unambiguous — with
        // multiple live pi processes it belongs to whichever window registered
        // most recently, so guessing it would misroute an unaddressed command
        // into another window's session. When ambiguous, return None so the
        // command surfaces as undeliverable (F3) instead of misrouting (F4).
        let active = *self.inner.active_port.lock().unwrap();
        if self.inner.upstreams.lock().unwrap().len() > 1 {
            log::warn!(
                "[broker-ws] refusing ambiguous active_port fallback ({:?}) among {} live upstreams",
                active,
                self.inner.upstreams.lock().unwrap().len()
            );
            return None;
        }
        active
    }

    fn ensure_upstream(&self, port: u16) {
        if self.inner.disabled_ports.lock().unwrap().contains(&port) {
            return;
        }
        // Insert the sender inside the lock before spawning so that a second
        // concurrent call sees the key and returns early — eliminates the
        // TOCTOU window between the contains_key check and the spawn.
        let rx = {
            let mut upstreams = self.inner.upstreams.lock().unwrap();
            if upstreams.contains_key(&port) {
                return;
            }
            let (tx, rx) = mpsc::unbounded_channel::<String>();
            upstreams.insert(port, tx);
            rx
        };
        let broker = self.clone();
        tauri::async_runtime::spawn(async move {
            broker.run_upstream(port, rx).await;
        });
    }

    async fn run_upstream(self, port: u16, mut rx: mpsc::UnboundedReceiver<String>) {
        let url = format!("ws://127.0.0.1:{}/ws", port);

        loop {
            if self.inner.disabled_ports.lock().unwrap().contains(&port) {
                self.inner.upstreams.lock().unwrap().remove(&port);
                return;
            }
            match tokio_tungstenite::connect_async(&url).await {
                Ok((ws, _)) => {
                    log::info!("[broker-ws] connected upstream port {}", port);
                    let (mut writer, mut reader) = ws.split();
                    let mut shutdown_check =
                        tokio::time::interval(std::time::Duration::from_millis(500));
                    loop {
                        tokio::select! {
                            _ = shutdown_check.tick() => {
                                if self.inner.disabled_ports.lock().unwrap().contains(&port) {
                                    self.inner.upstreams.lock().unwrap().remove(&port);
                                    return;
                                }
                            }
                            Some(outbound) = rx.recv() => {
                                if writer.send(Message::Text(outbound)).await.is_err() {
                                    break;
                                }
                            }
                            inbound = reader.next() => {
                                match inbound {
                                    Some(Ok(Message::Text(text))) => {
                                        if let Some(message) = self.wrap_upstream_message(port, &text) {
                                            self.broadcast(&message);
                                        }
                                    }
                                    Some(Ok(Message::Close(_))) | None => break,
                                    Some(Ok(_)) => {}
                                    Some(Err(err)) => {
                                        log::warn!("[broker-ws] upstream {} read failed: {}", port, err);
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    log::warn!(
                        "[broker-ws] upstream port {} disconnected; reconnecting",
                        port
                    );
                }
                Err(err) => {
                    log::warn!("[broker-ws] upstream {} connect failed: {}", port, err);
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(750)).await;
        }
    }

    fn wrap_upstream_message(&self, port: u16, text: &str) -> Option<String> {
        let Ok(payload) = serde_json::from_str::<Value>(text) else {
            return None;
        };
        if let Some(session_id) = extract_session_id(&payload) {
            log::debug!(
                "[broker-ws] learn route session_id={} -> port={}",
                session_id,
                port
            );
            // Use set_route (not a bare insert) so an in-place `new_session` —
            // which reuses the port and is only ever observed through this
            // learn path (`new_session_core` does not call register_session) —
            // evicts the previous session's now-defunct route on this port.
            self.set_route(port, session_id);
        }
        if let Some(observer) = self.inner.upstream_event_observer.lock().unwrap().clone() {
            observer(port, payload.clone());
        }
        let workspace_id = payload.get("workspaceId").cloned().unwrap_or(Value::Null);
        let session_id = payload.get("sessionId").cloned().unwrap_or(Value::Null);
        Some(
            json!({
                "type": "broker_event",
                "protocolVersion": PROTOCOL_VERSION,
                "workspaceId": workspace_id,
                "sessionId": session_id,
                "sourcePort": port,
                "payload": payload,
            })
            .to_string(),
        )
    }

    fn broadcast(&self, message: &str) {
        let mut stale = Vec::new();
        let clients = self.inner.ui_clients.lock().unwrap();
        for (id, tx) in clients.iter() {
            if tx.send(message.to_string()).is_err() {
                stale.push(*id);
            }
        }
        drop(clients);
        if !stale.is_empty() {
            let mut clients = self.inner.ui_clients.lock().unwrap();
            for id in stale {
                clients.remove(&id);
            }
        }
    }
}

fn extract_session_id(payload: &Value) -> Option<&str> {
    payload
        .get("sessionId")
        .and_then(Value::as_str)
        .or_else(|| payload.get("sessionFile").and_then(Value::as_str))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_session_id_prefers_route_metadata() {
        let payload = json!({
            "sessionId": "session-id",
            "sessionFile": "session-file"
        });

        assert_eq!(extract_session_id(&payload), Some("session-id"));
    }

    #[test]
    fn command_routes_by_session_id_before_active_port() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        broker.set_active_port(47821);
        broker.register_session(47822, "/tmp/session-b.jsonl");

        let command = json!({
            "type": "broker_command",
            "sessionId": "/tmp/session-b.jsonl",
            "payload": { "type": "mirror_sync_request" }
        });

        assert_eq!(broker.resolve_command_port(&command), Some(47822));
    }

    #[test]
    fn command_falls_back_to_active_port_without_route() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        broker.set_active_port(47821);

        assert_eq!(
            broker.resolve_command_port(&json!({ "type": "broker_command" })),
            Some(47821)
        );
    }

    #[test]
    fn in_place_session_swap_evicts_previous_session_route() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        // An unrelated session the user is NOT viewing lives on its own port.
        broker.register_session(47822, "/tmp/other.jsonl");
        // Port 47821 first hosts session A...
        broker.register_session(47821, "/tmp/session-a.jsonl");
        // ...then swaps in-place to session B (same port reused).
        broker.register_session(47821, "/tmp/session-b.jsonl");

        let routes = broker.inner.routes.lock().unwrap();
        // The now-defunct session A must no longer resolve anywhere (F1).
        assert_eq!(routes.get("/tmp/session-a.jsonl"), None);
        assert_eq!(routes.get("/tmp/session-b.jsonl"), Some(&47821));
        // Eviction is scoped to the reused port — unrelated routes are intact.
        assert_eq!(routes.get("/tmp/other.jsonl"), Some(&47822));
    }

    #[test]
    fn evicted_session_id_does_not_override_source_port_for_non_prompt_commands() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        // Port 50001 hosted session A, then swapped in-place to session B.
        broker.register_session(50001, "/tmp/session-a.jsonl");
        broker.register_session(50001, "/tmp/session-b.jsonl");

        // A non-chat command still tagged with the defunct session A but
        // carrying the correct live source port (50002) may fall back to
        // source_port — the stale A route is gone, so it cannot hijack the
        // command (F2).
        assert_eq!(
            broker.resolve_command_port(&json!({
                "type": "broker_command",
                "sessionId": "/tmp/session-a.jsonl",
                "sourcePort": 50002,
                "payload": { "type": "mirror_sync_request" }
            })),
            Some(50002)
        );
    }

    #[test]
    fn prompt_with_unknown_session_never_falls_back_to_another_source_port() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        broker.register_session(47821, "/tmp/current-session.jsonl");

        // This is the exact failure pattern from a dedicated session process
        // that has not become ready yet: the UI already names the selected
        // history session, while sourcePort still points at the previous live
        // process. Sending the prompt to 47821 would append the user's message
        // and the assistant response to the wrong chat.
        assert_eq!(
            broker.resolve_command_port(&json!({
                "type": "broker_command",
                "sessionId": "/tmp/selected-history-session.jsonl",
                "sourcePort": 47821,
                "payload": { "type": "prompt", "message": "hello" }
            })),
            None
        );
    }

    #[test]
    fn refuses_ambiguous_active_port_fallback_with_multiple_upstreams() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        // Two windows / workspaces are live; active_port is whichever registered
        // last (47822), which has nothing to do with where an unaddressed command
        // from the OTHER window should go.
        broker.register_session(47821, "/tmp/a.jsonl");
        broker.register_session(47822, "/tmp/b.jsonl");

        // A command with neither a known session route nor a sourcePort must not
        // be silently routed to the global active_port — it surfaces as
        // undeliverable instead of misrouting across windows (F4).
        assert_eq!(
            broker.resolve_command_port(&json!({
                "type": "broker_command",
                "payload": { "type": "prompt" }
            })),
            None
        );

        // An explicit sourcePort is still honored even with multiple upstreams.
        assert_eq!(
            broker.resolve_command_port(&json!({
                "type": "broker_command",
                "sourcePort": 47821,
                "payload": { "type": "prompt" }
            })),
            Some(47821)
        );
    }

    #[test]
    fn command_routes_by_source_port_when_session_route_is_unknown() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        broker.set_active_port(47821);

        assert_eq!(
            broker.resolve_command_port(&json!({
                "type": "broker_command",
                "sessionId": "/tmp/unknown-session.jsonl",
                "sourcePort": 47824,
                "payload": { "type": "mirror_sync_request" }
            })),
            Some(47824)
        );
    }

    #[test]
    fn host_extension_command_is_wrapped_for_the_upstream_websocket() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        let (tx, mut rx) = mpsc::unbounded_channel();
        broker.inner.upstreams.lock().unwrap().insert(47821, tx);

        broker
            .send_command_to_port(47821, json!({ "type": "picot_reload_accounts" }))
            .unwrap();

        let message: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(
            message.get("type").and_then(Value::as_str),
            Some("broker_command")
        );
        assert_eq!(
            message.get("sourcePort").and_then(Value::as_u64),
            Some(47821)
        );
        assert_eq!(
            message.pointer("/payload/type").and_then(Value::as_str),
            Some("picot_reload_accounts")
        );
    }
}
