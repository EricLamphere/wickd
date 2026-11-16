/**
 * Desktop update state (plan 32): whether updates are supported, the available update,
 * and the user's Later / Skip choices.
 *
 * The check runs on launch, then every CHECK_INTERVAL_MS. That's a timer on an external
 * resource (GitHub's latest.json), not polling our own server's state, so the "never poll,
 * use SSE" rule (which is about backend data) doesn't apply here.
 */
import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { CHECK_INTERVAL_MS, shouldNotify } from './updatePolicy';
import { checkForUpdate, updaterSupported, type AvailableUpdate } from './updater';

export const UPDATE_QUERY_KEY = ['app-update'] as const;
const LATER_KEY = 'wickd-update-later';

async function checkLogged(): Promise<AvailableUpdate | null> {
  try {
    return await checkForUpdate();
  } catch (err) {
    // Offline, GitHub down or rate limited: the automatic check fails quietly.
    console.info('update check failed', err);
    throw err;
  }
}

function readLater(): string | null {
  try {
    return sessionStorage.getItem(LATER_KEY);
  } catch {
    return null;
  }
}

function writeLater(version: string): void {
  try {
    sessionStorage.setItem(LATER_KEY, version);
  } catch {
    // Storage blocked: Later still applies until the page reloads.
  }
}

/** True only in the official desktop app (release build with the updater compiled in). */
export function useUpdaterSupported(): boolean {
  const { data } = useQuery({
    queryKey: ['app-update-supported'],
    queryFn: updaterSupported,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data ?? false;
}

export function useAppSettings() {
  return useQuery({ queryKey: ['app-settings'], queryFn: () => api.settings.get() });
}

/** The available update and whether the update bar should show it. */
export function useAppUpdate() {
  const qc = useQueryClient();
  const supported = useUpdaterSupported();
  const { data: settings } = useAppSettings();
  const enabled = settings?.update_check_enabled ?? false;
  const [laterVersion, setLaterVersion] = useState<string | null>(readLater);

  const query = useQuery({
    queryKey: UPDATE_QUERY_KEY,
    queryFn: checkLogged,
    enabled: supported && enabled,
    staleTime: CHECK_INTERVAL_MS,
    refetchInterval: CHECK_INTERVAL_MS,
    refetchOnWindowFocus: false,
    retry: false,
    // The plugin's Update handle is a class instance; keep it as is.
    structuralSharing: false,
  });

  const update = query.data ?? null;
  const visible = supported && update !== null && shouldNotify({
    available: update.version,
    current: update.currentVersion,
    skipped: settings?.update_skipped_version ?? null,
    laterVersion,
    // Automatic checks only run when enabled; an update found by "Check now" shows either way.
    enabled: true,
  });

  const later = useCallback(() => {
    if (!update) return;
    writeLater(update.version);
    setLaterVersion(update.version);
  }, [update]);

  const skip = useCallback(async () => {
    if (!update) return;
    await api.settings.update({ update_skipped_version: update.version });
    await qc.invalidateQueries({ queryKey: ['app-settings'] });
  }, [qc, update]);

  return { supported, update, visible, later, skip };
}

/** "Check now" in Global Settings: checks even when automatic checks are off. */
export function useCheckNow() {
  const qc = useQueryClient();
  return useCallback(
    () => qc.fetchQuery({ queryKey: UPDATE_QUERY_KEY, queryFn: checkForUpdate, staleTime: 0 }),
    [qc],
  );
}
