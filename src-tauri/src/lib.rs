#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Starts the Pipa desktop application and owns the Tauri runtime lifecycle.
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
