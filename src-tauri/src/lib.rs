use std::process::Child;
use std::time::Duration;

use tauri::{Manager, RunEvent};

const BACKEND_URL: &str = "http://127.0.0.1:8001";
const BACKEND_HEALTH_PATH: &str = "/api/health";
const BACKEND_POLL_TIMEOUT: Duration = Duration::from_secs(20);
const BACKEND_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Holds the backend process's child handle for the lifetime of the app so it
/// can be killed explicitly on shutdown — nothing else guarantees its cleanup
/// on every exit path (e.g. force-quit) without this.
struct BackendProcess(std::sync::Mutex<Option<Child>>);

/// Kills the backend process and any of its direct children.
///
/// The PyInstaller-bundled backend forks a `multiprocessing.resource_tracker`
/// helper process (spawned the first time anything touches `multiprocessing`, e.g.
/// via `ProcessPoolExecutor` import machinery). That helper is deliberately designed
/// to survive a plain kill of its parent so it can clean up shared resources, which
/// left it (and the port 8001 listener) orphaned when we only killed the tracked PID.
/// `pkill -P <pid>` reaps any such children before/alongside killing the parent.
fn kill_backend_tree(mut child: Child) {
    let pid = child.id();
    let _ = std::process::Command::new("pkill")
        .args(["-9", "-P", &pid.to_string()])
        .status();
    let _ = child.kill();
}

/// Debug builds only: open this already-running backend instead of spawning the
/// bundled one, so the real shell can show a working tree next to the dev
/// servers (see .claude/skills/screenshots). Compiled out of release builds.
#[cfg(debug_assertions)]
fn attach_url() -> Option<String> {
    std::env::var("WICKD_SHELL_URL").ok().filter(|url| !url.is_empty())
}

#[cfg(not(debug_assertions))]
fn attach_url() -> Option<String> {
    None
}

/// Parses `WICKD_SHELL_SIZE`-style `1920x1145` into logical width and height.
#[cfg(debug_assertions)]
fn parse_window_size(value: &str) -> Option<(f64, f64)> {
    let (width, height) = value.split_once('x')?;
    Some((width.parse().ok()?, height.parse().ok()?))
}

#[cfg(debug_assertions)]
fn apply_requested_size(window: &tauri::WebviewWindow) {
    let Ok(value) = std::env::var("WICKD_SHELL_SIZE") else {
        return;
    };
    match parse_window_size(&value) {
        Some((width, height)) => {
            let _ = window.set_size(tauri::LogicalSize::new(width, height));
        }
        None => eprintln!("ignoring WICKD_SHELL_SIZE={value}: expected WIDTHxHEIGHT"),
    }
}

/// `WICKD_SHELL_ZOOM`, e.g. `0.8`: lays the app out as a larger window would, for
/// layouts taller than the screen (macOS caps a window's height at the display's).
#[cfg(debug_assertions)]
fn apply_requested_zoom(window: &tauri::WebviewWindow) {
    let Ok(value) = std::env::var("WICKD_SHELL_ZOOM") else {
        return;
    };
    match value.parse::<f64>() {
        Ok(zoom) if zoom > 0.0 => {
            let _ = window.set_zoom(zoom);
        }
        _ => eprintln!("ignoring WICKD_SHELL_ZOOM={value}: expected a positive number"),
    }
}

/// Shows the main window once `base_url`'s backend answers.
fn show_when_ready(window: tauri::WebviewWindow, base_url: String) {
    std::thread::spawn(move || {
        let health_url = format!("{base_url}{BACKEND_HEALTH_PATH}");
        let started = std::time::Instant::now();
        loop {
            if reqwest::blocking::get(&health_url)
                .map(|r| r.status().is_success())
                .unwrap_or(false)
            {
                break;
            }
            if started.elapsed() > BACKEND_POLL_TIMEOUT {
                break;
            }
            std::thread::sleep(BACKEND_POLL_INTERVAL);
        }
        let url = base_url.parse().expect("valid backend url");
        let _ = window.navigate(url);
        let _ = window.show();
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(BackendProcess(std::sync::Mutex::new(None)))
        .setup(|app| {
            if let Some(url) = attach_url() {
                let window = app
                    .get_webview_window("main")
                    .expect("main window not found");
                #[cfg(debug_assertions)]
                {
                    apply_requested_size(&window);
                    apply_requested_zoom(&window);
                }
                show_when_ready(window, url);
                return Ok(());
            }

            let resource_dir = app
                .path()
                .resource_dir()
                .expect("failed to resolve resource dir");
            let frontend_dist = resource_dir.join("binaries").join("frontend_dist");

            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");

            // Spawned directly from the onedir resource folder rather than as a
            // Tauri sidecar/externalBin: PyInstaller onefile mode re-extracts the
            // whole interpreter into a fresh temp dir (and macOS Gatekeeper
            // re-validates that "new" unsigned binary) on every single launch,
            // adding ~7s to startup. onedir's executable lives at a fixed path on
            // disk across launches, so extraction and the Gatekeeper check each
            // only happen once, ever.
            let backend_exe = resource_dir
                .join("binaries")
                .join("wickd-backend")
                .join("wickd-backend");

            let child = std::process::Command::new(&backend_exe)
                .env("WICKD_FRONTEND_DIST", frontend_dist.to_string_lossy().to_string())
                .env("WICKD_DATA_DIR", data_dir.to_string_lossy().to_string())
                .spawn()
                .expect("failed to spawn wickd-backend");

            app.state::<BackendProcess>()
                .0
                .lock()
                .unwrap()
                .replace(child);

            let window = app
                .get_webview_window("main")
                .expect("main window not found");

            // The window is created with url = http://127.0.0.1:8001 and starts
            // loading it immediately — almost always before the sidecar backend
            // has bound the port, since the sidecar was just spawned above. That
            // initial load fails (connection refused) and WKWebView does not
            // auto-retry, so simply calling window.show() later reveals an
            // already-failed blank page. Poll the backend, then explicitly
            // navigate once it's actually up, and only show the window after that
            // navigation has been issued.
            show_when_ready(window, BACKEND_URL.to_string());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                if let Some(child) = app_handle.state::<BackendProcess>().0.lock().unwrap().take() {
                    kill_backend_tree(child);
                }
            }
        });
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::parse_window_size;

    #[test]
    fn parses_width_and_height() {
        assert_eq!(parse_window_size("1920x1145"), Some((1920.0, 1145.0)));
    }

    #[test]
    fn rejects_anything_else() {
        assert_eq!(parse_window_size("1920"), None);
        assert_eq!(parse_window_size("widexhigh"), None);
    }
}
