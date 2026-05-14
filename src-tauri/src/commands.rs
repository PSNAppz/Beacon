use crate::archive::ArchiveState;
use crate::error::{AppError, AppResult};
use crate::ssh::{self, SessionManager, SshTestResult};
use crate::ssh::docker::{Container, ContainerStats, LogLine, RemoteCmdResult};
use crate::storage::{self, Category, S3ConfigInput, S3ConfigPublic, Session, SessionInput, Vault, VaultState};
use crate::transfer::{ImportPreview};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn vault_is_initialized() -> AppResult<bool> {
    Vault::is_initialized()
}

#[tauri::command]
pub fn vault_is_unlocked(state: State<'_, VaultState>) -> bool {
    state.inner.lock().is_some()
}

#[tauri::command]
pub fn vault_create(state: State<'_, VaultState>, password: String) -> AppResult<()> {
    let v = Vault::create(&password)?;
    *state.inner.lock() = Some(v);
    Ok(())
}

#[tauri::command]
pub fn vault_unlock(state: State<'_, VaultState>, password: String) -> AppResult<()> {
    let v = Vault::unlock(&password)?;
    *state.inner.lock() = Some(v);
    Ok(())
}

#[tauri::command]
pub fn vault_lock(state: State<'_, VaultState>) {
    *state.inner.lock() = None;
}

fn with_vault<R>(state: &State<'_, VaultState>, f: impl FnOnce(&Vault) -> AppResult<R>) -> AppResult<R> {
    let guard = state.inner.lock();
    let v = guard.as_ref().ok_or(AppError::Locked)?;
    f(v)
}

/// Take a cheap snapshot of the unlocked Vault so we can hold it across an
/// `.await` without keeping the VaultState mutex locked.
fn snapshot_vault(state: &State<'_, VaultState>) -> AppResult<Vault> {
    let guard = state.inner.lock();
    let v = guard.as_ref().ok_or(AppError::Locked)?;
    Ok(Vault { conn: v.conn.clone(), key: v.key.clone() })
}

#[tauri::command]
pub fn list_sessions(state: State<'_, VaultState>) -> AppResult<Vec<Session>> {
    with_vault(&state, |v| storage::sessions::list(v))
}

#[tauri::command]
pub fn save_session(state: State<'_, VaultState>, input: SessionInput) -> AppResult<Session> {
    with_vault(&state, |v| storage::sessions::upsert(v, input))
}

#[tauri::command]
pub fn delete_session(state: State<'_, VaultState>, id: String) -> AppResult<()> {
    with_vault(&state, |v| storage::sessions::delete(v, &id))
}

#[tauri::command]
pub async fn test_session(
    state: State<'_, VaultState>,
    id: String,
) -> AppResult<SshTestResult> {
    let vault = snapshot_vault(&state)?;
    ssh::test_session(&vault, &id).await
}

#[tauri::command]
pub async fn connect_session(
    state: State<'_, VaultState>,
    manager: State<'_, Arc<SessionManager>>,
    id: String,
) -> AppResult<()> {
    let vault = snapshot_vault(&state)?;
    manager.connect(&vault, &id).await
}

#[tauri::command]
pub async fn disconnect_session(
    manager: State<'_, Arc<SessionManager>>,
    id: String,
) -> AppResult<()> {
    manager.disconnect(&id).await
}

#[tauri::command]
pub fn is_session_connected(
    manager: State<'_, Arc<SessionManager>>,
    id: String,
) -> bool {
    manager.is_connected(&id)
}

#[tauri::command]
pub async fn list_containers(
    app: tauri::AppHandle,
    manager: State<'_, Arc<SessionManager>>,
    id: String,
) -> AppResult<Vec<Container>> {
    ssh::docker::list_containers(app, &manager, &id).await
}

