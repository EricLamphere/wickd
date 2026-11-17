import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { packagesApi } from '../lib/packagesApi';

const STALE_MS = 60_000;

/** Before switching dbt-core: installed packages (in any project) whose require-dbt-version rejects `dbtVersion`. */
export function PackagesCompatWarning({ dbtVersion, className = '' }: { dbtVersion: string | null | undefined; className?: string }) {
  const { data } = useQuery({
    queryKey: ['packages-compat', dbtVersion],
    queryFn: () => packagesApi.compat(dbtVersion!),
    enabled: !!dbtVersion && /^\d+\.\d+/.test(dbtVersion),
    staleTime: STALE_MS,
    retry: false,
  });
  if (!dbtVersion || !data || data.projects.length === 0) return null;
  return (
    <div className={`flex items-start gap-2 text-[11px] text-amber-400 ${className}`}>
      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
      <div className="flex flex-col gap-0.5">
        <span>Some installed packages don't support dbt {dbtVersion}:</span>
        {data.projects.map((p) => (
          <span key={p.project_id} className="text-amber-500">
            <span className="text-amber-300">{p.name}</span>: {p.incompatible.map((i) => `${i.name}${i.installed ? ` ${i.installed}` : ''}`).join(', ')}
          </span>
        ))}
      </div>
    </div>
  );
}
