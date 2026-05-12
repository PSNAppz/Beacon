use crate::crypto::{random_salt, VaultKey};
use crate::error::{AppError, AppResult};
use crate::storage::db::{now_unix, Vault};
use crate::storage::sessions::{AuthKind, Session, SessionInput};
use base64::Engine;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ─── File envelope ────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct BcnxFile {
    version: u8,
    /// Base64-encoded 16-byte Argon2id salt.
    salt: String,
    /// Base64-encoded nonce(12) || ciphertext+tag produced by VaultKey::encrypt_to_b64.
    payload: String,
}

// ─── Inner payload (inside the encrypted blob) ────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct BcnxPayload {
    version: u8,
    exported_at: i64,
    categories: Vec<CategoryRow>,
    sessions: Vec<ExportSession>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct CategoryRow {
    id: String,
    name: String,
    created_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
struct ExportSession {
    id: String,
    name: String,
    host: String,
    port: u16,
    username: String,
    auth_kind: AuthKind,
    key_path: Option<String>,
    secret_plain: Option<String>,
    jump_session_id: Option<String>,
    color: String,
    read_only: bool,
    use_sudo: bool,
    category_id: Option<String>,
    use_ssm: bool,
    ssm_instance_id: Option<String>,
    aws_region: Option<String>,
    aws_profile: Option<String>,
    aws_access_key_id: Option<String>,
    aws_secret_access_key: Option<String>,
}

// ─── Public preview types (returned to the frontend) ─────────────────────────

#[derive(Serialize, Clone)]
pub struct ImportPreview {
    pub sessions: Vec<ImportSessionPreview>,
}

#[derive(Serialize, Clone)]
pub struct ImportSessionPreview {
    pub id: String,
    pub name: String,
    pub host: String,
    pub username: String,
    pub auth_kind: AuthKind,
    pub has_secret: bool,
    pub has_aws_secret: bool,
    pub category_name: Option<String>,
    /// "same_id" | "same_name" | null
    pub conflict: Option<String>,
}

// ─── Crypto helpers ───────────────────────────────────────────────────────────

fn build_bcnx(password: &str, payload: &BcnxPayload) -> AppResult<String> {
    let json = serde_json::to_vec(payload)
        .map_err(|e| AppError::Other(format!("serialize: {e}")))?;
    let salt = random_salt();
    let key = VaultKey::derive(password, &salt)?;
    let encrypted = key.encrypt_to_b64(&json)?;
    let file = BcnxFile {
        version: 1,
        salt: base64::engine::general_purpose::STANDARD.encode(salt),
        payload: encrypted,
    };
    serde_json::to_string(&file).map_err(|e| AppError::Other(format!("serialize envelope: {e}")))
}

fn parse_bcnx(data: &str, password: &str) -> AppResult<BcnxPayload> {
    let file: BcnxFile = serde_json::from_str(data)
        .map_err(|_| AppError::Other("not a valid .bcnx file".into()))?;
    if file.version != 1 {
        return Err(AppError::Other(format!(
            "unsupported .bcnx version {}",
            file.version
        )));
    }
    let salt = base64::engine::general_purpose::STANDARD
        .decode(&file.salt)
        .map_err(|_| AppError::Other("corrupt .bcnx file (salt)".into()))?;
    let key = VaultKey::derive(password, &salt)?;
    let plain = key.decrypt_from_b64(&file.payload)?; // returns BadPassword on AEAD failure
    serde_json::from_slice::<BcnxPayload>(&plain)
        .map_err(|_| AppError::Other("corrupt .bcnx payload".into()))
}

// ─── Public API ───────────────────────────────────────────────────────────────

/// Collect the requested sessions (with decrypted secrets), encrypt them with
/// `password`, and write the result to `path`.
pub fn export_sessions(vault: &Vault, ids: &[String], password: &str, path: &str) -> AppResult<()> {
    let mut sessions_out: Vec<ExportSession> = Vec::new();
    let mut cat_ids: Vec<String> = Vec::new();

    for id in ids {
        let s = crate::storage::sessions::get(vault, id)?;
        let secret = crate::storage::sessions::read_secret(vault, id)?;
        let aws = crate::storage::sessions::read_aws_secret(vault, id)?;

        let secret_plain = secret
            .plain
            .map(|b| String::from_utf8_lossy(&b).into_owned());

        if let Some(cid) = &s.category_id {
            if !cat_ids.contains(cid) {
                cat_ids.push(cid.clone());
            }
        }

        sessions_out.push(ExportSession {
            id: s.id,
            name: s.name,
            host: s.host,
            port: s.port,
            username: s.username,
            auth_kind: s.auth_kind,
            key_path: s.key_path,
            secret_plain,
            jump_session_id: s.jump_session_id,
            color: s.color,
            read_only: s.read_only,
            use_sudo: s.use_sudo,
            category_id: s.category_id,
            use_ssm: s.use_ssm,
            ssm_instance_id: s.ssm_instance_id,
            aws_region: s.aws_region,
            aws_profile: s.aws_profile,
            aws_access_key_id: s.aws_access_key_id,
            aws_secret_access_key: aws.secret_access_key,
        });
    }

    // Fetch referenced categories
    let categories = fetch_categories_by_ids(vault, &cat_ids)?;

    let payload = BcnxPayload {
        version: 1,
        exported_at: now_unix(),
        categories,
        sessions: sessions_out,
    };
    let content = build_bcnx(password, &payload)?;
    std::fs::write(path, content)?;
    Ok(())
}

/// Decrypt and inspect a `.bcnx` file, returning a preview suitable for the
/// UI's import confirmation step.
pub fn preview_import(vault: &Vault, path: &str, password: &str) -> AppResult<ImportPreview> {
    let data = std::fs::read_to_string(path)?;
    let payload = parse_bcnx(&data, password)?;

    let existing = crate::storage::sessions::list(vault)?;
    let existing_ids: std::collections::HashSet<&str> =
        existing.iter().map(|s| s.id.as_str()).collect();
    let existing_names: std::collections::HashMap<String, &str> = existing
        .iter()
        .map(|s| (s.name.to_lowercase(), s.id.as_str()))
        .collect();

    let sessions = payload
        .sessions
        .iter()
        .map(|s| {
            let conflict = if existing_ids.contains(s.id.as_str()) {
                Some("same_id".to_string())
            } else if existing_names
                .get(&s.name.to_lowercase())
                .map(|existing_id| *existing_id != s.id)
                .unwrap_or(false)
            {
                Some("same_name".to_string())
            } else {
                None
            };
            let category_name = s.category_id.as_ref().and_then(|cid| {
                payload
                    .categories
                    .iter()
                    .find(|c| &c.id == cid)
                    .map(|c| c.name.clone())
            });
            ImportSessionPreview {
                id: s.id.clone(),
                name: s.name.clone(),
                host: s.host.clone(),
                username: s.username.clone(),
                auth_kind: s.auth_kind,
                has_secret: s.secret_plain.is_some(),
                has_aws_secret: s.aws_secret_access_key.is_some(),
                category_name,
                conflict,
            }
        })
        .collect();

    Ok(ImportPreview { sessions })
}

/// Import the selected sessions from a `.bcnx` file into the vault.
/// `conflict_strategy`: "skip" | "overwrite" | "rename"
pub fn import_sessions(
    vault: &Vault,
    path: &str,
    password: &str,
    selected_ids: &[String],
    conflict_strategy: &str,
) -> AppResult<Vec<Session>> {
    let data = std::fs::read_to_string(path)?;
    let payload = parse_bcnx(&data, password)?;

    let existing = crate::storage::sessions::list(vault)?;
    let existing_ids: std::collections::HashSet<&str> =
        existing.iter().map(|s| s.id.as_str()).collect();
    let existing_names: std::collections::HashMap<String, String> = existing
        .iter()
        .map(|s| (s.name.to_lowercase(), s.id.clone()))
        .collect();

    // Build set of all IDs being imported (for jump_session_id validation)
    let selected_set: std::collections::HashSet<&str> =
        selected_ids.iter().map(|s| s.as_str()).collect();

    // Resolve categories: match by name (case-insensitive), create if absent.
    // Returns a map from file category ID → vault category ID.
    let cat_id_map = resolve_categories(vault, &payload.categories)?;

    let mut imported: Vec<Session> = Vec::new();

    for s in &payload.sessions {
        if !selected_set.contains(s.id.as_str()) {
            continue;
        }

        let has_same_id = existing_ids.contains(s.id.as_str());
        let has_same_name = existing_names
            .get(&s.name.to_lowercase())
            .map(|eid| eid.as_str() != s.id)
            .unwrap_or(false);
        let has_conflict = has_same_id || has_same_name;

        let (final_id, final_name) = match conflict_strategy {
            "skip" if has_conflict => continue,
            "rename" if has_conflict => (Uuid::new_v4().to_string(), format!("{} (imported)", s.name)),
            _ => (s.id.clone(), s.name.clone()), // overwrite or no conflict
        };

        // Null jump_session_id if the target is neither being imported nor already in the vault
        let jump_session_id = s.jump_session_id.as_ref().and_then(|jid| {
            if selected_set.contains(jid.as_str()) || existing_ids.contains(jid.as_str()) {
                Some(jid.clone())
            } else {
                None
            }
        });

        let resolved_category_id = s
            .category_id
            .as_ref()
            .and_then(|cid| cat_id_map.get(cid).cloned());

        let input = SessionInput {
            id: Some(final_id),
            name: final_name,
            host: s.host.clone(),
            port: s.port,
            username: s.username.clone(),
            auth_kind: s.auth_kind,
            key_path: s.key_path.clone(),
            secret_plain: s.secret_plain.clone(),
            jump_session_id,
            color: s.color.clone(),
            read_only: s.read_only,
            use_sudo: s.use_sudo,
            category_id: resolved_category_id,
            use_ssm: s.use_ssm,
            ssm_instance_id: s.ssm_instance_id.clone(),
            aws_region: s.aws_region.clone(),
            aws_profile: s.aws_profile.clone(),
            aws_access_key_id: s.aws_access_key_id.clone(),
            aws_secret_access_key: s.aws_secret_access_key.clone(),
        };

        imported.push(crate::storage::sessions::upsert(vault, input)?);
    }

    Ok(imported)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn fetch_categories_by_ids(vault: &Vault, ids: &[String]) -> AppResult<Vec<CategoryRow>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let conn = vault.conn.lock();
    let mut out = Vec::new();
    for id in ids {
        let r = conn.query_row(
            "SELECT id, name, created_at FROM categories WHERE id = ?1",
            params![id],
            |r| {
                Ok(CategoryRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    created_at: r.get(2)?,
                })
            },
        );
        if let Ok(cat) = r {
            out.push(cat);
        }
    }
    Ok(out)
}