#[tauri::command]
pub async fn start_log_stream(
    app: tauri::AppHandle,
    manager: State<'_, Arc<SessionManager>>,
    session_id: String,
    container_id: String,
    tail: Option<u32>,
) -> AppResult<String> {
    let mgr: Arc<SessionManager> = manager.inner().clone();
    ssh::docker::start_log_stream(app, mgr, session_id, container_id, tail.unwrap_or(500)).await
}

#[tauri::command]
pub async fn run_remote_command(
    manager: State<'_, Arc<SessionManager>>,
    id: String,
    command: String,
) -> AppResult<RemoteCmdResult> {
    ssh::docker::run_remote_command(&manager, &id, &command).await
}

#[tauri::command]
pub fn stop_log_stream(
    manager: State<'_, Arc<SessionManager>>,
    stream_id: String,
) -> AppResult<()> {
    manager.stop_stream(&stream_id);
    Ok(())
}

// ─── Docker stats ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn poll_docker_stats(
    manager: State<'_, Arc<SessionManager>>,
    session_id: String,
) -> AppResult<Vec<ContainerStats>> {
    ssh::docker::poll_docker_stats(&manager, &session_id).await
}

// ─── Archive ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn archive_log_batch(
    archive: State<'_, Arc<ArchiveState>>,
    session_id: String,
    container_id: String,
    lines: Vec<LogLine>,
) -> AppResult<()> {
    archive.with_conn(|conn| crate::archive::write_lines(conn, &session_id, &container_id, &lines))
}

#[tauri::command]
pub fn get_archived_logs(
    archive: State<'_, Arc<ArchiveState>>,
    session_id: String,
    container_id: String,
    limit: Option<i64>,
) -> AppResult<Vec<LogLine>> {
    archive.with_conn(|conn| {
        crate::archive::read_lines(conn, &session_id, &container_id, limit.unwrap_or(5_000))
    })
}

// ─── Export ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn save_log_export(path: String, content: String) -> AppResult<()> {
    std::fs::write(&path, content)?;
    Ok(())
}

// ─── Categories ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_categories(state: State<'_, VaultState>) -> AppResult<Vec<Category>> {
    with_vault(&state, |v| storage::categories::list(v))
}

#[tauri::command]
pub fn save_category(state: State<'_, VaultState>, id: Option<String>, name: String) -> AppResult<Category> {
    with_vault(&state, |v| storage::categories::upsert(v, id, name))
}

#[tauri::command]
pub fn delete_category(state: State<'_, VaultState>, id: String) -> AppResult<()> {
    with_vault(&state, |v| storage::categories::delete(v, &id))
}

// ─── Log snapshot ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn snapshot_container_logs(
    archive: State<'_, Arc<ArchiveState>>,
    session_id: String,
    container_id: String,
    path: String,
) -> AppResult<()> {
    let lines = archive.with_conn(|conn| {
        crate::archive::read_lines(conn, &session_id, &container_id, 50_000)
    })?;
    let content: String = lines
        .iter()
        .map(|l| format!("{} {}\n", l.ts.as_deref().unwrap_or(""), l.text))
        .collect();
    std::fs::write(&path, content).map_err(|e| AppError::Other(e.to_string()))
}

// ─── Profile export / import ──────────────────────────────────────────────────

#[tauri::command]
pub fn export_sessions(
    state: State<'_, VaultState>,
    ids: Vec<String>,
    password: String,
    path: String,
) -> AppResult<()> {
    with_vault(&state, |v| crate::transfer::export_sessions(v, &ids, &password, &path))
}

#[tauri::command]
pub fn preview_import(
    state: State<'_, VaultState>,
    path: String,
    password: String,
) -> AppResult<ImportPreview> {
    with_vault(&state, |v| crate::transfer::preview_import(v, &path, &password))
}

#[tauri::command]
pub fn import_sessions(
    state: State<'_, VaultState>,
    path: String,
    password: String,
    selected_ids: Vec<String>,
    conflict_strategy: String,
) -> AppResult<Vec<Session>> {
    with_vault(&state, |v| {
        crate::transfer::import_sessions(v, &path, &password, &selected_ids, &conflict_strategy)
    })
}

