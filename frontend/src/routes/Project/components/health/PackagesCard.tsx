import { ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { CheckSummary } from '../../../../lib/api';
import { TONE_DOT, TONE_TEXT, toneFor } from './healthStatus';
import { FOCUS_PACKAGES_STATE } from '../../Packages/useFocusPackages';

/** Health overview card for dbt packages vs the installed dbt-core; opens the project home's Packages tab.
 *  Shown only when the project has packages. Computed from local files, so there's nothing to run. */
export default function PackagesCard({ projectId, check }: { projectId: number; check: CheckSummary }) {
  const navigate = useNavigate();
  const tone = toneFor(check.status);
  return (
    <div className="flex flex-col bg-surface-panel border border-gray-800 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => navigate(`/projects/${projectId}/environment?tab=packages`, { state: FOCUS_PACKAGES_STATE })}
        className="group flex-1 flex flex-col gap-2 px-4 pt-4 pb-3 text-left hover:bg-surface-elevated/30 transition-colors"
      >
        <span className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full shrink-0 ${TONE_DOT[tone]}`} />
          <span className="flex-1 text-sm font-semibold text-gray-100">Packages</span>
          <ChevronRight className="w-3.5 h-3.5 text-gray-600 group-hover:text-gray-300 transition-colors" />
        </span>
        <span className={`text-xs ${TONE_TEXT[tone]}`}>{check.headline}</span>
        <span className="text-[11px] text-gray-600 leading-relaxed">
          Installed dbt packages and whether their require-dbt-version accepts your dbt-core
        </span>
      </button>
      <div className="flex items-center px-4 py-2.5 border-t border-gray-800">
        <span className="text-[10px] text-gray-600 truncate">Updates when packages.yml or dbt deps changes</span>
      </div>
    </div>
  );
}
