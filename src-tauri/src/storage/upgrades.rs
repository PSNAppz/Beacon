//! CRUD for per-session upgrade flows.
//!
//! Each flow is tied to a session and contains an ordered list of shell
//! commands (steps).  Each step is a self-contained command the user writes
//! themselves — e.g. `git pull` or `docker-compose down && docker-compose up --build -d`.
//! A `working_directory` field can be set once on the flow; the confirm dialog
//! prepends `cd <dir> && ` to every step before execution so each step runs in
//! the right place without the user having to repeat it.
//! There is exactly **one** upgrade flow per session (UNIQUE on session_id).

use crate::error::{AppError, AppResult};
use crate::storage::db::{now_unix, Vault};
use rusqlite::{params, Row};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ─── Public types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpgradeFlow {
    pub id: String,
    pub session_id: String,
    pub label: Option<String>,
    pub working_directory: Option<String>,
    pub steps: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpgradeFlowInput {
    pub id: Option<String>,
    pub session_id: String,
    pub label: Option<String>,
    pub working_directory: Option<String>,
    pub steps: Vec<String>,
}

// ─── Row deserialiser ─────────────────────────────────────────────────────────

fn row_to_flow(r: &Row<'_>) -> rusqlite::Result<UpgradeFlow> {
    let steps_json: String = r.get(4)?;
    let steps: Vec<String> = serde_json::from_str(&steps_json).unwrap_or_default();
    Ok(UpgradeFlow {
        id: r.get(0)?,
        session_id: r.get(1)?,
        label: r.get(2)?,
        working_directory: r.get(3)?,
        steps,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
    })
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/// Get the upgrade flow for a session, or None if not configured.
pub fn get_for_session(vault: &Vault, session_id: &str) -> AppResult<Option<UpgradeFlow>> {
    let conn = vault.conn.lock();
    let mut stmt = conn.prepare(
        "SELECT id, session_id, label, working_directory, steps, created_at, updated_at \
         FROM upgrade_flows WHERE session_id = ?1",
    )?;
    let mut rows = stmt.query_map(params![session_id], row_to_flow)?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

/// Fetch a single flow by its primary key.
pub fn get(vault: &Vault, id: &str) -> AppResult<UpgradeFlow> {
    let conn = vault.conn.lock();
    let mut stmt = conn.prepare(
        "SELECT id, session_id, label, working_directory, steps, created_at, updated_at \
         FROM upgrade_flows WHERE id = ?1",
    )?;
    stmt.query_row(params![id], row_to_flow)
        .map_err(|_| AppError::NotFound)
}

/// Insert or update the single flow for a session.
pub fn upsert(vault: &Vault, input: UpgradeFlowInput) -> AppResult<UpgradeFlow> {
    let id = input.id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = now_unix();
    let steps_json = serde_json::to_string(&input.steps)
        .map_err(|e| AppError::Other(format!("steps serialize: {e}")))?;

    let conn = vault.conn.lock();
    conn.execute(
        "INSERT INTO upgrade_flows (id, session_id, label, working_directory, steps, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) \
         ON CONFLICT(session_id) DO UPDATE SET \
             id                = excluded.id, \
             label             = excluded.label, \
             working_directory = excluded.working_directory, \
             steps             = excluded.steps, \
             updated_at        = excluded.updated_at",
        params![id, input.session_id, input.label, input.working_directory, steps_json, now],
    )?;
    drop(conn);
    get(vault, &id)
}

/// Delete the upgrade flow for a session.
pub fn delete(vault: &Vault, session_id: &str) -> AppResult<()> {
    let conn = vault.conn.lock();
    let n = conn.execute(
        "DELETE FROM upgrade_flows WHERE session_id = ?1",
        params![session_id],
    )?;
    if n == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

/// Fetch flows for a list of session ids (used during export).
pub fn list_for_sessions(vault: &Vault, session_ids: &[String]) -> AppResult<Vec<UpgradeFlow>> {
    if session_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders: String = session_ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect::<Vec<_>>()
        .join(", ");
    let conn = vault.conn.lock();
    let sql = format!(
        "SELECT id, session_id, label, working_directory, steps, created_at, updated_at \
         FROM upgrade_flows WHERE session_id IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params_vec: Vec<&dyn rusqlite::ToSql> = session_ids
        .iter()
        .map(|s| s as &dyn rusqlite::ToSql)
        .collect();
    let rows = stmt.query_map(params_vec.as_slice(), row_to_flow)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
