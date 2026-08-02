use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use picode::core_locator::{read_locator, CORE_LOCATOR_FILE};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, BufRead, IsTerminal, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use uuid::Uuid;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type SocketWriter = SplitSink<Socket, Message>;
type SocketReader = SplitStream<Socket>;

#[derive(Debug, PartialEq)]
struct TuiOptions {
    broker_port: Option<u16>,
    source_port: Option<u16>,
    locator_path: Option<PathBuf>,
    chat_id: Option<String>,
}

fn parse_options(args: &[String]) -> Result<TuiOptions, String> {
    let mut options = TuiOptions {
        broker_port: None,
        source_port: None,
        locator_path: None,
        chat_id: None,
    };
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--broker-port" => {
                index += 1;
                options.broker_port = Some(parse_port(args.get(index), "--broker-port")?);
            }
            "--source-port" => {
                index += 1;
                options.source_port = Some(parse_port(args.get(index), "--source-port")?);
            }
            "--locator" => {
                index += 1;
                options.locator_path = Some(PathBuf::from(
                    args.get(index).ok_or("--locator requires a path")?,
                ));
            }
            "--chat" => {
                index += 1;
                options.chat_id = Some(required_text(args.get(index), "--chat")?.to_owned());
            }
            "--help" | "-h" => {
                return Err(
                    "usage: picode-tui [--broker-port PORT] [--source-port PI_PORT] [--locator PATH] [--chat CHAT_ID]"
                        .into(),
                )
            }
            other => return Err(format!("unknown option: {other}")),
        }
        index += 1;
    }
    Ok(options)
}

fn parse_port(value: Option<&String>, option: &str) -> Result<u16, String> {
    let port = value
        .ok_or_else(|| format!("{option} requires a value"))?
        .parse::<u16>()
        .map_err(|_| format!("{option} must be a valid port"))?;
    if port == 0 {
        return Err(format!("{option} must be non-zero"));
    }
    Ok(port)
}

fn required_text<'a>(value: Option<&'a String>, option: &str) -> Result<&'a str, String> {
    value
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{option} requires a non-empty value"))
}

#[derive(Debug, PartialEq)]
enum TuiCommand {
    Help,
    Refresh,
    View(String),
    Sessions,
    New {
        kind: String,
        workspace_id: Option<String>,
        title: String,
    },
    Use(String),
    Load,
    Prompt(String),
    Cancel,
    Fork,
    Archive(bool),
    Rename(String),
    Herdr,
    Control {
        command: String,
        args: Value,
    },
    Quit,
}

fn parse_command(line: &str) -> Result<TuiCommand, String> {
    let line = line.trim();
    if line.is_empty() {
        return Err("empty input".into());
    }
    if !line.starts_with('/') {
        return Ok(TuiCommand::Prompt(line.into()));
    }
    let (command, rest) = line
        .split_once(char::is_whitespace)
        .map(|(command, rest)| (command, rest.trim()))
        .unwrap_or((line, ""));
    match command {
        "/help" | "/?" => Ok(TuiCommand::Help),
        "/refresh" | "/snapshot" => Ok(TuiCommand::Refresh),
        "/accounts" => Ok(TuiCommand::View("accounts".into())),
        "/models" => Ok(TuiCommand::View("accounts".into())),
        "/tasks" => Ok(TuiCommand::View("tasks".into())),
        "/extensions" | "/plugins" => Ok(TuiCommand::View("extensions".into())),
        "/work" => Ok(TuiCommand::View("work".into())),
        "/runtime" => Ok(TuiCommand::View("runtime".into())),
        "/packages" | "/skills" => Ok(TuiCommand::View("packages".into())),
        "/sessions" => Ok(TuiCommand::Sessions),
        "/use" => Ok(TuiCommand::Use(required_rest(rest, "/use CHAT_ID")?)),
        "/load" => Ok(TuiCommand::Load),
        "/prompt" => Ok(TuiCommand::Prompt(required_rest(rest, "/prompt MESSAGE")?)),
        "/cancel" => Ok(TuiCommand::Cancel),
        "/fork" => Ok(TuiCommand::Fork),
        "/archive" => Ok(TuiCommand::Archive(true)),
        "/unarchive" => Ok(TuiCommand::Archive(false)),
        "/rename" => Ok(TuiCommand::Rename(required_rest(rest, "/rename TITLE")?)),
        "/herdr" => Ok(TuiCommand::Herdr),
        "/quit" | "/exit" => Ok(TuiCommand::Quit),
        "/new" => parse_new_command(rest),
        "/control" => parse_control_command(rest),
        _ => Err(format!("unknown command: {command}; use /help")),
    }
}

