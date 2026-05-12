//! Docker operations over an existing SSH connection: `docker ps` listing and
//! a streaming `docker logs -f --timestamps` task that emits batched lines as
//! Tauri events to the frontend.

use crate::error::{AppError, AppResult};
use crate::ssh::manager::SessionManager;
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

#[derive(Debug, Serialize, Clone)]
pub struct Container {
    pub id: String,
    pub name: String,
    pub all_names: Vec<String>,
    pub image: String,
    pub command: String,
    pub state: String,
    pub status: String,
    pub ports: String,
    pub created_at: String,
}

#[derive(Deserialize)]
struct DockerPsRow {
    #[serde(rename = "ID", default)]
    id: String,
    #[serde(rename = "Names", default)]
    names: String,
    #[serde(rename = "Image", default)]
    image: String,
    #[serde(rename = "Command", default)]
    command: String,
    #[serde(rename = "State", default)]
    state: String,
    #[serde(rename = "Status", default)]
    status: String,
    #[serde(rename = "Ports", default)]
    ports: String,
    #[serde(rename = "CreatedAt", default)]
    created_at: String,
}

impl DockerPsRow {
    fn into_container(self) -> Container {
        let all: Vec<String> = self
            .names
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let name = all.first().cloned().unwrap_or_else(|| self.id.clone());
        Container {
            id: self.id,
            name,
            all_names: all,
            image: self.image,
            command: self.command,
            state: self.state,
            status: self.status,
            ports: self.ports,
            created_at: self.created_at,
        }
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct DiagCommand {
    pub source: String,
    pub command: String,
    pub stdout: String,
    pub stderr: String,
    pub exit: Option<u32>,
}

pub async fn list_containers(
    app: AppHandle,
    manager: &SessionManager,
    session_id: &str,
) -> AppResult<Vec<Container>> {
    let conn = manager.require(session_id)?;
    let mut ch = conn
        .handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("open channel: {e}")))?;
    let cmd = wrap_command("docker ps -a --no-trunc --format '{{json .}}'", conn.use_sudo);
    ch.exec(true, cmd.as_str())
        .await
        .map_err(|e| AppError::Ssh(format!("exec docker ps: {e}")))?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit: Option<u32> = None;
    while let Some(msg) = ch.wait().await {
        match msg {
            ChannelMsg::Data { ref data } => stdout.extend_from_slice(data),
            ChannelMsg::ExtendedData { ref data, .. } => stderr.extend_from_slice(data),
            ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }

    let stdout_text = String::from_utf8_lossy(&stdout).to_string();
    let _ = app.emit(
        "diag:command",
        DiagCommand {
            source: "list_containers".into(),
            command: cmd.clone(),
            stdout: stdout_text.clone(),
            stderr: String::from_utf8_lossy(&stderr).to_string(),
            exit,
        },
    );

    let stderr_text = String::from_utf8_lossy(&stderr).trim().to_string();
    if exit.unwrap_or(0) != 0 || (stdout.is_empty() && !stderr_text.is_empty()) {
        let hint = if stderr_text.contains("a password is required")
            || stderr_text.contains("a terminal is required")
        {
            " (hint: this user cannot sudo without a password — configure passwordless sudo or disable 'Run commands via sudo' on the session)"
        } else if stderr_text.contains("not found") || stderr_text.contains("No such file") {
            " (hint: docker not in remote PATH — try installing in /usr/bin or adjusting your shell init)"
        } else if stderr_text.contains("permission denied") && stderr_text.contains("docker.sock") {
            " (hint: remote user is not in the 'docker' group — enable 'Run commands via sudo' on the session, or add the user to the docker group)"
        } else if stderr_text.contains("Cannot connect to the Docker daemon") {
            " (hint: the Docker daemon is not running on the remote host)"
        } else {
            ""
        };
        return Err(AppError::Ssh(format!("docker ps failed: {stderr_text}{hint}")));
    }

    let text = String::from_utf8_lossy(&stdout);
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(row) = serde_json::from_str::<DockerPsRow>(line) {
            out.push(row.into_container());
        }
    }
    Ok(out)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LogLine {
    pub ts: Option<String>,
    pub text: String,
    pub stderr: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct LogBatch {
    pub stream_id: String,
    pub lines: Vec<LogLine>,
}

#[derive(Debug, Serialize, Clone)]
pub struct LogEnd {
    pub stream_id: String,
    pub reason: String,
}

/// Single-quote a string for POSIX sh: close-quote, escaped quote, reopen.
fn sq(s: &str) -> String {
    let escaped = s.replace('\'', r"'\''");
    format!("'{}'", escaped)
}

/// Build a remote command that augments PATH and optionally runs through
/// `sudo -n` (non-interactive — fails fast if the user can't sudo without a
/// password instead of hanging the SSH channel waiting for one).
fn wrap_command(inner: &str, use_sudo: bool) -> String {
    let with_path = format!(
        r#"PATH="$PATH:/usr/local/bin:/usr/local/sbin:/snap/bin:/opt/homebrew/bin" {}"#,
        inner
    );
    if use_sudo {
        format!("sudo -n sh -c {}", sq(&with_path))
    } else {
        with_path
    }
}

fn is_safe_container_ref(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 256
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/'))
}

fn split_ts(line: &str) -> (Option<String>, String) {
    if let Some(idx) = line.find(' ') {
        let head = &line[..idx];
        let b = head.as_bytes();
        if head.len() >= 20 && b.get(4) == Some(&b'-') && b.get(7) == Some(&b'-') && b.get(10) == Some(&b'T') {
            return (Some(head.to_string()), line[idx + 1..].to_string());
        }
    }
    (None, line.to_string())
}

fn drain_lines(buf: &mut Vec<u8>, stderr: bool, out: &mut Vec<LogLine>) {
    while let Some(idx) = buf.iter().position(|&b| b == b'\n') {
        let raw: Vec<u8> = buf.drain(..=idx).collect();
        let text = String::from_utf8_lossy(&raw)
            .trim_end_matches(|c| c == '\n' || c == '\r')
            .to_string();
        let (ts, text) = split_ts(&text);
        out.push(LogLine { ts, text, stderr });
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct RemoteCmdResult {
    pub stdout: String,
    pub stderr: String,
    pub exit: Option<u32>,
    pub truncated: bool,
}

const REMOTE_OUTPUT_CAP: usize = 256 * 1024;

pub async fn run_remote_command(
    manager: &SessionManager,
    session_id: &str,
    command: &str,
) -> AppResult<RemoteCmdResult> {
    if command.trim().is_empty() {
        return Err(AppError::Ssh("empty command".into()));
    }
    let conn = manager.require(session_id)?;
    let mut ch = conn
        .handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("open channel: {e}")))?;
    ch.exec(true, command)
        .await
        .map_err(|e| AppError::Ssh(format!("exec: {e}")))?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit: Option<u32> = None;
    let mut truncated = false;
    loop {
        match ch.wait().await {
            Some(ChannelMsg::Data { ref data }) => {
                if stdout.len() < REMOTE_OUTPUT_CAP {
                    stdout.extend_from_slice(data);
                    if stdout.len() > REMOTE_OUTPUT_CAP { truncated = true; }
                } else {
                    truncated = true;
                }
            }
            Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                if stderr.len() < REMOTE_OUTPUT_CAP {
                    stderr.extend_from_slice(data);
                    if stderr.len() > REMOTE_OUTPUT_CAP { truncated = true; }
                } else {
                    truncated = true;
                }
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => exit = Some(exit_status),
            // Eof signals end of data but ExitStatus may still follow — keep reading.
            Some(ChannelMsg::Eof) => {}
            Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    Ok(RemoteCmdResult {
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
        exit,
        truncated,
    })
}

pub async fn start_log_stream(
    app: AppHandle,
    manager: Arc<SessionManager>,
    session_id: String,
    container_id: String,
    tail: u32,
) -> AppResult<String> {
    if !is_safe_container_ref(&container_id) {
        return Err(AppError::Ssh("invalid container id".into()));
    }
    let conn = manager.require(&session_id)?;
    let mut ch = conn
        .handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("open channel: {e}")))?;
    let inner = format!(
        "docker logs -f --timestamps --tail {} {}",
        tail.min(100_000),
        container_id
    );
    let cmd = wrap_command(&inner, conn.use_sudo);
    let _ = app.emit(
        "diag:command",
        DiagCommand {
            source: "log_stream:start".into(),
            command: cmd.clone(),
            stdout: String::new(),
            stderr: String::new(),
            exit: None,
        },
    );
    ch.exec(true, cmd.as_str())
        .await
        .map_err(|e| AppError::Ssh(format!("exec docker logs: {e}")))?;

    let stream_id = Uuid::new_v4().to_string();
    let sid = stream_id.clone();
    let app2 = app.clone();
    let manager2 = manager.clone();

    let task = tokio::spawn(async move {
        let mut stdout_buf: Vec<u8> = Vec::new();
        let mut stderr_buf: Vec<u8> = Vec::new();
        let mut pending: Vec<LogLine> = Vec::new();
        let mut ticker = tokio::time::interval(Duration::from_millis(80));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut reason = "ended".to_string();

        loop {
            tokio::select! {
                msg = ch.wait() => match msg {
                    Some(ChannelMsg::Data { data }) => {
                        stdout_buf.extend_from_slice(&data);
                        drain_lines(&mut stdout_buf, false, &mut pending);
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        stderr_buf.extend_from_slice(&data);
                        drain_lines(&mut stderr_buf, true, &mut pending);
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        if exit_status != 0 {
                            reason = format!("exit status {exit_status}");
                        }
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                },
                _ = ticker.tick() => {
                    if !pending.is_empty() {
                        let batch = LogBatch { stream_id: sid.clone(), lines: std::mem::take(&mut pending) };
                        let _ = app2.emit("log:batch", batch);
                    }
                }
            }
        }

        // Flush any trailing partial line as a final line so it isn't lost.
        if !stdout_buf.is_empty() {
            let text = String::from_utf8_lossy(&stdout_buf).to_string();
            let (ts, text) = split_ts(&text);
            pending.push(LogLine { ts, text, stderr: false });
        }
        if !stderr_buf.is_empty() {
            let text = String::from_utf8_lossy(&stderr_buf).to_string();
            let (ts, text) = split_ts(&text);
            pending.push(LogLine { ts, text, stderr: true });
        }
        if !pending.is_empty() {
            let _ = app2.emit("log:batch", LogBatch { stream_id: sid.clone(), lines: pending });
        }
        let _ = app2.emit("log:end", LogEnd { stream_id: sid.clone(), reason });
        manager2.forget_stream(&sid);
    });

    manager.register_stream(stream_id.clone(), task);
    Ok(stream_id)
}

// ─── Docker stats ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct ContainerStats {
    pub id: String,
    pub name: String,
    pub cpu_perc: String,
    pub mem_usage: String,
    pub mem_perc: String,
    pub net_io: String,
    pub block_io: String,
    pub pids: String,
}

#[derive(Deserialize)]
struct DockerStatsRow {
    #[serde(rename = "ID", default)]
    id: String,
    #[serde(rename = "Name", default)]
    name: String,
    #[serde(rename = "CPUPerc", default)]
    cpu_perc: String,
    #[serde(rename = "MemUsage", default)]
    mem_usage: String,
    #[serde(rename = "MemPerc", default)]
    mem_perc: String,
    #[serde(rename = "NetIO", default)]
    net_io: String,
    #[serde(rename = "BlockIO", default)]
    block_io: String,
    #[serde(rename = "PIDs", default)]
    pids: String,
}

/// Poll `docker stats --no-stream` once and return stats for every running
/// container. Takes ~1 second because Docker needs a measurement window for CPU.
pub async fn poll_docker_stats(
    manager: &SessionManager,
    session_id: &str,
) -> AppResult<Vec<ContainerStats>> {
    let conn = manager.require(session_id)?;
    let mut ch = conn
        .handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("open channel: {e}")))?;
    let inner = "docker stats --no-stream --format '{{json .}}'";
    let cmd = wrap_command(inner, conn.use_sudo);
    ch.exec(true, cmd.as_str())
        .await
        .map_err(|e| AppError::Ssh(format!("exec docker stats: {e}")))?;

    let mut stdout = Vec::new();
    while let Some(msg) = ch.wait().await {
        match msg {
            ChannelMsg::Data { ref data } => stdout.extend_from_slice(data),
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }

    let text = String::from_utf8_lossy(&stdout);
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(row) = serde_json::from_str::<DockerStatsRow>(line) {
            out.push(ContainerStats {
                id: row.id,
                name: row.name,
                cpu_perc: row.cpu_perc,
                mem_usage: row.mem_usage,
                mem_perc: row.mem_perc,
                net_io: row.net_io,
                block_io: row.block_io,
                pids: row.pids,
            });
        }
    }
    Ok(out)
}
