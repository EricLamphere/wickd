import { useState } from 'react';
import type { DbtCoreStatusDto } from '../lib/api';
import { dbtCoreDrift } from '../lib/dbtCoreDrift';
import { GlobalSetupModal } from './GlobalSetupModal';

/** Home page warning when the installed dbt-core has drifted from the chosen one;
 *  Reinstall runs global setup, which installs the requirements file or the pinned version. */
export function DbtCoreDriftBanner({ status }: { status: DbtCoreStatusDto | undefined }) {
  const [reinstalling, setReinstalling] = useState(false);
  const drift = dbtCoreDrift(status);
  if (!drift && !reinstalling) return null;
  return (
    <>
      {drift && (
        <div className="flex items-center gap-4 px-4 py-3 bg-amber-950/40 border border-amber-800/60 rounded-lg">
          <div className="flex flex-col flex-1 gap-0.5">
            <p className="text-sm font-medium text-amber-300">{drift.title}</p>
            <p className="text-xs text-amber-500">{drift.detail}</p>
          </div>
          <button
            onClick={() => setReinstalling(true)}
            className="shrink-0 px-3 py-1.5 text-xs rounded bg-amber-700 hover:bg-amber-600 text-white font-medium transition-colors"
          >
            Reinstall dbt-core
          </button>
        </div>
      )}
      {reinstalling && <GlobalSetupModal onClose={() => setReinstalling(false)} />}
    </>
  );
}
