//! Persistent SSH connection registry. Keyed by session id; each entry holds
//! a live `russh` Handle (and, for ProxyJump, the upstream jump handle that
//! must stay alive to keep the forwarded tunnel open).

use crate::error::{AppError, AppResult};
use crate::ssh::client::{dial, AcceptAllHandler};
use crate::storage::Vault;
use parking_lot::Mutex;
use russh::client::Handle;
use russh::{ChannelMsg, Disconnect};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::process::Child;
use tokio::task::JoinHandle;

pub struct ConnectedSession {
    pub handle: Handle<AcceptAllHandler>,
    pub use_sudo: bool,
    _jump: Option<Handle<AcceptAllHandler>>,
    _ssm_child: Option<Child>,
}

/// Sender half of a per-step stdin pipe used by the upgrade flow runner.
/// Wraps an `mpsc` so `send_upgrade_input` can push bytes without holding a
/// channel lock.
pub type StdinTx = tokio::sync::mpsc::UnboundedSender<Vec<u8>>;
pub type StdinRx = tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>;

pub fn stdin_pipe() -> (StdinTx, StdinRx) {
    tokio::sync::mpsc::unbounded_channel()
}

#[derive(Serialize, Clone)]
struct SessionDisconnected {
    session_id: String,
    reason: String,
}

