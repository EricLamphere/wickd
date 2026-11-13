//! Where the bundled backend listens, and how the shell knows it's talking to it.
//!
//! The desktop app doesn't use the dev backend's port (8001), so the installed app and
//! `task start` can run side by side. It prefers one fixed port, because the page's
//! origin (and with it the webview's localStorage: sticky tabs, layout) depends on the
//! port. Only if that port is taken does it fall back to a free one for that launch.
//!
//! Each launch also gets a random instance token, passed to the backend and echoed by
//! `/api/health`. The shell opens the window only once the token matches, so it never
//! attaches to a stale backend from a previous launch or to an unrelated server.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::net::{Ipv4Addr, TcpListener};
use std::time::{SystemTime, UNIX_EPOCH};

/// The desktop app's backend port. Uncommon on purpose; never 8001 (dev).
pub const PREFERRED_PORT: u16 = 47823;

/// `preferred` if nothing is listening on it, else a free port picked by the OS.
pub fn choose_port(preferred: u16) -> u16 {
    if TcpListener::bind((Ipv4Addr::LOCALHOST, preferred)).is_ok() {
        return preferred;
    }
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .unwrap_or(preferred)
}

/// A random 32-hex-character token identifying this launch's backend. It isn't a
/// secret (anything on localhost can read /api/health); it only has to be unique.
pub fn new_instance_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let half = |salt: u64| {
        // RandomState is seeded from the OS's randomness.
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u128(nanos);
        hasher.write_u32(std::process::id());
        hasher.write_u64(salt);
        hasher.finish()
    };
    format!("{:016x}{:016x}", half(1), half(2))
}

/// True when a `/api/health` response body comes from the backend expecting
/// `token`, or from any wickd backend when there's no token (debug attach mode).
pub fn health_matches(body: &str, token: Option<&str>) -> bool {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    if json.get("status").and_then(|s| s.as_str()) != Some("ok") {
        return false;
    }
    match token {
        None => true,
        Some(expected) => json.get("instance").and_then(|i| i.as_str()) == Some(expected),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_preferred_port_when_free() {
        // Ask the OS for a free port, release it, then prefer it.
        let free = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert_eq!(choose_port(free), free);
    }

    #[test]
    fn falls_back_when_the_preferred_port_is_taken() {
        let taken = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = taken.local_addr().unwrap().port();
        let chosen = choose_port(port);
        assert_ne!(chosen, port);
        assert_ne!(chosen, 0);
    }

    #[test]
    fn tokens_are_32_hex_chars_and_unique() {
        let a = new_instance_token();
        let b = new_instance_token();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn health_must_echo_the_token() {
        let body = r#"{"status":"ok","instance":"abc"}"#;
        assert!(health_matches(body, Some("abc")));
        assert!(!health_matches(body, Some("xyz")));
        assert!(!health_matches(r#"{"status":"ok"}"#, Some("abc")));
    }

    #[test]
    fn attach_mode_accepts_any_wickd_backend() {
        assert!(health_matches(r#"{"status":"ok"}"#, None));
        assert!(!health_matches("<html>not wickd</html>", None));
        assert!(!health_matches(r#"{"status":"starting"}"#, None));
    }
}
