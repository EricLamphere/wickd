import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { api } from '../../../lib/api';
import { GLOBAL_ENV_QUERY_KEY } from '../../../components/GlobalEnvVarsSection';
import { GlobalSettingsModal } from '../../../components/GlobalSettingsModal';

/** Environment page: the global env vars every project inherits. Edited in Global Settings → Profiles. */
export function GlobalEnvVarsReadOnly() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { data: envVars = [], isLoading } = useQuery({
    queryKey: GLOBAL_ENV_QUERY_KEY,
    queryFn: () => api.globalEnv.list(),
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Global Environment Variables</h3>
        <button
          onClick={() => setSettingsOpen(true)}
          className="text-xs text-brand-400 hover:text-brand-300 transition-colors"
        >
          Edit in Global Settings
        </button>
      </div>
      <p className="text-xs text-gray-500 mb-3">Defaults shared by every project. The active profile and project variables override these.</p>
      <div className="flex flex-col gap-1.5">
        {isLoading && <p className="text-xs text-gray-600">Loading…</p>}
        {!isLoading && envVars.length === 0 && (
          <p className="text-xs text-gray-600 italic">No global environment variables.</p>
        )}
        {envVars.map((v) => (
          <div
            key={v.key}
            className="flex items-center gap-2 px-3 py-2 bg-surface-panel rounded border border-gray-800 text-xs opacity-70"
            title="Edit in Global Settings → Profiles"
          >
            <Lock className="w-3 h-3 text-gray-600 shrink-0" />
            <span className="font-mono text-brand-300 w-40 shrink-0 truncate">{v.key}</span>
            <span className="text-gray-600">=</span>
            <span className="flex-1 font-mono text-gray-300 truncate">
              {v.value || <span className="text-gray-600 italic">empty</span>}
            </span>
          </div>
        ))}
      </div>
      {settingsOpen && <GlobalSettingsModal onClose={() => setSettingsOpen(false)} initialTab="profiles" />}
    </div>
  );
}
