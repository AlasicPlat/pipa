// Prevents an additional console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Starts the Pipa desktop process through the reusable library entry point.
fn main() {
    pipa_app_lib::run()
}
