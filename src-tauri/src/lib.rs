mod binlog_commands;
mod bootstrap;
mod commands;
mod mcp;
mod state;

use tauri::Manager;
#[cfg(target_os = "macos")]
use tauri::{
    menu::{Menu, MenuItem, Submenu},
    Emitter, EventTarget,
};

#[cfg(any(target_os = "macos", test))]
const EXECUTE_QUERY_MENU_ID: &str = "pipa.execute-query";
#[cfg(any(target_os = "macos", test))]
const EXECUTE_QUERY_EVENT: &str = "pipa://execute-query";
#[cfg(any(target_os = "macos", test))]
const EXECUTE_QUERY_ACCELERATOR: &str = "CmdOrCtrl+R";
/// Tauri's default macOS menu places View at index 3 and Window/Help after it.
#[cfg(any(target_os = "macos", test))]
const QUERY_MENU_INSERTION_INDEX_AFTER_VIEW: usize = 4;

/// Returns whether a native menu event requests execution of the current query.
///
/// # Parameters
/// `menu_id` is the stable identifier received from Tauri's native menu event.
///
/// # Returns
/// `true` only for the execute-current-query menu item.
///
/// # Side effects
/// None.
#[cfg(any(target_os = "macos", test))]
fn is_execute_query_menu(menu_id: &str) -> bool {
    menu_id == EXECUTE_QUERY_MENU_ID
}

/// Synchronizes the native macOS query-menu accelerator with the frontend preference.
///
/// # Parameters
/// `app` is the active Tauri application handle and `accelerator` uses Tauri menu syntax.
///
/// # Returns
/// Returns `Ok(())` after the menu item is updated, or a contextual error string.
///
/// # Side effects
/// Replaces the operating-system accelerator attached to the execute-query menu item on macOS.
#[tauri::command]
fn set_execute_query_accelerator(app: tauri::AppHandle, accelerator: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let menu = app
            .menu()
            .ok_or_else(|| "Pipa native application menu is unavailable".to_owned())?;
        let item = menu
            .get(EXECUTE_QUERY_MENU_ID)
            .and_then(|item| item.as_menuitem().cloned())
            .ok_or_else(|| "Pipa execute-query menu item is unavailable".to_owned())?;
        item.set_accelerator(Some(accelerator.trim()))
            .map_err(|error| format!("Pipa execute-query accelerator update failed: {error}"))?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, accelerator);
    Ok(())
}

/// Starts the Pipa desktop application and owns the Tauri runtime lifecycle.
///
/// # Parameters
/// None.
///
/// # Returns
/// Returns `()` after the Tauri event loop exits.
///
/// # Side effects
/// Creates the desktop runtime and blocks on its event loop; panics if startup fails.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(|app| {
            let menu = Menu::default(app)?;
            let execute_query = MenuItem::with_id(
                app,
                EXECUTE_QUERY_MENU_ID,
                "执行当前语句或选中内容",
                true,
                Some(EXECUTE_QUERY_ACCELERATOR),
            )?;
            let query_menu = Submenu::with_items(app, "查询", true, &[&execute_query])?;
            menu.insert(&query_menu, QUERY_MENU_INSERTION_INDEX_AFTER_VIEW)?;
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if !is_execute_query_menu(event.id().0.as_str()) {
                return;
            }
            let window = app
                .webview_windows()
                .into_values()
                .find(|window| window.is_focused().unwrap_or(false))
                .or_else(|| app.get_webview_window("main"));
            let Some(window) = window else {
                eprintln!("Pipa native execute shortcut could not find a focused workspace window");
                return;
            };
            if let Err(error) = window.emit_to(
                EventTarget::webview_window(window.label()),
                EXECUTE_QUERY_EVENT,
                (),
            ) {
                eprintln!("Pipa native execute shortcut emit failed: {error}");
            }
        });

    builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let app_state = state::AppState::initialize(&app_data_dir)?;
            let auto_start = {
                // Block briefly on the async mutex only for the enabled flag read.
                app_state
                    .mcp_server
                    .try_lock()
                    .map(|guard| guard.settings().enabled)
                    .unwrap_or(false)
            };
            if auto_start {
                let handle = app_state.mcp_server.clone();
                let deps = app_state.mcp_deps();
                let port = handle
                    .try_lock()
                    .map(|guard| guard.port())
                    .unwrap_or(mcp::DEFAULT_MCP_PORT);
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = mcp::start_mcp_server(handle, deps, port).await {
                        eprintln!("Pipa MCP auto-start failed on 127.0.0.1:{port}: {error:?}");
                    }
                });
            }
            let queue = app_state.mcp_queue.clone();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                queue.set_app_handle(app_handle).await;
            });
            app.manage(app_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_execute_query_accelerator,
            commands::write_text_file,
            commands::list_connections,
            commands::delete_connection,
            commands::rename_connection,
            commands::update_connection_profile,
            commands::reconnect_connection,
            commands::save_mysql_connection,
            commands::test_mysql_connection,
            commands::save_redis_connection,
            commands::test_redis_connection,
            commands::apply_table_mutations,
            commands::run_query,
            commands::cancel_query,
            commands::load_workspace,
            commands::save_workspace,
            commands::transfer_workspace_tab,
            commands::list_workspace_window_labels,
            commands::record_query_history,
            commands::load_sql_library,
            commands::save_sql_folder,
            commands::delete_sql_folder,
            commands::save_common_sql,
            commands::delete_common_sql,
            binlog_commands::binlog_start_import,
            binlog_commands::binlog_cancel_import,
            binlog_commands::binlog_get_summary,
            binlog_commands::binlog_list_transactions,
            binlog_commands::binlog_get_transaction,
            binlog_commands::binlog_get_reset_sql,
            binlog_commands::binlog_close_analysis,
            mcp::mcp_get_snapshot,
            mcp::mcp_start,
            mcp::mcp_stop,
            mcp::mcp_set_port,
            mcp::mcp_set_connection_scope,
            mcp::mcp_regenerate_token,
            mcp::mcp_execute_proposal,
            mcp::mcp_dismiss_proposal,
            mcp::mcp_run_manual_sql,
        ])
        .run(tauri::generate_context!())
        .expect("Pipa could not start because secure local storage is unavailable");
}

#[cfg(test)]
mod tests {
    use super::{
        is_execute_query_menu, EXECUTE_QUERY_ACCELERATOR, EXECUTE_QUERY_EVENT,
        EXECUTE_QUERY_MENU_ID, QUERY_MENU_INSERTION_INDEX_AFTER_VIEW,
    };

    /// Verifies the native query menu identifiers, accelerator, event, and position stay stable.
    #[test]
    fn native_execute_query_contract_is_stable() {
        assert_eq!(EXECUTE_QUERY_MENU_ID, "pipa.execute-query");
        assert_eq!(EXECUTE_QUERY_EVENT, "pipa://execute-query");
        assert_eq!(EXECUTE_QUERY_ACCELERATOR, "CmdOrCtrl+R");
        assert_eq!(QUERY_MENU_INSERTION_INDEX_AFTER_VIEW, 4);
        assert!(is_execute_query_menu(EXECUTE_QUERY_MENU_ID));
        assert!(!is_execute_query_menu("pipa.new-query"));
    }
}
