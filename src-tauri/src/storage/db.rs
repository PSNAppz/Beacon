use crate::crypto::{random_salt, VaultKey, VAULT_VERIFIER_PLAINTEXT};
use crate::error::{AppError, AppResult};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const MIGRATIONS: &[&str] = &[
    // v1: schema
    r#"
    CREATE TABLE IF NOT EXISTS vault_meta (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        salt_b64    TEXT NOT NULL,
        verifier_b64 TEXT NOT NULL,
        created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        host            TEXT NOT NULL,
        port            INTEGER NOT NULL DEFAULT 22,
        username        TEXT NOT NULL,
        auth_kind       TEXT NOT NULL,           -- 'key' | 'password' | 'agent'
        key_path        TEXT,                    -- on-disk path (plaintext is fine; path itself isn't secret)
        secret_b64      TEXT,                    -- AEAD-encrypted blob: passphrase OR password OR raw key bytes
        jump_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        color           TEXT NOT NULL DEFAULT '#78c8ff',
        read_only       INTEGER NOT NULL DEFAULT 0,
        last_connected  INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name);
    "#,
];

pub struct VaultState {
    pub inner: Mutex<Option<Vault>>,
}

impl VaultState {
    pub fn new() -> Self { Self { inner: Mutex::new(None) } }
}

pub struct Vault {
    pub conn: Arc<Mutex<Connection>>,
    pub key: VaultKey,
}

impl Vault {
    pub fn db_path() -> AppResult<PathBuf> {
        let dir = dirs::data_dir()
            .ok_or_else(|| AppError::Other("no data dir".into()))?
            .join("Beacon");
        std::fs::create_dir_all(&dir)?;
        Ok(dir.join("vault.db"))
    }

    fn open_conn(path: &Path) -> AppResult<Connection> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        for m in MIGRATIONS {
            conn.execute_batch(m)?;
        }
        Self::ensure_columns(&conn)?;
        Ok(conn)
    }

    fn ensure_columns(conn: &Connection) -> AppResult<()> {
        let has_use_sudo: bool = conn
            .query_row(
                "SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'use_sudo'",
                [],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if !has_use_sudo {
            conn.execute(
                "ALTER TABLE sessions ADD COLUMN use_sudo INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        Ok(())
    }

    pub fn is_initialized() -> AppResult<bool> {
        let path = Self::db_path()?;
        if !path.exists() { return Ok(false); }
        let conn = Self::open_conn(&path)?;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM vault_meta WHERE id = 1", [], |r| r.get(0))
            .unwrap_or(0);
        Ok(count > 0)
    }

    /// Create a new vault with the given master password. Errors if already initialized.
    pub fn create(password: &str) -> AppResult<Self> {
        let path = Self::db_path()?;
        let conn = Self::open_conn(&path)?;
        let already: i64 = conn
            .query_row("SELECT COUNT(*) FROM vault_meta WHERE id = 1", [], |r| r.get(0))
            .unwrap_or(0);
        if already > 0 {
            return Err(AppError::AlreadyInitialized);
        }
        let salt = random_salt();
        let key = VaultKey::derive(password, &salt)?;
        let verifier = key.encrypt_to_b64(VAULT_VERIFIER_PLAINTEXT)?;
        let salt_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, salt);
        conn.execute(
            "INSERT INTO vault_meta (id, salt_b64, verifier_b64, created_at) VALUES (1, ?1, ?2, ?3)",
            params![salt_b64, verifier, now_unix()],
        )?;
        Ok(Self { conn: Arc::new(Mutex::new(conn)), key })
    }

    /// Open an existing vault and verify the master password.
    pub fn unlock(password: &str) -> AppResult<Self> {
        let path = Self::db_path()?;
        let conn = Self::open_conn(&path)?;
        let row: (String, String) = conn
            .query_row(
                "SELECT salt_b64, verifier_b64 FROM vault_meta WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| AppError::NotFound)?;
        let salt = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &row.0)
            .map_err(|e| AppError::Crypto(format!("salt b64: {e}")))?;
        let key = VaultKey::derive(password, &salt)?;
        let plain = key.decrypt_from_b64(&row.1)?;
        if plain != VAULT_VERIFIER_PLAINTEXT {
            return Err(AppError::BadPassword);
        }
        Ok(Self { conn: Arc::new(Mutex::new(conn)), key })
    }
}

pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
