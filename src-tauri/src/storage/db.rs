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
        // use_sudo (original migration)
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

        // categories table
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS categories (
                 id         TEXT PRIMARY KEY,
                 name       TEXT NOT NULL UNIQUE,
                 created_at INTEGER NOT NULL
             );",
        )?;

        // category_id on sessions (no FK in ALTER TABLE — SQLite limitation)
        let has_category_id: bool = conn
            .query_row(
                "SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'category_id'",
                [],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if !has_category_id {
            conn.execute("ALTER TABLE sessions ADD COLUMN category_id TEXT", [])?;
        }

        // SSM columns + AWS credential columns
        for (col, def) in [
            ("use_ssm", "INTEGER NOT NULL DEFAULT 0"),
            ("ssm_instance_id", "TEXT"),
            ("aws_region", "TEXT"),
            ("aws_profile", "TEXT"),
            ("aws_access_key_id", "TEXT"),
            ("aws_secret_b64", "TEXT"),
        ] {
            let has: bool = conn
                .query_row(
                    &format!("SELECT 1 FROM pragma_table_info('sessions') WHERE name = '{col}'"),
                    [],
                    |_| Ok(true),
                )
                .unwrap_or(false);
            if !has {
                conn.execute(
                    &format!("ALTER TABLE sessions ADD COLUMN {col} {def}"),
                    [],
                )?;
            }
        }

        // s3_config table (singleton row id=1)
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS s3_config (
                 id                INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
                 bucket            TEXT    NOT NULL,
                 region            TEXT    NOT NULL,
                 aws_access_key_id TEXT    NOT NULL,
                 aws_secret_b64    TEXT    NOT NULL,
                 created_at        INTEGER NOT NULL,
                 updated_at        INTEGER NOT NULL
             );",
        )?;

        // upgrade_flows table (per-server, not per-container).
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS upgrade_flows (
                 id                TEXT PRIMARY KEY,
                 session_id        TEXT NOT NULL UNIQUE,
                 label             TEXT,
                 working_directory TEXT,
                 steps             TEXT NOT NULL DEFAULT '[]',
                 created_at        INTEGER NOT NULL,
                 updated_at        INTEGER NOT NULL,
                 FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
             );",
        )?;
        // Add working_directory to existing installs that predate this column.
        let has_working_dir: bool = conn
            .query_row(
                "SELECT 1 FROM pragma_table_info('upgrade_flows') WHERE name = 'working_directory'",
                [],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if !has_working_dir {
            conn.execute("ALTER TABLE upgrade_flows ADD COLUMN working_directory TEXT", [])?;
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

    /// Re-key the vault: verify old password, derive a new key, re-encrypt all
    /// secrets, and swap the in-memory key atomically.
    pub fn change_password(&mut self, old_password: &str, new_password: &str) -> AppResult<()> {
        // Read stored salt + verifier.
        let (salt_b64, verifier_b64): (String, String) = {
            let conn = self.conn.lock();
            conn.query_row(
                "SELECT salt_b64, verifier_b64 FROM vault_meta WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| AppError::NotFound)?
        };

        let salt_bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            &salt_b64,
        )
        .map_err(|e| AppError::Crypto(format!("salt b64: {e}")))?;

        // Verify the old password (re-derive + decrypt verifier).
        let old_key = VaultKey::derive(old_password, &salt_bytes)?;
        old_key.decrypt_from_b64(&verifier_b64)?;

        // Derive new key with a fresh random salt.
        let new_salt = random_salt();
        let new_key = VaultKey::derive(new_password, &new_salt)?;
        let new_verifier = new_key.encrypt_to_b64(VAULT_VERIFIER_PLAINTEXT)?;
        let new_salt_b64 =
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, new_salt);

        // Re-encrypt all session secrets under the new key.
        {
            let conn = self.conn.lock();

            let ids_secrets: Vec<(String, String)> = {
                let mut stmt = conn.prepare(
                    "SELECT id, secret_b64 FROM sessions WHERE secret_b64 IS NOT NULL",
                )?;
                let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };

            for (id, secret_b64) in ids_secrets {
                let plaintext = old_key.decrypt_from_b64(&secret_b64)?;
                let re_encrypted = new_key.encrypt_to_b64(&plaintext)?;
                conn.execute(
                    "UPDATE sessions SET secret_b64 = ?1 WHERE id = ?2",
                    params![re_encrypted, id],
                )?;
            }

            // Re-encrypt AWS secret access keys
            let aws_rows: Vec<(String, String)> = {
                let mut stmt = conn.prepare(
                    "SELECT id, aws_secret_b64 FROM sessions WHERE aws_secret_b64 IS NOT NULL",
                )?;
                let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };
            for (id, aws_b64) in aws_rows {
                let plaintext = old_key.decrypt_from_b64(&aws_b64)?;
                let re_encrypted = new_key.encrypt_to_b64(&plaintext)?;
                conn.execute(
                    "UPDATE sessions SET aws_secret_b64 = ?1 WHERE id = ?2",
                    params![re_encrypted, id],
                )?;
            }

            // Re-encrypt S3 secret if present
            let s3_secret: Option<String> = conn
                .query_row(
                    "SELECT aws_secret_b64 FROM s3_config WHERE id = 1",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(None);
            if let Some(s3_b64) = s3_secret {
                let plaintext = old_key.decrypt_from_b64(&s3_b64)?;
                let re_encrypted = new_key.encrypt_to_b64(&plaintext)?;
                conn.execute(
                    "UPDATE s3_config SET aws_secret_b64 = ?1 WHERE id = 1",
                    params![re_encrypted],
                )?;
            }

            conn.execute(
                "UPDATE vault_meta SET salt_b64 = ?1, verifier_b64 = ?2 WHERE id = 1",
                params![new_salt_b64, new_verifier],
            )?;
        }

        // Swap the in-memory key last — only after the DB write succeeds.
        self.key = new_key;
        Ok(())
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