fn required_rest(rest: &str, usage: &str) -> Result<String, String> {
    if rest.is_empty() {
        Err(format!("usage: {usage}"))
    } else {
        Ok(rest.to_owned())
    }
}

fn parse_new_command(rest: &str) -> Result<TuiCommand, String> {
    let mut words = rest.split_whitespace();
    let kind = words.next().unwrap_or("simple");
    match kind {
        "simple" => Ok(TuiCommand::New {
            kind: kind.into(),
            workspace_id: None,
            title: words.collect::<Vec<_>>().join(" "),
        }),
        "harness" => {
            let workspace_id = words
                .next()
                .ok_or("usage: /new harness WORKSPACE_ID [TITLE]")?;
            Ok(TuiCommand::New {
                kind: kind.into(),
                workspace_id: Some(workspace_id.into()),
                title: words.collect::<Vec<_>>().join(" "),
            })
        }
        _ => Err("session kind must be simple or harness".into()),
    }
}

fn parse_control_command(rest: &str) -> Result<TuiCommand, String> {
    let (command, encoded) = rest
        .split_once(char::is_whitespace)
        .map(|(command, encoded)| (command, encoded.trim()))
        .unwrap_or((rest, "{}"));
    if command.is_empty() {
        return Err("usage: /control COMMAND [JSON_OBJECT]".into());
    }
    let args: Value = serde_json::from_str(encoded)
        .map_err(|error| format!("invalid control arguments: {error}"))?;
    if !args.is_object() {
        return Err("control arguments must be a JSON object".into());
    }
    Ok(TuiCommand::Control {
        command: command.into(),
        args,
    })
}

