import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type RequirementsFileDto } from '../../lib/api';
import { InlineCode } from './fields';
import type { DbtCorePlan } from './dbtCorePlan';

const FILE_CHECK_DEBOUNCE_MS = 300;

/** The requirements file check for a typed path, debounced; null while there's no answer for it yet. */
export function useRequirementsFile(path: string): RequirementsFileDto | null {
  const trimmed = path.trim();
  const [debounced, setDebounced] = useState(trimmed);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(trimmed), FILE_CHECK_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [trimmed]);
  const { data } = useQuery({
    queryKey: ['setup-requirements-file', debounced],
    queryFn: () => api.setup.requirementsFile(debounced),
    enabled: !!debounced,
  });
  return debounced === trimmed ? data ?? null : null;
}

interface PickerProps {
  /** null = not chosen yet: becomes the newest release once the list loads */
  value: string | null;
  onChange: (version: string) => void;
  plan: DbtCorePlan;
  error: string | null;
}

function spec(version: string): string {
  return version ? `dbt-core==${version}` : 'dbt-core';
}

function PlanNote({ plan, version }: { plan: DbtCorePlan; version: string }) {
  if (plan.kind === 'no-file') return <>Run global setup installs this version. Change it later in Global Settings.</>;
  if (plan.kind === 'new-file') return <>The new file starts with <InlineCode>{spec(version)}</InlineCode>.</>;
  if (plan.kind === 'append') {
    return <>Your file doesn't list dbt-core yet, so <InlineCode>{spec(version)}</InlineCode> is added to the end of it.</>;
  }
  return null;
}

/** Choose the dbt-core release to install (from PyPI), or type one if PyPI can't be reached. */
export function DbtCoreVersionPicker({ value, onChange, plan, error }: PickerProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['dbt-core-versions'],
    queryFn: () => api.setup.dbtCoreVersions(),
    staleTime: Infinity,
    retry: 1,
  });

  useEffect(() => {
    if (value === null && data) onChange(data.latest);
  }, [value, data, onChange]);

  const version = value ?? '';
  const control = 'px-3 py-2 bg-surface-elevated border rounded font-mono text-sm text-gray-100 focus:outline-none focus:ring-1';
  const border = error ? 'border-red-600 focus:ring-red-500' : 'border-gray-700 focus:ring-brand-500';

  return (
    <div className="flex flex-col gap-1.5 mt-5">
      <span className="text-xs font-medium text-gray-300">dbt-core version</span>
      {isError ? (
        <input
          value={version}
          onChange={(e) => onChange(e.target.value.trim())}
          placeholder="e.g. 1.10.13 — leave blank for the latest"
          spellCheck={false}
          className={`${control} ${border} placeholder-gray-600`}
        />
      ) : (
        <select
          value={version}
          onChange={(e) => onChange(e.target.value)}
          disabled={isLoading}
          className={`${control} ${border} disabled:opacity-60`}
        >
          {isLoading && <option value={version}>Loading versions…</option>}
          {data?.versions.map((v) => (
            <option key={v} value={v}>{v === data.latest ? `${v} (latest)` : v}</option>
          ))}
          {data && <option value="">Always the newest release (unpinned)</option>}
        </select>
      )}
      {error && <span className="text-xs text-red-400">{error}</span>}
      {!error && (
        <span className="text-xs text-gray-500">
          {isError && "Couldn't load the release list from PyPI. "}
          <PlanNote plan={plan} version={version} />
        </span>
      )}
    </div>
  );
}
