use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct PiProcess {
    child: Child,
    stdin: ChildStdin,
}

pub struct PiManager {
    processes: Arc<Mutex<HashMap<u16, PiProcess>>>,
    static_dir: PathBuf,
}

impl PiManager {
    pub fn new(static_dir: PathBuf) -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
            static_dir,
        }
    }

    fn find_pi_binary() -> Vec<String> {
        // Returns argv: [binary, args...]
        if let Ok(output) = Command::new("which").arg("pi").output() {
            if output.status.success() {
                let p = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !p.is_empty() {
                    return vec![p];
                }
            }
        }
        // Fallback: local dev path
        let local = dirs::home_dir()
            .unwrap_or_default()
            .join("code/pi/pi-mono/packages/coding-agent/dist/cli.js");
        if local.exists() {
            return vec!["node".to_string(), local.to_string_lossy().to_string()];
        }
        vec!["pi".to_string()]
    }

    pub fn spawn(&self, cwd: &str, port: u16, session_path: Option<&str>) -> Result<(), String> {
        let argv = Self::find_pi_binary();
        let static_dir = self.static_dir.to_string_lossy().to_string();

        let mut args: Vec<String> = argv[1..].to_vec();
        args.push("--mode".to_string());
        args.push("rpc".to_string());
        if let Some(session) = session_path {
            args.push("--session".to_string());
            args.push(session.to_string());
        }

        eprintln!(
            "[pi-desktop] spawning pi: argv={:?} args={:?} cwd={} port={} static_dir={}",
            argv, args, cwd, port, static_dir
        );

        let mut child = Command::new(&argv[0]);
        child
            .args(&args)
            .current_dir(cwd)
            .env("PI_STUDIO_STATIC_DIR", &static_dir)
            .env("PI_STUDIO_PORT", port.to_string())
            .stdin(Stdio::piped())
            // Drop stdout: pi emits RPC frames on it that we don't consume here, and
            // letting it fill an unread pipe would eventually block the child.
            .stdout(Stdio::null())
            // Inherit stderr so pi's startup/runtime errors are visible in the same
            // terminal running `npm run dev` — critical for diagnosing failures of
            // new_session / open_workspace that would otherwise be silent.
            .stderr(Stdio::inherit());

        let spawn_started_at = Instant::now();
        let mut child = child.spawn().map_err(|e| {
            format!(
                "Failed to spawn pi ({}): {}. Check that `pi` is on PATH or that {} exists.",
                argv.join(" "),
                e,
                dirs::home_dir()
                    .unwrap_or_default()
                    .join("code/pi/pi-mono/packages/coding-agent/dist/cli.js")
                    .display()
            )
        })?;
        eprintln!(
            "[pi-desktop] pi process spawned: port={} pid={} elapsed_ms={}",
            port,
            child.id(),
            spawn_started_at.elapsed().as_millis()
        );
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to get pi stdin".to_string())?;

        let mut lock = self.processes.lock().unwrap();
        lock.insert(port, PiProcess { child, stdin });

        Ok(())
    }

    /// Send an RPC command to a pi instance (JSON line on stdin)
    pub fn send_rpc(&self, port: u16, cmd: serde_json::Value) -> Result<(), String> {
        let mut lock = self.processes.lock().unwrap();
        let proc = lock
            .get_mut(&port)
            .ok_or_else(|| format!("No pi instance on port {}", port))?;
        let mut line = cmd.to_string();
        line.push('\n');
        proc.stdin
            .write_all(line.as_bytes())
            .map_err(|e| e.to_string())
    }

    pub fn kill(&self, port: u16) {
        let mut lock = self.processes.lock().unwrap();
        if let Some(mut proc) = lock.remove(&port) {
            let _ = proc.child.kill();
        }
    }

    pub fn kill_all(&self) {
        let mut lock = self.processes.lock().unwrap();
        for (_, mut proc) in lock.drain() {
            let _ = proc.child.kill();
        }
    }

    pub fn next_port(&self) -> u16 {
        let lock = self.processes.lock().unwrap();
        let mut port = 3001u16;
        while lock.contains_key(&port) || is_port_in_use(port) {
            port += 1;
        }
        port
    }
}

pub fn is_port_in_use(port: u16) -> bool {
    std::net::TcpListener::bind(format!("127.0.0.1:{}", port)).is_err()
}

pub async fn wait_for_health(port: u16, timeout_secs: u64) -> Result<(), String> {
    wait_for_endpoint(port, "/api/health", timeout_secs).await
}

/// Wait for a specific HTTP endpoint on the pi instance to respond with a non-5xx status.
/// Useful when we need to confirm the API surface the frontend will hit first (e.g. /api/sessions)
/// is ready before navigating, avoiding cold-start races where /api/health is up but route
/// handlers are still warming.
pub async fn wait_for_endpoint(port: u16, path: &str, timeout_secs: u64) -> Result<(), String> {
    let url = format!("http://localhost:{}{}", port, path);
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        if std::time::Instant::now() > deadline {
            return Err(format!("Timed out waiting for {} on port {}", path, port));
        }
        if let Ok(resp) = reqwest::get(&url).await {
            if resp.status().as_u16() < 500 {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}
