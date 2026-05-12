//! Local rolling log archive. Writes log lines to a plain (non-encrypted)
//! SQLite database in the user data directory. Keyed by (session_id,
//! container_id); capped at 50 000 rows per container to bound disk use.

use crate::error::AppResult;
use crate::ssh::docker::LogLine;
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use std::path::PathBuf;

// ─── State ───────────────────────────────────────────────────────────────────

pub struct ArchiveState {
    conn: Mutex<Option<Connection>>,
}

impl ArchiveState {
    pub fn new() -> Self {
        Self { conn: Mutex::new(None) }
    }

    /// Lazily opens the archive DB, then calls `f` with the connection while
    /// holding the lock. Any earlier open error is returned.
    pub fn with_conn<R>(&self, f: impl FnOnce(&Connection) -> AppResult<R>) -> AppResult<R> {
        let mut guard = self.conn.lock();
        if guard.is_none() {
            *guard = Some(open_db()?);
        }
        f(guard.as_ref().unwrap())
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn archive_path() -> AppResult<PathBuf> {
    let base = dirs::data_local_dir()
        .or_else(|| dirs::data_dir())
        .ok_or_else(|| crate::error::AppError::Other("no data dir".into()))?;
    let dir = base.join("Beacon");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("archive.db"))
}

fn open_db() -> AppResult<Connection> {
    let conn = Connection::open(archive_path()?)?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS log_archive (
             id           INTEGER PRIMARY KEY AUTOINCREMENT,
             session_id   TEXT    NOT NULL,
             container_id TEXT    NOT NULL,
             ts           TEXT,
             text         TEXT    NOT NULL,
             stderr       INTEGER NOT NULL DEFAULT 0,
             created_at   INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_archive_lookup
             ON log_archive (session_id, container_id, id);",
    )?;
    Ok(conn)
}

/// Maximum rows kept per (session_id, container_id) pair.
const CAP: i64 = 50_000;

// ─── Operations ──────────────────────────────────────────────────────────────

pub fn write_lines(
    conn: &Connection,
    session_id: &str,
    container_id: &str,
    lines: &[LogLine],
) -> AppResult<()> {
    if lines.is_empty() {
        return Ok(());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    conn.execute_batch("BEGIN")?;
    {
        let mut stmt = conn.prepare_cached(
            "INSERT INTO log_archive (session_id, container_id, ts, text, stderr, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for l in lines {
            stmt.execute(params![
                session_id,
                container_id,
                l.ts,
                l.text,
                l.stderr as i32,
                now,
            ])?;
        }
    }
    // Delete rows that exceed the cap (keep the newest CAP rows).
    conn.execute(
        "DELETE FROM log_archive
         WHERE session_id = ?1 AND container_id = ?2
           AND id <= COALESCE((
               SELECT id FROM log_archive
               WHERE session_id = ?1 AND container_id = ?2
               ORDER BY id DESC
               LIMIT 1 OFFSET ?3
           ), 0)",
        params![session_id, container_id, CAP],
    )?;
    conn.execute_batch("COMMIT")?;
    Ok(())
}

pub fn read_lines(
    conn: &Connection,
    session_id: &str,
    container_id: &str,
    limit: i64,
) -> AppResult<Vec<LogLine>> {
    let mut stmt = conn.prepare(
        "SELECT ts, text, stderr FROM log_archive
         WHERE session_id = ?1 AND container_id = ?2
         ORDER BY id DESC LIMIT ?3",
    )?;
    let mut rows: Vec<LogLine> = stmt
        .query_map(params![session_id, container_id, limit], |row| {
            Ok(LogLine {
                ts: row.get(0)?,
                text: row.get(1)?,
                stderr: row.get::<_, i32>(2)? != 0,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    rows.reverse(); // oldest first
    Ok(rows)
}