/// Match imported categories to vault categories by name (case-insensitive).
/// Creates missing categories and returns a map: file_cat_id → vault_cat_id.
fn resolve_categories(
    vault: &Vault,
    file_cats: &[CategoryRow],
) -> AppResult<std::collections::HashMap<String, String>> {
    let mut map = std::collections::HashMap::new();
    if file_cats.is_empty() {
        return Ok(map);
    }

    // Load current vault categories once
    let existing = crate::storage::categories::list(vault)?;
    let by_name: std::collections::HashMap<String, String> = existing
        .iter()
        .map(|c| (c.name.to_lowercase(), c.id.clone()))
        .collect();

    for fc in file_cats {
        let vault_id = if let Some(eid) = by_name.get(&fc.name.to_lowercase()) {
            // Category with same name already exists — use its ID
            eid.clone()
        } else {
            // Create it using the file's ID so within-batch references stay consistent
            crate::storage::categories::upsert(vault, Some(fc.id.clone()), fc.name.clone())?.id
        };
        map.insert(fc.id.clone(), vault_id);
    }
    Ok(map)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_payload() -> BcnxPayload {
        BcnxPayload {
            version: 1,
            exported_at: 0,
            categories: vec![],
            sessions: vec![ExportSession {
                id: "test-id".into(),
                name: "Test".into(),
                host: "1.2.3.4".into(),
                port: 22,
                username: "root".into(),
                auth_kind: AuthKind::Password,
                key_path: None,
                secret_plain: Some("s3cr3t".into()),
                jump_session_id: None,
                color: "#fff".into(),
                read_only: false,
                use_sudo: false,
                category_id: None,
                use_ssm: false,
                ssm_instance_id: None,
                aws_region: None,
                aws_profile: None,
                aws_access_key_id: None,
                aws_secret_access_key: None,
            }],
        }
    }

    #[test]
    fn round_trip_correct_password() {
        let payload = make_payload();
        let bcnx = build_bcnx("hunter2", &payload).unwrap();
        let recovered = parse_bcnx(&bcnx, "hunter2").unwrap();
        assert_eq!(recovered.sessions[0].id, "test-id");
        assert_eq!(recovered.sessions[0].secret_plain.as_deref(), Some("s3cr3t"));
    }

    #[test]
    fn wrong_password_returns_bad_password() {
        let payload = make_payload();
        let bcnx = build_bcnx("correct", &payload).unwrap();
        let err = parse_bcnx(&bcnx, "wrong").unwrap_err();
        assert!(matches!(err, AppError::BadPassword));
    }
}
