/**
 * Update & restart (plan 32): warn if work would be interrupted, download and install
 * with progress, let the backend stop its background work, then relaunch.
 */
import { useCallback, useState } from 'react';
import { api } from '../api';
import { confirmDialog } from '../dialogs';
import { busyMessage } from './updatePolicy';
import { downloadAndInstall, relaunchApp, type AvailableUpdate } from './updater';

export type InstallPhase = 'idle' | 'downloading' | 'installing' | 'relaunching' | 'error';

export interface InstallState {
  phase: InstallPhase;
  percent: number | null;
  error: string | null;
}

const IDLE: InstallState = { phase: 'idle', percent: null, error: null };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True to go ahead: nothing is running, or the user accepted stopping it. */
async function confirmIfBusy(): Promise<boolean> {
  try {
    const busy = await api.app.busy();
    if (!busy.busy) return true;
    return confirmDialog(busyMessage(busy.activities), { confirmLabel: 'Update anyway', danger: true });
  } catch (err) {
    // The busy check is a courtesy; don't block an update on it.
    console.info('busy check failed', err);
    return true;
  }
}

async function prepareBackend(): Promise<void> {
  try {
    await api.app.shutdownPrep();
  } catch (err) {
    // The shell kills the backend on relaunch anyway.
    console.info('shutdown-prep failed', err);
  }
}

export function useUpdateInstall(update: AvailableUpdate | null) {
  const [state, setState] = useState<InstallState>(IDLE);

  const install = useCallback(async () => {
    if (!update || !await confirmIfBusy()) return;
    setState({ phase: 'downloading', percent: 0, error: null });
    try {
      await downloadAndInstall(update, (progress) => {
        setState({
          phase: progress.finished ? 'installing' : 'downloading',
          percent: progress.percent,
          error: null,
        });
      });
      setState({ phase: 'relaunching', percent: 100, error: null });
      await prepareBackend();
      await relaunchApp();
    } catch (err) {
      console.error('update install failed', err);
      setState({ phase: 'error', percent: null, error: message(err) });
    }
  }, [update]);

  const reset = useCallback(() => setState(IDLE), []);

  return { state, install, reset };
}