fn locator_candidates(explicit: Option<&PathBuf>) -> Vec<PathBuf> {
    if let Some(explicit) = explicit {
        return vec![explicit.clone()];
    }
    let mut candidates = Vec::new();
    if let Ok(root) = std::env::var("PICODE_APP_DATA_DIR") {
        candidates.push(PathBuf::from(root).join(CORE_LOCATOR_FILE));
    }
    if let Some(root) = dirs::data_dir() {
        candidates.push(root.join("works.earendil.picot").join(CORE_LOCATOR_FILE));
    }
    if let Some(root) = dirs::data_local_dir() {
        let candidate = root.join("works.earendil.picot").join(CORE_LOCATOR_FILE);
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    candidates
}

fn resolve_broker_port(options: &TuiOptions) -> Result<u16, String> {
    if let Some(port) = options.broker_port {
        return Ok(port);
    }
    if let Ok(value) = std::env::var("PICODE_BROKER_PORT") {
        return parse_port(Some(&value), "PICODE_BROKER_PORT");
    }
    let mut errors = Vec::new();
    for path in locator_candidates(options.locator_path.as_ref()) {
        match read_locator(&path) {
            Ok(locator) => return Ok(locator.broker_port),
            Err(error) => errors.push(format!("{}: {error}", path.display())),
        }
    }
    Err(format!(
        "Picode Core was not found. Start the GUI or pass --broker-port. Checked: {}",
        errors.join("; ")
    ))
}

struct BrokerClient {
    client_id: String,
    broker_port: u16,
    writer: Arc<AsyncMutex<SocketWriter>>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>,
}

#[derive(Clone, Debug)]
struct TuiLease {
    chat_id: String,
    generation: u64,
}

impl BrokerClient {
    async fn connect(port: u16) -> Result<(Self, mpsc::UnboundedReceiver<Value>), String> {
        let url = format!("ws://127.0.0.1:{port}/ui-ws");
        let (socket, _) = tokio_tungstenite::connect_async(&url)
            .await
            .map_err(|error| format!("Connect to Picode Core at {url}: {error}"))?;
        let (writer, reader) = socket.split();
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        spawn_reader(reader, pending.clone(), event_tx);
        Ok((
            Self {
                client_id: format!("tui-{}-{}", std::process::id(), Uuid::new_v4().simple()),
                broker_port: port,
                writer: Arc::new(AsyncMutex::new(writer)),
                pending,
            },
            event_rx,
        ))
    }

    async fn control(&self, command: &str, args: Value) -> Result<Value, String> {
        let request_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| "TUI pending request lock is poisoned".to_owned())?
            .insert(request_id.clone(), tx);
        let frame = json!({
            "type": "broker_control",
            "protocolVersion": 1,
            "clientId": self.client_id,
            "clientSurface": "tui",
            "requestId": request_id,
            "command": command,
            "args": args,
        });
        if let Err(error) = self
            .writer
            .lock()
            .await
            .send(Message::Text(frame.to_string()))
            .await
        {
            self.pending
                .lock()
                .ok()
                .and_then(|mut map| map.remove(&request_id));
            return Err(format!("Send control request: {error}"));
        }
        tokio::time::timeout(std::time::Duration::from_secs(120), rx)
            .await
            .map_err(|_| format!("Control command {command:?} timed out"))?
            .map_err(|_| "Picode Core disconnected before responding".to_owned())?
    }

    async fn snapshot(&self) -> Result<Value, String> {
        self.control(
            "client_snapshot",
            json!({
                "clientId": self.client_id,
                "surface": "tui",
                "protocolVersion": 1,
            }),
        )
        .await
    }

    async fn acp(
        &self,
        method: &str,
        params: Value,
        source_port: Option<u16>,
        lease: Option<&TuiLease>,
        mutation_request_id: Option<&str>,
    ) -> Result<Value, String> {
        let mut args = json!({
            "request": {
                "id": Uuid::new_v4().to_string(),
                "method": method,
                "params": params,
            }
        });
        if let Some(port) = source_port {
            args["sourcePort"] = json!(port);
        }
        if let Some(lease) = lease {
            args["conversationGeneration"] = json!(lease.generation);
        }
        if let Some(request_id) = mutation_request_id {
            args["mutationRequestId"] = json!(request_id);
        }
        self.control("acp_request", args).await
    }
}

fn spawn_reader(
    mut reader: SocketReader,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>,
    events: mpsc::UnboundedSender<Value>,
) {
    tokio::spawn(async move {
        while let Some(message) = reader.next().await {
            let Ok(Message::Text(text)) = message else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if value.get("type").and_then(Value::as_str) == Some("control_response") {
                let Some(request_id) = value.get("requestId").and_then(Value::as_str) else {
                    continue;
                };
                let sender = pending
                    .lock()
                    .ok()
                    .and_then(|mut map| map.remove(request_id));
                if let Some(sender) = sender {
                    let response = if value.get("ok").and_then(Value::as_bool) == Some(true) {
                        Ok(value.get("result").cloned().unwrap_or(Value::Null))
                    } else {
                        Err(value
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("Picode control request failed")
                            .to_owned())
                    };
                    let _ = sender.send(response);
                }
            } else {
                let _ = events.send(value);
            }
        }
        if let Ok(mut pending) = pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err("Picode Core disconnected".into()));
            }
        }
    });
}

fn render_snapshot(snapshot: &Value) -> String {
    let mut output = String::from("Picode shared workflow\n");
    for (label, key) in [
        ("Accounts / configured models", "accounts"),
        ("Managed Chat Sessions", "sessions"),
        ("Live GUI/TUI chats", "liveChats"),
        ("Tasks / orchestration", "tasks"),
        ("Extensions", "extensions"),
        ("Work", "work"),
        ("Runtime", "runtime"),
        ("Pi packages / Skills", "packages"),
    ] {
        output.push_str(&format!("\n{label}:\n{}\n", render_value(&snapshot[key])));
    }
    output
}

