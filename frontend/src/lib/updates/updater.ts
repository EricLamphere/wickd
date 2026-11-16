/**
 * Thin wrapper over Tauri's updater plugin (plan 32). Everything is a no-op outside the
 * official desktop app: in a browser (`task start`), a debug shell or a self-built app,
 * `updaterSupported()` is false and nothing here touches the plugin.
 */
import { invoke, isTauri } from '@tauri-apps/api/core';
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater';
import { downloadPercent } from './updatePolicy';

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  notes: string;
  date: string | null;
  /** The plugin's handle, used to download and install this version. */
  handle: Update;
}

export interface DownloadProgress {
  downloaded: number;
  /** null while the size is unknown. */
  percent: number | null;
  finished: boolean;
}

/** True only in a release build of the desktop app compiled with the updater
 * (the shell's `updater_enabled` command). Never throws. */
export async function updaterSupported(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await invoke<boolean>('updater_enabled');
  } catch {
    return false;
  }
}

/** The newer version on the update server, or null. Throws when the server can't be reached. */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  const update = await check();
  if (!update) return null;
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    notes: update.body ?? '',
    date: update.date ?? null,
    handle: update,
  };
}

/** Downloads the update, checks its signature and replaces the app bundle. */
export async function downloadAndInstall(
  update: AvailableUpdate,
  onProgress: (progress: DownloadProgress) => void,
): Promise<void> {
  let total: number | undefined;
  let downloaded = 0;
  await update.handle.downloadAndInstall((event: DownloadEvent) => {
    if (event.event === 'Started') total = event.data.contentLength;
    if (event.event === 'Progress') downloaded += event.data.chunkLength;
    onProgress({
      downloaded,
      percent: event.event === 'Finished' ? 100 : downloadPercent(downloaded, total),
      finished: event.event === 'Finished',
    });
  });
}

/** Stops the backend and restarts the app (the shell's `relaunch_app`). */
export async function relaunchApp(): Promise<void> {
  await invoke('relaunch_app');
}
