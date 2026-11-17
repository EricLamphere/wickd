/// Our own commands (src/updater.rs). Declaring them generates `allow-<command>`
/// permissions that capabilities/default.json grants. The window loads the UI from
/// the backend at http://127.0.0.1:<port>, which Tauri treats as a remote origin: it
/// rejects any app command from there that no capability grants, so a command
/// missing from this list silently fails in the desktop app.
const APP_COMMANDS: &[&str] = &["updater_enabled", "relaunch_app"];

fn main() {
    // Read with option_env! in src/updater.rs: rebuild when the flag changes, or a
    // cached build would keep the previous value.
    println!("cargo:rerun-if-env-changed=WICKD_UPDATER");
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
