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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
