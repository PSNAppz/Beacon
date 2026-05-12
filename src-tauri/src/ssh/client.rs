//! Low-level russh helpers shared by the test-connect path and the persistent
//! session manager. Connection open + authenticate + ProxyJump live here.

use crate::error::{AppError, AppResult};
use crate::storage::{AuthKind, Session, SessionSecret, Vault};
use async_trait::async_trait;
use russh::client::{Config, Handle, Handler, Msg};
use russh::{ChannelMsg, Disconnect};
use russh_keys::key::PublicKey;
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tokio::process::Child;

pub struct AcceptAllHandler;

#[async_trait]
impl Handler for AcceptAllHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        // TODO Phase 8: real known_hosts check with TOFU prompt.
        Ok(true)
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct SshTestResult {
    pub ok: bool,
    pub message: String,
    pub remote_user: Option<String>,
    pub remote_uname: Option<String>,
}

fn cfg() -> Arc<Config> {
    Arc::new(Config {
        inactivity_timeout: Some(Duration::from_secs(300)),
        keepalive_interval: Some(Duration::from_secs(30)),
        ..Default::default()
    })
}

pub async fn open_handle(host: &str, port: u16) -> AppResult<Handle<AcceptAllHandler>> {
    russh::client::connect(cfg(), (host, port), AcceptAllHandler)
        .await
        .map_err(|e| AppError::Ssh(format!("connect {host}:{port}: {e}")))
}

pub async fn authenticate(
    h: &mut Handle<AcceptAllHandler>,
    session: &Session,
    secret: &SessionSecret,
) -> AppResult<()> {
    let username = &session.username;
    let authed = match session.auth_kind {
        AuthKind::Password => {
            let pw = secret.plain.as_ref()
                .ok_or_else(|| AppError::Ssh("password missing".into()))?;
            let pw_s = std::str::from_utf8(pw)
                .map_err(|_| AppError::Ssh("password not utf8".into()))?;
            h.authenticate_password(username, pw_s).await?
        }
        AuthKind::Key => {
            let path = session.key_path.as_ref()
                .ok_or_else(|| AppError::Ssh("key_path missing".into()))?;
            let passphrase = secret.plain.as_ref()
                .and_then(|v| std::str::from_utf8(v).ok())
                .filter(|s| !s.is_empty());
            let key = russh_keys::load_secret_key(path, passphrase)
                .map_err(|e| AppError::Ssh(format!("load key {path}: {e}")))?;
            h.authenticate_publickey(username, Arc::new(key)).await?
        }
        AuthKind::Agent => {
            return Err(AppError::Ssh(
                "SSH-agent auth is not yet implemented on Windows (planned)".into(),
            ));
        }
    };
    if !authed {
        return Err(AppError::Ssh("authentication failed".into()));
    }
    Ok(())
}

/// Unified result from `dial()`.
pub struct DialResult {
    pub handle: Handle<AcceptAllHandler>,
    pub jump: Option<Handle<AcceptAllHandler>>,
    /// Kept alive to hold the SSM tunnel open; kill on disconnect.
    pub ssm_child: Option<Child>,
}


/// Connect via AWS SSM Session Manager — native SDK, no CLI required.
/// Calls `ssm:StartSession`, opens a WebSocket datachannel, and uses it as
/// the SSH transport so no public IP or open port 22 is needed on the instance.
async fn dial_ssm(vault: &Vault, session: &Session) -> AppResult<DialResult> {
    let instance_id = session.ssm_instance_id.as_deref()
        .ok_or_else(|| AppError::Ssh("SSM instance ID is required".into()))?;
    let region = session.aws_region.as_deref()
        .ok_or_else(|| AppError::Ssh("AWS region is required for SSM sessions".into()))?;

    let aws = crate::storage::sessions::read_aws_secret(vault, &session.id)?;

    let stream = crate::ssh::ssm_channel::open_ssm_stream(
        region,
        instance_id,
        session.port,
        session.aws_access_key_id.as_deref(),
        aws.secret_access_key.as_deref(),
    )
    .await?;

    let mut handle = russh::client::connect_stream(cfg(), stream, AcceptAllHandler)
        .await
        .map_err(|e| AppError::Ssh(format!("SSH over SSM failed: {e}")))?;

    let secret = crate::storage::sessions::read_secret(vault, &session.id)?;
    authenticate(&mut handle, session, &secret).await?;

    Ok(DialResult { handle, jump: None, ssm_child: None })
}

/// Establish a connected, authenticated handle to `session`, transparently
/// forwarding through SSM or `jump_session_id` if configured.
pub async fn dial(vault: &Vault, session: &Session) -> AppResult<DialResult> {
    if session.use_ssm {
        return dial_ssm(vault, session).await;
    }

    let secret = crate::storage::sessions::read_secret(vault, &session.id)?;
    let (mut handle, jump_handle) = if let Some(jump_id) = &session.jump_session_id {
        let jump = crate::storage::sessions::get(vault, jump_id)?;
        let jump_secret = crate::storage::sessions::read_secret(vault, jump_id)?;
        let mut jh = open_handle(&jump.host, jump.port).await?;
        authenticate(&mut jh, &jump, &jump_secret).await?;

        let ch = jh
            .channel_open_direct_tcpip(&session.host, session.port as u32, "127.0.0.1", 0)
            .await
            .map_err(|e| AppError::Ssh(format!("ProxyJump open: {e}")))?;
        let stream = ch.into_stream();
        let h = russh::client::connect_stream(cfg(), stream, AcceptAllHandler)
            .await
            .map_err(|e| AppError::Ssh(format!("connect via jump: {e}")))?;
        (h, Some(jh))
    } else {
        (open_handle(&session.host, session.port).await?, None)
    };
    authenticate(&mut handle, session, &secret).await?;
    Ok(DialResult { handle, jump: jump_handle, ssm_child: None })
}

pub async fn exec_capture(
    h: &mut Handle<AcceptAllHandler>,
    cmd: &str,
) -> AppResult<String> {
    let mut ch: russh::Channel<Msg> = h
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("open channel: {e}")))?;
    ch.exec(true, cmd)
        .await
        .map_err(|e| AppError::Ssh(format!("exec: {e}")))?;
    let mut out = Vec::new();
    while let Some(msg) = ch.wait().await {
        match msg {
            ChannelMsg::Data { ref data } => out.extend_from_slice(data),
            ChannelMsg::ExtendedData { ref data, .. } => out.extend_from_slice(data),
            ChannelMsg::ExitStatus { .. } => {}
            ChannelMsg::Eof => break,
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

/// One-shot connect, run `whoami && uname -a`, disconnect.
pub async fn test_session(vault: &Vault, session_id: &str) -> AppResult<SshTestResult> {
    let session = crate::storage::sessions::get(vault, session_id)?;
    let r = dial(vault, &session).await?;
    let mut handle = r.handle;
    let user = exec_capture(&mut handle, "whoami").await.ok();
    let uname = exec_capture(&mut handle, "uname -a").await.ok();
    let _ = handle.disconnect(Disconnect::ByApplication, "bye", "en").await;

    crate::storage::sessions::touch_last_connected(vault, session_id)?;

    Ok(SshTestResult {
        ok: true,
        message: "connection succeeded".into(),
        remote_user: user,
        remote_uname: uname,
    })
}
