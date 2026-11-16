/**
 * Global Settings → Updates (plan 32): the running version with "Check now", the
 * automatic-check switch and the skipped version.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type SettingsDto } from '../../lib/api';
import { alertError } from '../../lib/dialogs';
import { compareVersions } from '../../lib/updates/updatePolicy';
import { useCheckNow, useUpdaterSupported } from '../../lib/updates/useAppUpdate';

const ROW = 'flex items-center gap-2 px-3 py-2 bg-surface-elevated rounded border border-gray-800 text-xs';
const LINK_BUTTON = 'px-2 py-0.5 rounded bg-surface-panel hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors disabled:opacity-40';

function Label({ name, hint }: { name: string; hint: string }) {
  return (
    <div className="w-60 shrink-0">
      <span className="font-mono text-brand-300 truncate block">{name}</span>
      <span className="text-gray-600 italic">{hint}</span>
    </div>
  );
}

type CheckResult =
  | { kind: 'idle' | 'checking' | 'current' | 'error' }
  | { kind: 'available'; version: string; skipped: boolean };

function checkText(result: CheckResult): string | null {
  switch (result.kind) {
    case 'checking': return 'Checking…';
    case 'current': return "You're on the latest version.";
    case 'error': return "Couldn't reach the update server.";
    case 'available': return result.skipped
      ? `wickd ${result.version} is available, but you skipped it. Stop skipping it below to install it.`
      : `wickd ${result.version} is available. See the bar at the top of the window.`;
    default: return null;
  }
}

function VersionRow({ supported, skipped }: { supported: boolean; skipped: string | null }) {
  const { data: info } = useQuery({ queryKey: ['app-info'], queryFn: () => api.app.info(), staleTime: Infinity });
  const checkNow = useCheckNow();
  const [result, setResult] = useState<CheckResult>({ kind: 'idle' });

  const onCheck = async () => {
    setResult({ kind: 'checking' });
    try {
      const update = await checkNow();
      const newer = update && compareVersions(update.version, update.currentVersion) > 0;
      setResult(newer
        ? { kind: 'available', version: update.version, skipped: skipped !== null && compareVersions(update.version, skipped) === 0 }
        : { kind: 'current' });
    } catch {
      setResult({ kind: 'error' });
    }
  };

  const text = checkText(result);
  return (
    <div className={ROW}>
      <Label name="Version" hint={supported ? 'the wickd you are running' : 'from source: update with git pull'} />
      <span className="text-gray-600">=</span>
      <span className="font-mono text-gray-300">{info?.version || '—'}</span>
      {supported && (
        <button onClick={onCheck} disabled={result.kind === 'checking'} className={`${LINK_BUTTON} ml-2`}>
          Check now
        </button>
      )}
      {text && <span className={result.kind === 'error' ? 'text-red-400' : 'text-gray-500'}>{text}</span>}
    </div>
  );
}

function AutoCheckRow({ settings }: { settings: SettingsDto }) {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const on = settings.update_check_enabled;

  const toggle = async () => {
    setSaving(true);
    try {
      await api.settings.update({ update_check_enabled: !on });
      await qc.invalidateQueries({ queryKey: ['app-settings'] });
    } catch (err) {
      alertError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={ROW}>
      <Label name="WICKD_UPDATE_CHECK_ENABLED" hint="check for a new version on launch and every 6 hours" />
      <span className="text-gray-600">=</span>
      <button
        role="switch"
        aria-checked={on}
        onClick={toggle}
        disabled={saving}
        className={`relative w-8 h-4 rounded-full transition-colors disabled:opacity-40 ${on ? 'bg-brand-600' : 'bg-gray-700'}`}
      >
        <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
      </button>
      <span className="text-gray-400">{on ? 'On' : 'Off'}</span>
    </div>
  );
}

function SkippedRow({ settings }: { settings: SettingsDto }) {
  const qc = useQueryClient();
  const skipped = settings.update_skipped_version;

  const clear = async () => {
    try {
      await api.settings.update({ update_skipped_version: '' });
      await qc.invalidateQueries({ queryKey: ['app-settings'] });
    } catch (err) {
      alertError(err);
    }
  };

  return (
    <div className={ROW}>
      <Label name="WICKD_UPDATE_SKIPPED_VERSION" hint="set by Skip this version in the update bar" />
      <span className="text-gray-600">=</span>
      {skipped ? (
        <>
          <span className="font-mono text-gray-300">{skipped}</span>
          <button onClick={clear} className={`${LINK_BUTTON} ml-2`}>Stop skipping</button>
        </>
      ) : (
        <span className="text-gray-600 italic">e.g. 1.4.0</span>
      )}
    </div>
  );
}

export function UpdateSettingsRows({ settings }: { settings: SettingsDto }) {
  const supported = useUpdaterSupported();
  return (
    <>
      <VersionRow supported={supported} skipped={settings.update_skipped_version} />
      {supported && <AutoCheckRow settings={settings} />}
      {supported && <SkippedRow settings={settings} />}
    </>
  );
}
