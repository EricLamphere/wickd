# Update wickd

The wickd desktop app checks for a new version on launch, and every 6 hours while it's open. When there is one, it offers to update itself. Your projects, settings, license, dbt install and AI models are kept: they live in wickd's data folder, outside the app.

Running wickd from source (`task start`)? Nothing here applies. Update with `git pull`.

## When a new version is out

A bar appears under the header on every page:

> wickd 1.4.0 is available (you have 1.3.5) · What's new · **Update & restart** · Later · Skip this version

- **What's new** opens the release notes.
- **Update & restart** downloads the update (with a progress bar), checks its signature, replaces wickd in your Applications folder, and restarts on the new version. If something is running, such as a dbt build, an init pipeline, global setup, or a scheduled run due in the next few minutes, wickd tells you what will be stopped and asks first.
- **Later** hides the bar until you next open wickd.
- **Skip this version** hides the bar for that version for good. You're told again when a newer version comes out.

## Settings

In **Global Settings → Settings → Updates**:

- **Version** shows the version you're running. **Check now** checks right away, even with automatic checks off.
- **WICKD_UPDATE_CHECK_ENABLED** turns the automatic checks on or off.
- **WICKD_UPDATE_SKIPPED_VERSION** shows the version you skipped. **Stop skipping** brings its update bar back.

## If an update can't install

wickd can only replace itself when it's in `/Applications` and you can write there. It can't if you opened it straight from the downloaded `.dmg`, or if your Mac is managed and you aren't an admin. When an install fails, the bar says so and links to the latest download from the website. Install that by hand, the same way as the first time. **Details** shows the error.

If you're offline, or GitHub can't be reached, the automatic check fails silently and tries again later. **Check now** says "Couldn't reach the update server."

## Builds that don't update

Only the official app from the website updates itself. Apps you build yourself (`task package:app`) never offer an update. Rebuild them instead. Versions before automatic updates arrived must install the first version that has them by hand. Every version after that updates itself.

## For maintainers: trying an update without releasing

1. Build version N with the endpoint pointed at your machine:
   `task package:production UPDATER_ENDPOINT=http://127.0.0.1:8765/latest.json`.
   The address is compiled into that build, so never release it.
2. Copy `/Applications/wickd.app` somewhere safe, then bump the version (e.g. with the files listed in the `release` skill), and build N+1 the same way.
3. In a folder, put N+1's `src-tauri/target/release/bundle/macos/wickd.app.tar.gz`, renamed `wickd_<N+1>_aarch64.app.tar.gz`, and a manifest edited to point at it:
   `backend/.venv/bin/python backend/scripts/updater_manifest.py --version <N+1> --sig src-tauri/target/release/bundle/macos/wickd.app.tar.gz.sig --out latest.json`.
   Change the manifest's `url` to `http://127.0.0.1:8765/wickd_<N+1>_aarch64.app.tar.gz`, then serve the folder with `python3 -m http.server 8765`.
4. Put version N back in `/Applications`, open it, and click **Update & restart**. Check that it relaunches on N+1 with your projects and data intact, and that Pro is still active.
