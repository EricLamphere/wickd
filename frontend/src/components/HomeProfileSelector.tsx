import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { alertError } from '../lib/dialogs';
import { workspaceApi } from '../lib/workspaceApi';

const KEY = ['workspace-profile'] as const;

/** Home page header: the global profile combined docs generation runs with. */
export function HomeProfileSelector() {
  const qc = useQueryClient();

  const { data: profiles = [] } = useQuery({
    queryKey: ['global-profiles'],
    queryFn: () => api.globalProfiles.list(),
  });
  const { data: selected } = useQuery({ queryKey: KEY, queryFn: workspaceApi.profile });

  const mutation = useMutation({
    mutationFn: workspaceApi.setProfile,
    onError: alertError,
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });

  if (profiles.length === 0) return null;

  // A profile deleted since it was picked reads as none
  const selectedId = selected?.profile_id ?? null;
  const value = profiles.some((p) => p.id === selectedId) ? String(selectedId) : '';

  return (
    <div
      className="flex items-center gap-1.5"
      title="Used for init pipelines and docs when generating combined docs. Each project's env vars still apply on top, and projects keep their own profile everywhere else."
    >
      <span className="text-[10px] uppercase tracking-wider text-gray-600 font-medium">Profile</span>
      <select
        aria-label="Profile for combined docs"
        value={value}
        disabled={mutation.isPending}
        onChange={(e) => mutation.mutate(e.target.value === '' ? null : Number(e.target.value))}
        className="bg-surface-elevated border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:ring-1 focus:ring-brand-500 cursor-pointer"
      >
        <option value="">Each project&rsquo;s own</option>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
    </div>
  );
}
