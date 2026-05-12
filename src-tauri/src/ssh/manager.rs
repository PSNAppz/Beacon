//! Persistent SSH connection registry. Keyed by session id; each entry holds
//! a live `russh` Handle (and, for ProxyJump, the upstream jump handle that
//! must stay alive to keep the forwarded tunnel open).

use crate::error::{AppError, AppResult};
use crate::ssh::client::{dial, AcceptAllHandler};
use crate::storage::Vault;
use parking_lot::Mutex;
use russh::client::Handle;
use russh::Disconnect;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::process::Child;
use tokio::task::JoinHandle;

pub struct ConnectedSession {
    pub handle: Handle<AcceptAllHandler>,
    pub use_sudo: bool,
    _jump: Option<Handle<AcceptAllHandler>>,
    _ssm_child: Option<Child>,
}

pub struct SessionManager {
    sessions: Mutex<HashMap<String, Arc<ConnectedSession>>>,
    streams: Mutex<HashMap<String, JoinHandle<()>>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
        }
    }

    pub async fn connect(&self, vault: &Vault, session_id: &str) -> AppResult<()> {
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
        self.sessions.lock().insert(session_id.to_string(), entry);
        crate::storage::sessions::touch_last_connected(vault, session_id)?;
        Ok(())
    }

    pub fn is_connected(&self, session_id: &str) -> bool {
        self.sessions.lock().contains_key(session_id)
    }

    pub fn get(&self, session_id: &str) -> Option<Arc<ConnectedSession>> {
        self.sessions.lock().get(session_id).cloned()
    }

    pub async fn disconnect(&self, session_id: &str) -> AppResult<()> {
        let entry = self.sessions.lock().remove(session_id);
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
