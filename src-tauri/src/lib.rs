mod archive;
mod commands;
mod crypto;
mod error;
mod s3;
mod secretstore;
mod ssh;
mod storage;
mod terminal;
mod transfer;

use std::sync::Arc;

use ssh::SessionManager;
use storage::VaultState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    builder
        .manage(VaultState::new())
        .manage(Arc::new(SessionManager::new()))
        .manage(Arc::new(archive::ArchiveState::new()))
        .invoke_handler(tauri::generate_handler![
            commands::vault_is_initialized,
            commands::vault_is_unlocked,
            commands::vault_create,
            commands::vault_unlock,
            commands::vault_lock,
            commands::vault_has_remembered_password,
            commands::vault_remember_password,
            commands::vault_forget_password,
            commands::vault_unlock_remembered,
            commands::open_external_terminal,
            commands::fix_key_permissions,
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
            commands::get_upgrade_flow,
            commands::save_upgrade_flow,
            commands::delete_upgrade_flow,
            commands::run_upgrade_flow,
            commands::send_upgrade_input,
            commands::get_s3_config,
            commands::save_s3_config,
            commands::delete_s3_config,
            commands::upload_container_logs_to_s3,
        ])
        .on_window_event(|window, event| {
            // Closing the window ends every remote session — nothing stays
            // connected in the background after the app is gone.
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                use tauri::Manager;
                if let Some(mgr) = window.try_state::<Arc<SessionManager>>() {
                    let mgr: Arc<SessionManager> = mgr.inner().clone();
                    // Bounded so a wedged connection can't block app exit.
                    let _ = tauri::async_runtime::block_on(tokio::time::timeout(
                        std::time::Duration::from_secs(3),
                        async move { mgr.disconnect_all().await },
                    ));
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