fn render_value(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "<unavailable>".into())
}

fn render_event(value: &Value) -> Option<String> {
    if value.get("type").and_then(Value::as_str) == Some("capabilities") {
        return Some("Connected to Picode Core.".into());
    }
    if value.get("type").and_then(Value::as_str) != Some("broker_event") {
        return None;
    }
    let payload = value.get("payload")?;
    let kind = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("event");
    let session = value
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or("unbound");
    match kind {
        "message_end" => Some(format!(
            "[{session}] message: {}",
            render_value(payload.get("message").unwrap_or(&Value::Null))
        )),
        "agent_start" | "agent_end" | "tool_execution_start" | "tool_execution_end" => {
            Some(format!("[{session}] {kind}"))
        }
        _ => None,
    }
}

fn print_help() {
    println!(
        "Commands:\n  /refresh  /accounts  /models  /tasks  /extensions  /work  /runtime  /packages\n  /sessions  /new [simple TITLE | harness WORKSPACE_ID TITLE]  /use CHAT_ID  /load\n  /prompt MESSAGE (or type MESSAGE directly)  /cancel  /fork  /rename TITLE  /archive  /unarchive\n  /herdr (open this managed workflow in the optional Herdr host)\n  /control COMMAND JSON_OBJECT  /quit\n\nThe command palette calls the same Picode controls as the GUI. Raw `pi` sessions started outside Picode are unmanaged."
    );
}

fn selected_chat(chat_id: &Option<String>) -> Result<&str, String> {
    chat_id
        .as_deref()
        .ok_or_else(|| "Select a chat with /use CHAT_ID or create one with /new".into())
}

async fn claim_tui_control(client: &BrokerClient, chat_id: &str) -> Result<TuiLease, String> {
    let mut claim = client
        .control("conversation_claim", json!({ "chatId": chat_id }))
        .await?;
    if claim.get("decision").and_then(Value::as_str) == Some("observing")
        && claim.pointer("/control/state").and_then(Value::as_str) == Some("suspect")
    {
        let deadline = claim
            .pointer("/control/controller/challengeDeadline")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let wait_ms = deadline.saturating_sub(now).min(10_000);
        if wait_ms > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(wait_ms)).await;
        }
        if client
            .control("conversation_probe_failed", json!({ "chatId": chat_id }))
            .await
            .is_ok()
        {
            claim = client
                .control("conversation_claim", json!({ "chatId": chat_id }))
                .await?;
        }
    }
    if claim.get("decision").and_then(Value::as_str) != Some("granted") {
        let state = claim
            .pointer("/control/state")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let owner = claim
            .pointer("/control/controller/clientId")
            .and_then(Value::as_str)
            .unwrap_or("another client");
        return Err(format!(
            "Chat is observer-only ({state}); controlled by {owner}. Input was not sent."
        ));
    }
    let generation = claim
        .pointer("/control/controller/generation")
        .and_then(Value::as_u64)
        .ok_or("Conversation claim did not return a fencing generation")?;
    Ok(TuiLease {
        chat_id: chat_id.into(),
        generation,
    })
}

async fn ensure_tui_control(
    client: &BrokerClient,
    lease: &mut Option<TuiLease>,
    chat_id: &str,
) -> Result<TuiLease, String> {
    if let Some(current) = lease.as_ref().filter(|current| current.chat_id == chat_id) {
        return Ok(current.clone());
    }
    let claimed = claim_tui_control(client, chat_id).await?;
    *lease = Some(claimed.clone());
    Ok(claimed)
}

