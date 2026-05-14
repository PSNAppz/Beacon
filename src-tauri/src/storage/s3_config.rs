use crate::error::{AppError, AppResult};
use crate::storage::db::{now_unix, Vault};
use rusqlite::params;
use serde::{Deserialize, Serialize};

/// Full S3 config with decrypted secret — never sent to the frontend.
#[derive(Debug, Clone)]
pub struct S3Config {
    pub bucket: String,
    pub region: String,
    pub aws_access_key_id: String,
    pub aws_secret: String,
}

/// Safe view sent to the frontend — secret is omitted.
#[derive(Debug, Clone, Serialize)]
pub struct S3ConfigPublic {
    pub bucket: String,
    pub region: String,
    pub aws_access_key_id: String,
    pub has_secret: bool,
}

/// Input from the UI for create / update.
#[derive(Debug, Clone, Deserialize)]
pub struct S3ConfigInput {
    pub bucket: String,
    pub region: String,
    pub aws_access_key_id: String,
    /// Plaintext secret key. `None` = keep existing encrypted value.
    pub aws_secret_key: Option<String>,
}

/// Read and decrypt the S3 config. Returns `None` if not configured yet.
pub fn get(vault: &Vault) -> AppResult<Option<S3Config>> {
    let conn = vault.conn.lock();
    let row: Option<(String, String, String, String)> = conn
        .query_row(
            "SELECT bucket, region, aws_access_key_id, aws_secret_b64 FROM s3_config WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .ok();

    let (bucket, region, aws_access_key_id, secret_b64) = match row {
        Some(r) => r,
        None => return Ok(None),
    };

    let aws_secret = String::from_utf8(vault.key.decrypt_from_b64(&secret_b64)?)
        .map_err(|_| AppError::Crypto("S3 secret not valid UTF-8".into()))?;

    Ok(Some(S3Config { bucket, region, aws_access_key_id, aws_secret }))
}

/// Read the public (non-secret) view of the S3 config.
pub fn get_public(vault: &Vault) -> AppResult<Option<S3ConfigPublic>> {
    let conn = vault.conn.lock();
    let row: Option<(String, String, String, bool)> = conn
        .query_row(
            "SELECT bucket, region, aws_access_key_id, aws_secret_b64 IS NOT NULL \
             FROM s3_config WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? != 0)),
        )
        .ok();

    Ok(row.map(|(bucket, region, aws_access_key_id, has_secret)| S3ConfigPublic {
        bucket,
        region,
        aws_access_key_id,
        has_secret,
    }))
}

/// Create or update the S3 config. If `aws_secret_key` is `None`, the existing
/// encrypted secret is preserved.
pub fn upsert(vault: &Vault, input: S3ConfigInput) -> AppResult<S3ConfigPublic> {
    let now = now_unix();

    let aws_secret_b64 = match &input.aws_secret_key {
        Some(s) if !s.is_empty() => vault.key.encrypt_to_b64(s.as_bytes())?,
        Some(_) => {
            return Err(AppError::Other("AWS secret key cannot be empty".into()));
        }
        None => {
            // Preserve existing encrypted secret, or error if this is first-time setup.
            let conn = vault.conn.lock();
            conn.query_row(
                "SELECT aws_secret_b64 FROM s3_config WHERE id = 1",
                [],
                |r| r.get::<_, String>(0),
            )
            .map_err(|_| {
                AppError::Other(
                    "AWS secret key is required when configuring S3 for the first time".into(),
                )
            })?
        }
    };

    let conn = vault.conn.lock();
    conn.execute(
        "INSERT INTO s3_config (id, bucket, region, aws_access_key_id, aws_secret_b64, \
                                created_at, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(id) DO UPDATE SET
             bucket            = excluded.bucket,
             region            = excluded.region,
             aws_access_key_id = excluded.aws_access_key_id,
             aws_secret_b64    = excluded.aws_secret_b64,
             updated_at        = excluded.updated_at",
        params![input.bucket, input.region, input.aws_access_key_id, aws_secret_b64, now],
    )?;

    Ok(S3ConfigPublic {
        bucket: input.bucket,
        region: input.region,
        aws_access_key_id: input.aws_access_key_id,
        has_secret: true,
    })
}

/// Remove the S3 config entirely.
pub fn delete(vault: &Vault) -> AppResult<()> {
    let conn = vault.conn.lock();
    conn.execute("DELETE FROM s3_config WHERE id = 1", [])?;
    Ok(())
}
