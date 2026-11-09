import { useQuery } from '@tanstack/react-query';
import { api, isProFeatureRequiredError, type RunOpts } from '../../../../lib/api';
import { slimApi, type StatePreviewDto } from '../../../../lib/slimApi';
import { apiErrorMessage, buildOpts, commandLine } from '../../../../lib/slimBuild';
import type { BuildOptions } from './BuildConfig';
import { countRows, rowsFromPreview, type NodeRow, type RowCounts } from './buildRows';

export interface ShownBuild {
  /** --select of what the Impact view shows ('' = nothing buildable) */
  selector: string;
  rows: NodeRow[];
  tests: number;
}

export interface BuildPlan {
  loading: boolean;
  error: string | null;
  /** the dbt command Build runs (null until known) */
  command: string | null;
  rows: NodeRow[];
  counts: RowCounts;
  /** what Build sends; null = nothing to build yet */
  request: { select: string; opts: RunOpts } | null;
  preview: StatePreviewDto | null;
  previewedAt: number;
  refresh: (() => void) | null;
}

/** Everything the build dialog shows and runs for the chosen options, from either source. */
export function useBuildPlan(
  projectId: number, options: BuildOptions, shown: ShownBuild, scope: 'working' | 'branch', base: string | null,
): BuildPlan {
  const prod = options.source === 'prod';
  const { method, downstream, prune, defer } = options;
  const { data: targetData } = useQuery({ queryKey: ['dbt-target', projectId], queryFn: () => api.profiles.getDbtTarget(projectId) });
  const target = targetData?.target ?? null;

  const preview = useQuery({
    queryKey: ['state-preview', projectId, { method, downstream, prune, scope, base }],
    queryFn: () => slimApi.preview(projectId, { method, downstream, prune, scope, base }),
    enabled: prod,
    retry: false,
    // kept until files / git / the manifest change (useStatePreviewCache) or Refresh
    staleTime: Infinity,
    gcTime: 60 * 60 * 1000,
  });
  // the shown build only needs the state folder for --defer-state
  const state = useQuery({
    queryKey: ['state-preview', projectId, 'state'],
    queryFn: () => slimApi.state(projectId),
    enabled: !prod && defer !== 'off',
    retry: false,
    staleTime: Infinity,
  });

  if (prod) {
    const data = preview.data ?? null;
    const rows = data ? rowsFromPreview(data) : [];
    const error = preview.error
      ? isProFeatureRequiredError(preview.error)
        ? 'Only what actually changed (smallest safe set) is a wickd Pro feature. Untick it to preview the full selection.'
        : apiErrorMessage(preview.error, 'Preview failed')
      : null;
    return {
      loading: preview.isFetching, error, rows, counts: countRows(rows, data?.tests ?? 0), preview: data,
      previewedAt: preview.dataUpdatedAt, refresh: () => { preview.refetch(); },
      command: data ? commandLine({
        select: data.select, statePath: data.needs_state ? data.state.state_path : null,
        deferPath: data.state.defer_path, defer, target,
      }) : null,
      request: data?.select ? { select: data.select, opts: buildOpts(data.needs_state, defer) } : null,
    };
  }

  const deferError = defer !== 'off' && state.error ? apiErrorMessage(state.error, "Couldn't resolve STATE_SOURCE for defer") : null;
  return {
    loading: defer !== 'off' && state.isFetching, error: deferError, rows: shown.rows,
    counts: countRows(shown.rows, shown.tests), preview: null, previewedAt: 0, refresh: null,
    command: commandLine({ select: shown.selector, deferPath: state.data?.defer_path ?? '<production manifest>', defer, target }),
    request: shown.selector && !deferError ? { select: shown.selector, opts: buildOpts(false, defer) } : null,
  };
}
