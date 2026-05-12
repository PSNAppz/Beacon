use crate::error::{AppError, AppResult};
use crate::storage::db::{now_unix, Vault};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Category {
    pub id: String,
    pub name: String,
    pub created_at: i64,
}

pub fn list(vault: &Vault) -> AppResult<Vec<Category>> {
    let conn = vault.conn.lock();
    let mut stmt = conn.prepare(
        "SELECT id, name, created_at FROM categories ORDER BY name ASC",
    )?;
    let mut out = Vec::new();
    let rows = stmt.query_map([], |r| {
        Ok(Category { id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)? })
    })?;
    for r in rows { out.push(r?); }
    Ok(out)
}

pub fn upsert(vault: &Vault, id: Option<String>, name: String) -> AppResult<Category> {
    let id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = now_unix();
    {
        let conn = vault.conn.lock();
        conn.execute(
            "INSERT INTO categories (id, name, created_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name",
            params![id, name, now],
        )?;
    }
    let conn = vault.conn.lock();
    let cat = conn
        .query_row(
            "SELECT id, name, created_at FROM categories WHERE id = ?1",
            params![id],
            |r| Ok(Category { id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)? }),
        )
        .map_err(|_| AppError::NotFound)?;
    Ok(cat)
}

pub fn delete(vault: &Vault, id: &str) -> AppResult<()> {
    let conn = vault.conn.lock();
    conn.execute("DELETE FROM categories WHERE id = ?1", params![id])?;
    Ok(())
}