// ─── Vault password change ─────────────────────────────────────────────────────

#[tauri::command]
pub fn change_vault_password(
    state: State<'_, VaultState>,
    old_password: String,
    new_password: String,
) -> AppResult<()> {
    let mut guard = state.inner.lock();
    let v = guard.as_mut().ok_or(AppError::Locked)?;
    v.change_password(&old_password, &new_password)
}

// ─── Upgrade flows ────────────────────────────────────────────────────────────

/// Get the single upgrade flow configured for a session, or null if none.
#[tauri::command]
pub fn get_upgrade_flow(
    state: State<'_, VaultState>,
    session_id: String,
) -> AppResult<Option<storage::UpgradeFlow>> {
    with_vault(&state, |v| storage::upgrades::get_for_session(v, &session_id))
}

#[tauri::command]
pub fn save_upgrade_flow(
    state: State<'_, VaultState>,
    input: storage::UpgradeFlowInput,
) -> AppResult<storage::UpgradeFlow> {
    with_vault(&state, |v| storage::upgrades::upsert(v, input))
}

/// Delete the upgrade flow for a session.
#[tauri::command]
pub fn delete_upgrade_flow(
    state: State<'_, VaultState>,
    session_id: String,
) -> AppResult<()> {
    with_vault(&state, |v| storage::upgrades::delete(v, &session_id))
}

/// Trigger an upgrade flow run. Steps are passed directly so the user's
/// pre-flight edits are used without being persisted back to the DB.
#[tauri::command]
pub async fn run_upgrade_flow(
    app: tauri::AppHandle,
    manager: State<'_, Arc<SessionManager>>,
    session_id: String,
    steps: Vec<String>,
    run_id: String,
) -> AppResult<()> {
    let mgr = manager.inner().clone();
    ssh::docker::run_upgrade_flow(app, mgr, session_id, steps, run_id).await
}

/// Send a line of text to the stdin of the currently-running upgrade step.
#[tauri::command]
pub fn send_upgrade_input(
    manager: State<'_, Arc<SessionManager>>,
    run_id: String,
    text: String,
) -> AppResult<()> {
    manager.send_upgrade_input(&run_id, &text)
}

// ─── S3 log backup ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_s3_config(state: State<'_, VaultState>) -> AppResult<Option<S3ConfigPublic>> {
    with_vault(&state, |v| storage::s3_config::get_public(v))
}

#[tauri::command]
pub fn save_s3_config(
    state: State<'_, VaultState>,
    input: S3ConfigInput,
) -> AppResult<S3ConfigPublic> {
    with_vault(&state, |v| storage::s3_config::upsert(v, input))
}

#[tauri::command]
pub fn delete_s3_config(state: State<'_, VaultState>) -> AppResult<()> {
    with_vault(&state, |v| storage::s3_config::delete(v))
}

/// Fetch all logs from a container via SSH and upload them to S3.
/// The S3 key is returned so the frontend can display it.
#[tauri::command]
pub async fn upload_container_logs_to_s3(
    app: tauri::AppHandle,
    manager: State<'_, Arc<SessionManager>>,
    state: State<'_, VaultState>,
    session_id: String,
    container_id: String,
    container_name: String,
) -> AppResult<String> {
    let vault = snapshot_vault(&state)?;

    let s3_cfg = storage::s3_config::get(&vault)?
        .ok_or_else(|| AppError::Other("S3 is not configured".into()))?;

    let session = storage::sessions::get(&vault, &session_id)?;

    let mgr = manager.inner().clone();
    let logs = ssh::docker::fetch_container_logs(&mgr, &session_id, &container_id).await?;

    let key = crate::s3::upload_logs(app, &s3_cfg, &session.name, &container_name, logs).await?;
    Ok(key)
}

