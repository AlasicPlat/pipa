// Prevents an additional console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Starts the Pipa desktop process through the reusable library entry point.
///
/// # Parameters
/// None.
///
/// # Returns
/// Returns `()` after the desktop runtime exits.
///
/// # Side effects
/// Delegates to `pipa_app_lib::run`, which starts and blocks on the Tauri event loop.
fn main() {
    pipa_app_lib::run()
}