fn runtime_chat_id<'a>(snapshot: &'a Value, chat_id: &'a str) -> &'a str {
    snapshot
        .get("sessions")
        .and_then(Value::as_array)
        .and_then(|sessions| {
            sessions
                .iter()
                .find(|session| session.get("id").and_then(Value::as_str) == Some(chat_id))
        })
        .and_then(|session| session.get("externalSessionId"))
        .and_then(Value::as_str)
        .unwrap_or(chat_id)
}

fn live_chat_port(snapshot: &Value, chat_id: &str) -> Option<u16> {
    let runtime_id = runtime_chat_id(snapshot, chat_id);
    snapshot
        .get("liveChats")?
        .as_array()?
        .iter()
        .find(|route| route.get("sessionId").and_then(Value::as_str) == Some(runtime_id))?
        .get("sourcePort")?
        .as_u64()
        .and_then(|port| u16::try_from(port).ok())
}

async fn execute_command(
    client: &BrokerClient,
    command: TuiCommand,
    snapshot: &mut Value,
    chat_id: &mut Option<String>,
    lease: &mut Option<TuiLease>,
    source_port: Option<u16>,
) -> Result<bool, String> {
    let result = match command {
        TuiCommand::Help => {
            print_help();
            return Ok(true);
        }
        TuiCommand::Refresh => {
            *snapshot = client.snapshot().await?;
            println!("{}", render_snapshot(snapshot));
            return Ok(true);
        }
        TuiCommand::View(key) => {
            println!("{}", render_value(&snapshot[&key]));
            return Ok(true);
        }
        TuiCommand::Sessions => {
            println!("Managed sessions:\n{}", render_value(&snapshot["sessions"]));
            println!("Live chats:\n{}", render_value(&snapshot["liveChats"]));
            return Ok(true);
        }
        TuiCommand::New {
            kind,
            workspace_id,
            title,
        } => {
            let mut params = json!({ "kind": kind });
            if !title.is_empty() {
                params["title"] = json!(title);
            }
            if let Some(workspace_id) = workspace_id {
                params["workspaceId"] = json!(workspace_id);
            }
            let created = client
                .acp("session/new", params, source_port, None, None)
                .await?;
            *chat_id = created
                .pointer("/result/sessionId")
                .or_else(|| created.get("sessionId"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            created
        }
        TuiCommand::Use(selected) => {
            if let Some(current) = lease.take() {
                let _ = client
                    .control(
                        "conversation_release",
                        json!({ "chatId": current.chat_id, "generation": current.generation }),
                    )
                    .await;
            }
            match claim_tui_control(client, &selected).await {
                Ok(claimed) => *lease = Some(claimed),
                Err(error) => eprintln!("{error}"),
            }
            *chat_id = Some(selected);
            json!({ "selected": chat_id })
        }
        TuiCommand::Load => {
            client
                .acp(
                    "session/load",
                    json!({ "sessionId": selected_chat(chat_id)? }),
                    source_port,
                    None,
                    None,
                )
                .await?
        }
        TuiCommand::Prompt(message) => {
            let session_id = selected_chat(chat_id)?;
            let request_id = Uuid::new_v4().to_string();
            let lease = ensure_tui_control(client, lease, session_id)
                .await
                .map_err(|error| format!("{error}\nDraft: {message}"))?;
            if let Some(port) = live_chat_port(snapshot, session_id) {
                let runtime_session_id = runtime_chat_id(snapshot, session_id);
                client
                    .control(
                        "chat_runtime_command",
                        json!({
                            "sessionId": runtime_session_id,
                            "sourcePort": port,
                            "conversationGeneration": lease.generation,
                            "mutationRequestId": request_id,
                            "payload": {
                                "type": "prompt",
                                "message": message,
                                "requestId": request_id,
                            }
                        }),
                    )
                    .await?
            } else {
                client
                    .acp(
                        "session/prompt",
                        json!({
                            "sessionId": session_id,
                            "requestId": request_id,
                            "message": message,
                        }),
                        source_port,
                        Some(&lease),
                        Some(&request_id),
                    )
                    .await?
            }
        }
        TuiCommand::Cancel => {
            let session_id = selected_chat(chat_id)?;
            let mutation_request_id = Uuid::new_v4().to_string();
            let lease = ensure_tui_control(client, lease, session_id).await?;
            if let Some(port) = live_chat_port(snapshot, session_id) {
                let runtime_session_id = runtime_chat_id(snapshot, session_id);
                client
                    .control(
                        "chat_runtime_command",
                        json!({
                            "sessionId": runtime_session_id,
                            "sourcePort": port,
                            "conversationGeneration": lease.generation,
                            "mutationRequestId": mutation_request_id,
                            "payload": { "type": "abort" }
                        }),
                    )
                    .await?
            } else {
                client
                    .acp(
                        "session/cancel",
                        json!({ "sessionId": session_id }),
                        source_port,
                        Some(&lease),
                        Some(&mutation_request_id),
                    )
                    .await?
            }
        }
        TuiCommand::Fork => {
            let session_id = selected_chat(chat_id)?;
            if let Some(port) = live_chat_port(snapshot, session_id) {
                client
                    .control("clone_session", json!({ "port": port }))
                    .await?
            } else {
                let forked = client
                    .acp(
                        "session/fork",
                        json!({ "sessionId": session_id }),
                        source_port,
                        None,
                        None,
                    )
                    .await?;
                *chat_id = forked
                    .pointer("/result/sessionId")
                    .or_else(|| forked.get("sessionId"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                forked
            }
        }
        TuiCommand::Archive(archived) => {
            let session_id = selected_chat(chat_id)?;
            let lease = ensure_tui_control(client, lease, session_id).await?;
            let mutation_request_id = Uuid::new_v4().to_string();
            client
                .acp(
                    "session/archive",
                    json!({ "sessionId": session_id, "archived": archived }),
                    source_port,
                    Some(&lease),
                    Some(&mutation_request_id),
                )
                .await?
        }
        TuiCommand::Rename(title) => {
            let session_id = selected_chat(chat_id)?;
            let lease = ensure_tui_control(client, lease, session_id).await?;
            let mutation_request_id = Uuid::new_v4().to_string();
            client
                .acp(
                    "session/rename",
                    json!({ "sessionId": session_id, "title": title }),
                    source_port,
                    Some(&lease),
                    Some(&mutation_request_id),
                )
                .await?
        }
        TuiCommand::Herdr => {
            if let Some(current) = lease.take() {
                let _ = client
                    .control(
                        "conversation_release",
                        json!({ "chatId": current.chat_id, "generation": current.generation }),
                    )
                    .await;
            }
            launch_herdr(client, chat_id.as_deref()).await?;
            return Ok(true);
        }
        TuiCommand::Control { command, args } => client.control(&command, args).await?,
        TuiCommand::Quit => return Ok(false),
    };
    println!("{}", render_value(&result));
    Ok(true)
}

fn spawn_stdin_reader() -> mpsc::UnboundedReceiver<String> {
    let (tx, rx) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            match line {
                Ok(line) => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    eprintln!("Read terminal input: {error}");
                    break;
                }
            }
        }
    });
    rx
}

