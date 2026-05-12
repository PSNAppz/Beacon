use crate::error::{AppError, AppResult};
use crate::storage::db::{now_unix, Vault};
use rusqlite::{params, Row};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthKind {
    Key,
    Password,
    Agent,
}

impl AuthKind {
    fn as_str(&self) -> &'static str {
        match self {
            AuthKind::Key => "key",
            AuthKind::Password => "password",
            AuthKind::Agent => "agent",
        }
    }
    fn parse(s: &str) -> AppResult<Self> {
        Ok(match s {
            "key" => AuthKind::Key,
            "password" => AuthKind::Password,
            "agent" => AuthKind::Agent,
            other => return Err(AppError::Other(format!("unknown auth_kind: {other}"))),
        })
    }
}

/// Public, non-secret view of a session. Sent to the UI.
#[derive(Debug, Clone, Serialize)]
pub struct Session {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_kind: AuthKind,
    pub key_path: Option<String>,
    pub has_secret: bool,
    pub jump_session_id: Option<String>,
    pub color: String,
    pub read_only: bool,
    pub use_sudo: bool,
    pub last_connected: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Input from the UI for create / update.
#[derive(Debug, Clone, Deserialize)]
pub struct SessionInput {
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_kind: AuthKind,
    pub key_path: Option<String>,
    /// Provided in plaintext from UI; stored encrypted. None = leave existing.
    pub secret_plain: Option<String>,
    pub jump_session_id: Option<String>,
    pub color: String,
    pub read_only: bool,
    #[serde(default)]
    pub use_sudo: bool,
}

/// Decrypted secret material for actually connecting.
#[derive(Debug, Clone)]
pub struct SessionSecret {
    pub plain: Option<Vec<u8>>,
}

fn row_to_session(r: &Row<'_>) -> rusqlite::Result<Session> {
    Ok(Session {
        id: r.get(0)?,
        name: r.get(1)?,
        host: r.get(2)?,
        port: r.get::<_, i64>(3)? as u16,
        username: r.get(4)?,
        auth_kind: AuthKind::parse(&r.get::<_, String>(5)?).unwrap_or(AuthKind::Key),
        key_path: r.get(6)?,
        has_secret: r.get::<_, Option<String>>(7)?.is_some(),
        jump_session_id: r.get(8)?,
        color: r.get(9)?,
        read_only: r.get::<_, i64>(10)? != 0,
        last_connected: r.get(11)?,
        created_at: r.get(12)?,
        updated_at: r.get(13)?,
        use_sudo: r.get::<_, i64>(14)? != 0,
    })
}

const SELECT_COLS: &str = "id, name, host, port, username, auth_kind, key_path, secret_b64, \
                           jump_session_id, color, read_only, last_connected, created_at, updated_at, \
                           use_sudo";

pub fn list(vault: &Vault) -> AppResult<Vec<Session>> {
    let conn = vault.conn.lock();
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLS} FROM sessions ORDER BY last_connected DESC NULLS LAST, name ASC"
    ))?;
    let rows = stmt.query_map([], row_to_session)?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

pub fn get(vault: &Vault, id: &str) -> AppResult<Session> {
    let conn = vault.conn.lock();
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLS} FROM sessions WHERE id = ?1"
    ))?;
    let s = stmt
        .query_row(params![id], row_to_session)
        .map_err(|_| AppError::NotFound)?;
    Ok(s)
}

pub fn upsert(vault: &Vault, input: SessionInput) -> AppResult<Session> {
    let id = input.id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = now_unix();
    let secret_b64 = match &input.secret_plain {
        Some(s) if !s.is_empty() => Some(vault.key.encrypt_to_b64(s.as_bytes())?),
        Some(_) => None,
        None => {
            // Preserve existing if any.
            let conn = vault.conn.lock();
            conn.query_row(
                "SELECT secret_b64 FROM sessions WHERE id = ?1",
                params![&id],
                |r| r.get::<_, Option<String>>(0),
            ).unwrap_or(None)
        }
    };

    let conn = vault.conn.lock();
    conn.execute(
        "INSERT INTO sessions (id, name, host, port, username, auth_kind, key_path, secret_b64, \
            jump_session_id, color, read_only, last_connected, created_at, updated_at, use_sudo) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, ?12, ?12, ?13) \
         ON CONFLICT(id) DO UPDATE SET \
            name=excluded.name, host=excluded.host, port=excluded.port, \
            username=excluded.username, auth_kind=excluded.auth_kind, \
            key_path=excluded.key_path, secret_b64=excluded.secret_b64, \
            jump_session_id=excluded.jump_session_id, color=excluded.color, \
            read_only=excluded.read_only, use_sudo=excluded.use_sudo, \
            updated_at=excluded.updated_at",
        params![
            id, input.name, input.host, input.port as i64, input.username,
            input.auth_kind.as_str(), input.key_path, secret_b64,
            input.jump_session_id, input.color, input.read_only as i64, now,
            input.use_sudo as i64,
        ],
    )?;
    drop(conn);
    get(vault, &id)
}

pub fn delete(vault: &Vault, id: &str) -> AppResult<()> {
    let conn = vault.conn.lock();
    let n = conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
    if n == 0 { return Err(AppError::NotFound); }
    Ok(())
}

pub fn touch_last_connected(vault: &Vault, id: &str) -> AppResult<()> {
    let conn = vault.conn.lock();
    conn.execute(
        "UPDATE sessions SET last_connected = ?1 WHERE id = ?2",
        params![now_unix(), id],
    )?;
    Ok(())
}

pub fn read_secret(vault: &Vault, id: &str) -> AppResult<SessionSecret> {
    let conn = vault.conn.lock();
    let s: Option<String> = conn
        .query_row(
            "SELECT secret_b64 FROM sessions WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .map_err(|_| AppError::NotFound)?;
    let plain = match s {
        Some(b64) => Some(vault.key.decrypt_from_b64(&b64)?),
        None => None,
    };
    Ok(SessionSecret { plain })
}
