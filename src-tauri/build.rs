/// Runs Tauri's build-time code generation for the desktop crate.
///
/// # Parameters
/// None.
///
/// # Returns
/// Returns `()` after code generation completes.
///
/// # Side effects
/// Generates Tauri build artifacts and environment directives for Cargo.
fn main() {
    tauri_build::build()
}
