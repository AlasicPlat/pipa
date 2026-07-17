mod commands;
mod state;

use tauri::Manager;

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
    tauri::Builder::default()
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
        ])
        .run(tauri::generate_context!())
        .expect("Pipa could not start because secure local storage is unavailable");
}
