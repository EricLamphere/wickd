fn main() {
    // Read with option_env! in src/updater.rs: rebuild when the flag changes, or a
    // cached build would keep the previous value.
    println!("cargo:rerun-if-env-changed=WICKD_UPDATER");
    tauri_build::build()
}
