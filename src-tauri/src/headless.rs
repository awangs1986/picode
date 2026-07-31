use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::io::{self, BufRead};
use std::process::ExitCode;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

#[derive(Debug, PartialEq)]
struct HeadlessOptions {
    broker_port: u16,
    source_port: Option<u16>,
    requests: Vec<Value>,
    read_stdin: bool,
    stream: bool,
    stream_timeout_ms: u64,
}

fn parse_options(args: &[String]) -> Result<HeadlessOptions, String> {
    let mut broker_port = None;
    let mut source_port = None;
    let mut requests = Vec::new();
    let mut read_stdin = true;
    let mut stream = false;
    let mut stream_timeout_ms = 120_000;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--broker-port" => {
                index += 1;
                broker_port = Some(
                    args.get(index)
                        .ok_or("--broker-port requires a value")?
                        .parse::<u16>()
                        .map_err(|_| "--broker-port must be a valid port")?,
                );
            }
            "--source-port" => {
                index += 1;
                source_port = Some(
                    args.get(index)
                        .ok_or("--source-port requires a value")?
                        .parse::<u16>()
                        .map_err(|_| "--source-port must be a valid port")?,
                );
            }
            "--json" => {
                index += 1;
                requests.push(
                    serde_json::from_str(args.get(index).ok_or("--json requires a value")?)
                        .map_err(|error| format!("invalid request JSON: {error}"))?,
                );
                read_stdin = false;
            }
            "--stream" => stream = true,
            "--stream-timeout-ms" => {
                index += 1;
                stream_timeout_ms = args
                    .get(index)
                    .ok_or("--stream-timeout-ms requires a value")?
                    .parse::<u64>()
                    .map_err(|_| "--stream-timeout-ms must be an integer")?
                    .clamp(100, 3_600_000);
            }
            "--help" | "-h" => {
                return Err(
                    "usage: picode-headless --broker-port PORT [--source-port PI_PORT] [--json ACP_REQUEST] [--stream] [--stream-timeout-ms MS]; without --json, process JSON Lines from stdin as they arrive"
                        .to_owned(),
                );
            }
            other => return Err(format!("unknown option: {other}")),
        }
        index += 1;
    }
    let broker_port = broker_port
        .or_else(|| std::env::var("PICODE_BROKER_PORT").ok()?.parse().ok())
        .ok_or("--broker-port or PICODE_BROKER_PORT is required")?;
    Ok(HeadlessOptions {
        broker_port,
        source_port,
        requests,
        read_stdin,
        stream,
        stream_timeout_ms,
    })
}

fn control_frame(request: Value, source_port: Option<u16>) -> (String, Value) {
    let request_id = Uuid::new_v4().to_string();
    let mut args = json!({ "request": request });
    if let Some(source_port) = source_port {
        args["sourcePort"] = json!(source_port);
    }
    (
        request_id.clone(),
        json!({
            "type": "broker_control",
            "command": "acp_request",
            "requestId": request_id,
            "args": args,
        }),
    )
}

async fn send_request<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    request: Value,
    source_port: Option<u16>,
    stream: bool,
) -> Result<Value, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (request_id, frame) = control_frame(request, source_port);
    socket
        .send(Message::Text(frame.to_string()))
        .await
        .map_err(|error| format!("send ACP request: {error}"))?;
    while let Some(message) = socket.next().await {
        let message = message.map_err(|error| format!("read broker response: {error}"))?;
        let Message::Text(text) = message else {
            continue;
        };
        let value: Value = serde_json::from_str(&text)
            .map_err(|error| format!("invalid broker response: {error}"))?;
        if stream && value.get("type").and_then(Value::as_str) == Some("broker_event") {
            println!("{}", value);
            continue;
        }
        if value.get("type").and_then(Value::as_str) != Some("control_response")
            || value.get("requestId").and_then(Value::as_str) != Some(request_id.as_str())
        {
            continue;
        }
        if value.get("ok").and_then(Value::as_bool) == Some(true) {
            return Ok(value.get("result").cloned().unwrap_or(Value::Null));
        }
        return Err(value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("ACP control failed")
            .to_owned());
    }
    Err("broker disconnected before the ACP response".to_owned())
}

