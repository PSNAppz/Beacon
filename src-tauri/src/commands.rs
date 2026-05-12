use crate::error::{AppError, AppResult};
use crate::ssh::{self, SessionManager, SshTestResult};
use crate::ssh::docker::{Container, RemoteCmdResult};
use crate::storage::{self, Session, SessionInput, Vault, VaultState};
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
