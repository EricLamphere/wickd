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

/// The real capability and app manifest, through Tauri's IPC access check. The window
/// loads the UI from http://127.0.0.1:<port>, a remote origin to Tauri; 1.4.0 and 1.4.1
/// shipped without a capability for it, so `updater_enabled` was rejected and the app
/// said "from source" and never offered an update.
#[cfg(test)]
mod ipc_access_tests {
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    use tauri::webview::InvokeRequest;

    fn invoke_from(origin: &str) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![super::updater_enabled, super::relaunch_app])
            .build(tauri::generate_context!("tauri.conf.json", test = true))
            .expect("failed to build the mock app");
        // Labelled like the real window: the capability applies to "main" only.
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("failed to build the main window");
        get_ipc_response(
            &window,
            InvokeRequest {
                cmd: "updater_enabled".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: origin.parse().unwrap(),
                body: tauri::ipc::InvokeBody::default(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
    }

    #[test]
    fn the_backend_origin_can_call_our_commands() {
        let result = invoke_from("http://127.0.0.1:51234/");
        assert!(result.is_ok(), "rejected from the backend's origin: {result:?}");
    }

    #[test]
    fn other_origins_still_cannot() {
        assert!(invoke_from("https://example.com/").is_err());
        assert!(invoke_from("http://localhost:51234/").is_err());
    }
}