pub struct SessionManager {
    sessions: Mutex<HashMap<String, Arc<ConnectedSession>>>,
    streams: Mutex<HashMap<String, JoinHandle<()>>>,
    heartbeats: Mutex<HashMap<String, JoinHandle<()>>>,
    /// Maps upgrade run_id → stdin sender for the currently-running step.
    upgrade_inputs: Mutex<HashMap<String, StdinTx>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
            heartbeats: Mutex::new(HashMap::new()),
            upgrade_inputs: Mutex::new(HashMap::new()),
        }
    }

    pub async fn connect(
        self: &Arc<Self>,
        app: AppHandle,
        vault: &Vault,
        session_id: &str,
    ) -> AppResult<()> {
        if self.sessions.lock().contains_key(session_id) {
            return Ok(());
        }
        let session = crate::storage::sessions::get(vault, session_id)?;
        let r = dial(vault, &session).await?;
        let entry = Arc::new(ConnectedSession {
            handle: r.handle,
            use_sudo: session.use_sudo,
            _jump: r.jump,
            _ssm_child: r.ssm_child,
        });
        self.sessions.lock().insert(session_id.to_string(), entry.clone());
        crate::storage::sessions::touch_last_connected(vault, session_id)?;

        // Spawn the application-level heartbeat. Re-uses the existing channel-open
        // path so NAT/firewall idle timers see real traffic, not just SSH keepalives.
        self.spawn_heartbeat(app, session_id.to_string(), entry);
        Ok(())
    }

    fn spawn_heartbeat(
        self: &Arc<Self>,
        app: AppHandle,
        session_id: String,
        entry: Arc<ConnectedSession>,
    ) {
        let mgr = Arc::clone(self);
        let key = session_id.clone();
        let handle = tokio::spawn(async move {
            const INTERVAL: Duration = Duration::from_secs(60);
            // Brief warm-up so initial container fetches don't race the first ping.
            tokio::time::sleep(Duration::from_secs(5)).await;
            loop {
                // If the session has been removed from the registry, exit quietly.
                if !mgr.is_connected(&session_id) {
                    return;
                }
                let res = tokio::time::timeout(
                    Duration::from_secs(15),
                    heartbeat_ping(&entry),
                )
                .await;
                let ok = matches!(res, Ok(Ok(_)));
                if !ok {
                    let reason = match res {
                        Err(_) => "heartbeat timeout".to_string(),
                        Ok(Err(e)) => format!("heartbeat error: {e}"),
                        Ok(Ok(_)) => unreachable!(),
                    };
                    mgr.on_heartbeat_failure(&app, &session_id, reason).await;
                    return;
                }
                tokio::time::sleep(INTERVAL).await;
            }
        });
        self.heartbeats.lock().insert(key, handle);
    }

    async fn on_heartbeat_failure(&self, app: &AppHandle, session_id: &str, reason: String) {
        // Tear down the connection registry entry without aborting our own task.
        let entry = self.sessions.lock().remove(session_id);
        self.heartbeats.lock().remove(session_id);
        if let Some(entry) = entry {
            if let Some(mut conn) = Arc::into_inner(entry) {
                let _ = conn
                    .handle
                    .disconnect(Disconnect::ByApplication, "bye", "en")
                    .await;
                if let Some(ref mut child) = conn._ssm_child {
                    let _ = child.start_kill();
                }
            }
        }
        let _ = app.emit(
            "session:disconnected",
            SessionDisconnected {
                session_id: session_id.to_string(),
                reason,
            },
        );
    }

    pub fn is_connected(&self, session_id: &str) -> bool {
        self.sessions.lock().contains_key(session_id)
    }

    pub fn get(&self, session_id: &str) -> Option<Arc<ConnectedSession>> {
        self.sessions.lock().get(session_id).cloned()
    }

    pub async fn disconnect(&self, session_id: &str) -> AppResult<()> {
        let entry = self.sessions.lock().remove(session_id);
        if let Some(hb) = self.heartbeats.lock().remove(session_id) {
            hb.abort();
        }
        if let Some(entry) = entry {
            if let Some(mut conn) = Arc::into_inner(entry) {
                let _ = conn
                    .handle
                    .disconnect(Disconnect::ByApplication, "bye", "en")
                    .await;
                if let Some(ref mut child) = conn._ssm_child {
                    let _ = child.start_kill();
                }
            }
        }
        Ok(())
    }

    pub fn register_stream(&self, stream_id: String, handle: JoinHandle<()>) {
        self.streams.lock().insert(stream_id, handle);
    }

    pub fn forget_stream(&self, stream_id: &str) {
        self.streams.lock().remove(stream_id);
    }

    pub fn stop_stream(&self, stream_id: &str) -> bool {
        if let Some(h) = self.streams.lock().remove(stream_id) {
            h.abort();
            true
        } else {
            false
        }
    }

    // ─── Upgrade stdin registry ───────────────────────────────────────────────

    /// Register a stdin sender for an upgrade run so `send_upgrade_input` can
    /// reach the currently-running PTY step across Tauri command boundaries.
    pub fn register_upgrade_stdin(&self, run_id: String, tx: StdinTx) {
        self.upgrade_inputs.lock().insert(run_id, tx);
    }

    pub fn unregister_upgrade_stdin(&self, run_id: &str) {
        self.upgrade_inputs.lock().remove(run_id);
    }

    /// Forward `text` (+ `\n` if not already present) to the active upgrade
    /// step's stdin.  Returns an error if no step is running for this run_id.
    pub fn send_upgrade_input(&self, run_id: &str, text: &str) -> AppResult<()> {
        let tx = self
            .upgrade_inputs
            .lock()
            .get(run_id)
            .cloned()
            .ok_or_else(|| {
                AppError::Other(format!("no active upgrade step for run_id={run_id}"))
            })?;
        let mut bytes = text.as_bytes().to_vec();
        if !bytes.ends_with(b"\n") {
            bytes.push(b'\n');
        }
        tx.send(bytes)
            .map_err(|_| AppError::Ssh("upgrade: stdin channel closed".into()))
    }
}

async fn heartbeat_ping(entry: &ConnectedSession) -> AppResult<()> {
    let mut ch = entry
        .handle
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("heartbeat open channel: {e}")))?;
    ch.exec(true, "echo bcn-hb")
        .await
        .map_err(|e| AppError::Ssh(format!("heartbeat exec: {e}")))?;
    while let Some(msg) = ch.wait().await {
        match msg {
            ChannelMsg::ExitStatus { .. } => {}
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }
    Ok(())
}

impl Default for SessionManager {
    fn default() -> Self { Self::new() }
}

impl SessionManager {
    pub fn require(&self, session_id: &str) -> AppResult<Arc<ConnectedSession>> {
        self.get(session_id)
            .ok_or_else(|| AppError::Ssh(format!("session {session_id} is not connected")))
    }
}