fn chinese_locale() -> bool {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .filter_map(|name| std::env::var(name).ok())
        .any(|value| value.to_ascii_lowercase().starts_with("zh"))
}

fn prompt_line(message: &str) -> Result<String, String> {
    print!("{message}");
    io::stdout()
        .flush()
        .map_err(|error| format!("write terminal prompt: {error}"))?;
    let mut input = String::new();
    io::stdin()
        .read_line(&mut input)
        .map_err(|error| format!("read terminal prompt: {error}"))?;
    Ok(input.trim().to_ascii_lowercase())
}

async fn launch_herdr(client: &BrokerClient, chat_id: Option<&str>) -> Result<(), String> {
    let tui_executable = std::env::current_exe()
        .map_err(|error| format!("locate picode-tui executable: {error}"))?;
    let launch = client
        .control(
            "herdr_launch_chat",
            json!({
                "tuiExecutable": tui_executable,
                "brokerPort": client.broker_port,
                "chatId": chat_id,
            }),
        )
        .await?;
    let executable = launch
        .get("attachExecutable")
        .and_then(Value::as_str)
        .ok_or("Herdr launch did not return an attach executable")?;
    let status = std::process::Command::new(executable)
        .status()
        .map_err(|error| format!("attach Herdr terminal UI: {error}"))?;
    if !status.success() {
        return Err(format!("Herdr terminal UI exited with {status}"));
    }
    Ok(())
}

