mod bootstrap;
mod commands;
mod legacy_keyring;
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
            let Some(window) = app.get_webview_window("main") else {
                eprintln!("Pipa native execute shortcut could not find the main window");
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
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            app.manage(state::AppState::initialize(&app_data_dir)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_connections,
            commands::save_mysql_connection,
            commands::test_mysql_connection,
            commands::run_query,
            commands::cancel_query,
            commands::load_workspace,
            commands::save_workspace,
            commands::record_query_history,
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
