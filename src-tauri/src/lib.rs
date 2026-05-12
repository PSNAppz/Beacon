mod archive;
mod commands;
mod crypto;
mod error;
mod ssh;
mod storage;
mod transfer;

use std::sync::Arc;

use ssh::SessionManager;
use storage::VaultState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(VaultState::new())
        .manage(Arc::new(SessionManager::new()))
        .manage(Arc::new(archive::ArchiveState::new()))
        .invoke_handler(tauri::generate_handler![
            commands::vault_is_initialized,
            commands::vault_is_unlocked,
            commands::vault_create,
            commands::vault_unlock,
            commands::vault_lock,
            commands::list_sessions,
            commands::save_session,
            commands::delete_session,
            commands::test_session,
            commands::connect_session,
            commands::disconnect_session,
            commands::is_session_connected,
            commands::list_containers,
            commands::start_log_stream,
            commands::stop_log_stream,
            commands::run_remote_command,
            commands::poll_docker_stats,
            commands::archive_log_batch,
            commands::get_archived_logs,
            commands::save_log_export,
            commands::list_categories,
            commands::save_category,
            commands::delete_category,
            commands::snapshot_container_logs,
            commands::change_vault_password,
            commands::export_sessions,
            commands::preview_import,
            commands::import_sessions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