/// Returns true when the first-run flow transferred this terminal into Herdr
/// and the bootstrap TUI should exit after detach.
async fn offer_herdr_first_run(
    client: &BrokerClient,
    chat_id: Option<&str>,
) -> Result<bool, String> {
    if !io::stdin().is_terminal() || std::env::var_os("HERDR_ENV").is_some() {
        return Ok(false);
    }
    let status = client.control("herdr_status", json!({})).await?;
    if status.get("decision").and_then(Value::as_str) != Some("undecided")
        || status.get("installed").and_then(Value::as_bool) == Some(true)
        || status.get("supported").and_then(Value::as_bool) != Some(true)
    {
        return Ok(false);
    }
    let chinese = chinese_locale();
    loop {
        let answer = prompt_line(if chinese {
            "首次运行：是否安装并信任可选的 Herdr 多会话终端宿主？[y] 安装 / [n] 不再询问 / [d] 详情："
        } else {
            "First run: install and trust the optional Herdr multi-session terminal host? [y] install / [n] don't ask again / [d] details: "
        })?;
        match answer.as_str() {
            "y" | "yes" | "是" => {
                client
                    .control("herdr_decide", json!({ "decision": "approved" }))
                    .await?;
                match client.control("herdr_install", json!({})).await {
                    Ok(_) => {
                        println!(
                            "{}",
                            if chinese {
                                "Herdr 已通过固定 SHA-256 校验和健康检查，正在打开托管 Picode 会话。"
                            } else {
                                "Herdr passed its pinned SHA-256 and health checks; opening the managed Picode session."
                            }
                        );
                        launch_herdr(client, chat_id).await?;
                        return Ok(true);
                    }
                    Err(error) => {
                        eprintln!(
                            "{}: {error}",
                            if chinese {
                                "Herdr 安装失败，继续使用单会话 Picode TUI"
                            } else {
                                "Herdr installation failed; continuing with the single-session Picode TUI"
                            }
                        );
                        return Ok(false);
                    }
                }
            }
            "n" | "no" | "否" => {
                client
                    .control("herdr_decide", json!({ "decision": "declined" }))
                    .await?;
                return Ok(false);
            }
            "d" | "details" | "详情" => {
                let release = status.get("release").cloned().unwrap_or(Value::Null);
                println!(
                    "{}\n{}",
                    if chinese {
                        "Herdr 是外部 Apache-2.0 Rust 终端多路复用器。Picode 固定版本/Commit/资产 SHA；仅同意后下载。Windows 为 preview，Linux/macOS 为 stable。权限：启动进程、网络（Herdr 更新与插件能力）。停用时零进程、零端口、零网络。"
                    } else {
                        "Herdr is an external Apache-2.0 Rust terminal multiplexer. Picode pins its version, commit, asset, and SHA and downloads only after approval. Windows is preview; Linux/macOS are stable. Permissions: process execution and network (Herdr updates/plugins). Disabled means zero process, port, and network activity."
                    },
                    render_value(&release)
                );
            }
            _ => eprintln!(
                "{}",
                if chinese {
                    "请输入 y、n 或 d。"
                } else {
                    "Enter y, n, or d."
                }
            ),
        }
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let options = match parse_options(&args) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(2);
        }
    };
    let broker_port = match resolve_broker_port(&options) {
        Ok(port) => port,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(3);
        }
    };
    let (client, mut events) = match BrokerClient::connect(broker_port).await {
        Ok(connected) => connected,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(3);
        }
    };
    let mut snapshot = match client.snapshot().await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            eprintln!("Load shared Picode workflow: {error}");
            return ExitCode::from(1);
        }
    };
    let mut chat_id = options.chat_id;
    match offer_herdr_first_run(&client, chat_id.as_deref()).await {
        Ok(true) => return ExitCode::SUCCESS,
        Ok(false) => {}
        Err(error) => eprintln!("Herdr first-run check: {error}"),
    }
    let mut lease: Option<TuiLease> = None;
    println!("Picode managed TUI · Core {broker_port}");
    println!("{}", render_snapshot(&snapshot));
    print_help();
    let mut lines = spawn_stdin_reader();
    let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(5));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        print!(
            "picode{}> ",
            chat_id
                .as_deref()
                .map(|id| format!(" [{id}]"))
                .unwrap_or_default()
        );
        let _ = io::stdout().flush();
        tokio::select! {
            _ = heartbeat.tick(), if lease.is_some() => {
                if let Some(current) = lease.clone() {
                    if client.control(
                        "conversation_renew",
                        json!({ "chatId": current.chat_id, "generation": current.generation }),
                    ).await.is_err() {
                        lease = None;
                    }
                }
            }
            Some(event) = events.recv() => {
                if let Some(line) = render_event(&event) {
                    println!("\n{line}");
                }
            }
            Some(line) = lines.recv() => {
                let command = match parse_command(&line) {
                    Ok(command) => command,
                    Err(error) if error == "empty input" => continue,
                    Err(error) => {
                        eprintln!("{error}");
                        continue;
                    }
                };
                match execute_command(
                    &client,
                    command,
                    &mut snapshot,
                    &mut chat_id,
                    &mut lease,
                    options.source_port,
                ).await {
                    Ok(true) => {}
                    Ok(false) => {
                        if let Some(current) = lease.take() {
                            let _ = client.control(
                                "conversation_release",
                                json!({ "chatId": current.chat_id, "generation": current.generation }),
                            ).await;
                        }
                        return ExitCode::SUCCESS;
                    }
                    Err(error) => eprintln!("{error}"),
                }
            }
            else => return ExitCode::SUCCESS,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_command, parse_options, render_snapshot, TuiCommand};
    use serde_json::json;

    #[test]
    fn parses_managed_tui_connection_and_chat_options() {
        let options = parse_options(&[
            "--broker-port".into(),
            "47820".into(),
            "--source-port".into(),
            "47821".into(),
            "--chat".into(),
            "chat-a".into(),
        ])
        .unwrap();

        assert_eq!(options.broker_port, Some(47820));
        assert_eq!(options.source_port, Some(47821));
        assert_eq!(options.chat_id.as_deref(), Some("chat-a"));
    }

    #[test]
    fn command_palette_covers_shared_workflow_and_plain_prompt_input() {
        assert_eq!(parse_command("/sessions").unwrap(), TuiCommand::Sessions);
        assert_eq!(
            parse_command("/use chat-a").unwrap(),
            TuiCommand::Use("chat-a".into())
        );
        assert_eq!(
            parse_command("continue the task").unwrap(),
            TuiCommand::Prompt("continue the task".into())
        );
        assert_eq!(
            parse_command("/control task_snapshot {}").unwrap(),
            TuiCommand::Control {
                command: "task_snapshot".into(),
                args: json!({}),
            }
        );
    }

    #[test]
    fn renders_bounded_shared_state_without_secret_fields() {
        let rendered = render_snapshot(&json!({
            "accounts": [{"id":"codex-a","provider":"openai"}],
            "tasks": {"tasks":[{"id":"task-a"}]},
            "extensions": {"lifecycle":[{"id":"skill-a","state":"enabled"}]},
            "work": [],
            "runtime": [],
            "packages": ["npm:pi-subagents@0.37.2"]
        }));

        assert!(rendered.contains("codex-a"));
        assert!(rendered.contains("task-a"));
        assert!(rendered.contains("skill-a"));
        assert!(!rendered.to_lowercase().contains("api key"));
    }
}