fn is_prompt_request(request: &Value) -> bool {
    request.get("method").and_then(Value::as_str) == Some("session/prompt")
}

fn broker_event_kind(value: &Value) -> Option<&str> {
    value
        .get("payload")
        .and_then(|payload| payload.get("event").unwrap_or(payload).get("type"))
        .and_then(Value::as_str)
}

async fn stream_until_agent_end<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    timeout_ms: u64,
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err("stream timed out before agent_end".to_owned());
        }
        let message = tokio::time::timeout(remaining, socket.next())
            .await
            .map_err(|_| "stream timed out before agent_end".to_owned())?
            .ok_or_else(|| "broker disconnected during stream".to_owned())?
            .map_err(|error| format!("read broker stream: {error}"))?;
        let Message::Text(text) = message else {
            continue;
        };
        let value: Value = serde_json::from_str(&text)
            .map_err(|error| format!("invalid broker stream frame: {error}"))?;
        if value.get("type").and_then(Value::as_str) != Some("broker_event") {
            continue;
        }
        println!("{}", value);
        if broker_event_kind(&value) == Some("agent_end") {
            return Ok(());
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
    let url = format!("ws://127.0.0.1:{}/", options.broker_port);
    let (mut socket, _) = match tokio_tungstenite::connect_async(&url).await {
        Ok(connection) => connection,
        Err(error) => {
            eprintln!("connect broker {url}: {error}");
            return ExitCode::from(3);
        }
    };
    let mut requests = options.requests;
    if options.read_stdin {
        for line in io::stdin().lock().lines() {
            let line = match line {
                Ok(line) => line,
                Err(error) => {
                    eprintln!("read stdin: {error}");
                    return ExitCode::from(2);
                }
            };
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str(&line) {
                Ok(request) => requests.push(request),
                Err(error) => {
                    eprintln!("invalid request JSON: {error}");
                    return ExitCode::from(2);
                }
            }
            let request = requests.pop().expect("request was just appended");
            let stream_prompt = options.stream && is_prompt_request(&request);
            match send_request(&mut socket, request, options.source_port, options.stream).await {
                Ok(result) => println!("{}", result),
                Err(error) => {
                    eprintln!("{error}");
                    return ExitCode::from(1);
                }
            }
            if stream_prompt {
                if let Err(error) =
                    stream_until_agent_end(&mut socket, options.stream_timeout_ms).await
                {
                    eprintln!("{error}");
                    return ExitCode::from(1);
                }
            }
        }
        return ExitCode::SUCCESS;
    }
    for request in requests {
        let stream_prompt = options.stream && is_prompt_request(&request);
        match send_request(&mut socket, request, options.source_port, options.stream).await {
            Ok(result) => println!("{}", result),
            Err(error) => {
                eprintln!("{error}");
                return ExitCode::from(1);
            }
        }
        if stream_prompt {
            if let Err(error) = stream_until_agent_end(&mut socket, options.stream_timeout_ms).await
            {
                eprintln!("{error}");
                return ExitCode::from(1);
            }
        }
    }
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::{control_frame, parse_options};
    use serde_json::json;

    #[test]
    fn cli_builds_machine_readable_acp_control_without_implicit_runtime_target() {
        let options = parse_options(&[
            "--broker-port".into(),
            "47820".into(),
            "--json".into(),
            r#"{"id":1,"method":"session/list"}"#.into(),
        ])
        .unwrap();
        assert_eq!(options.broker_port, 47820);
        assert_eq!(options.source_port, None);
        assert!(!options.stream);
        let (_, frame) = control_frame(options.requests[0].clone(), options.source_port);
        assert_eq!(frame["command"], "acp_request");
        assert_eq!(
            frame["args"]["request"],
            json!({ "id": 1, "method": "session/list" })
        );
        assert!(frame["args"].get("sourcePort").is_none());
    }

    #[test]
    fn cli_accepts_streaming_json_lines_without_waiting_for_a_batch() {
        let options = parse_options(&[
            "--broker-port".into(),
            "47820".into(),
            "--stream".into(),
            "--stream-timeout-ms".into(),
            "2500".into(),
        ])
        .unwrap();
        assert!(options.read_stdin);
        assert!(options.stream);
        assert_eq!(options.stream_timeout_ms, 2500);
    }
}
