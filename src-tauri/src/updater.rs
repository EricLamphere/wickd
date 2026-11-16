//! Automatic updates (plan 32).
//!
//! The updater plugin is only registered in official release builds:
//! `task package:production` compiles with `WICKD_UPDATER=1` (and signs the
//! updater artifacts). Debug shells, attach mode (the screenshots skill) and
//! contributor builds (`task package:app`, no signing key) never offer an
//! update, so a self-built app can't "update" itself into the official build.
//!
//! The frontend asks `updater_enabled` before calling the plugin, and restarts
//! through `relaunch_app` rather than `@tauri-apps/plugin-process`: Tauri's
//! `restart()` on the main thread skips `RunEvent::Exit`, which is where the
//! backend is killed, so the old backend would outlive the relaunch.

use tauri::{AppHandle, Manager, Runtime};

/// True for a release build compiled with `WICKD_UPDATER=1`.
pub fn flag_enabled(debug_build: bool, flag: Option<&str>) -> bool {
    !debug_build && flag == Some("1")
}

pub fn enabled() -> bool {
    flag_enabled(cfg!(debug_assertions), option_env!("WICKD_UPDATER"))
}

#[tauri::command]
pub fn updater_enabled() -> bool {
    enabled()
}

/// Stops the backend, then restarts the app (on the newly installed version
/// after `downloadAndInstall`).
#[tauri::command]
pub fn relaunch_app<R: Runtime>(app: AppHandle<R>) {
    if let Some(child) = app.state::<crate::BackendProcess>().0.lock().unwrap().take() {
        crate::kill_backend_tree(child);
    }
    app.request_restart();
}

#[cfg(test)]
mod tests {
    use super::flag_enabled;

    #[test]
    fn only_release_builds_with_the_flag() {
        assert!(flag_enabled(false, Some("1")));
        assert!(!flag_enabled(true, Some("1")));
        assert!(!flag_enabled(false, None));
        assert!(!flag_enabled(false, Some("0")));
    }
}
