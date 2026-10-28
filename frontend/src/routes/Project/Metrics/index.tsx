// Metrics page (/projects/:id/metrics): pick metrics, group-bys, grain, filters and dates;
// see MetricFlow's SQL live, Run it on the warehouse, chart / table the result.
// The whole query lives in the URL (lib/metricQuery.ts), so back/forward steps through queries.
import { useCallback, useEffect, useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { alertDialog, alertError, promptDialog } from '../../../lib/dialogs';
import { semanticApi, semanticErrorBody, type CatalogSavedQuery, type SemanticCatalogDto } from '../../../lib/semanticApi';
import { useSemanticStatus } from '../components/semantic/useSemantic';
import NavRail from '../components/NavRail';
import { useOpenInFiles } from '../lib/openInFiles';
import { MetricsSidebar } from './MetricsSidebar';
import { MetricsUnavailable } from './MetricsUnavailable';
import { QueryBar } from './QueryBar';
import { ResultsPane } from './ResultsPane';
import {
  allowedGrains, groupByColumn, groupByOptions, stateFromParams, stateFromSavedQuery, toRequest, writeState, type ExplorerState,
} from './lib/metricQuery';
import { writeWorkspaceSql } from './lib/openInWorkspace';
import { useActiveTarget, useExplain, useMetricResult, useSemanticCatalog } from './useMetricExplorer';

function errorText(err: unknown): string | null {
  if (!err) return null;
  return semanticErrorBody(err)?.message ?? (err instanceof Error ? err.message : String(err));
}

function labelsFor(catalog: SemanticCatalogDto | undefined): Map<string, string> {
  const labels = new Map<string, string>();
  for (const m of catalog?.metrics ?? []) if (m.label) labels.set(m.name, m.label);
  for (const q of catalog?.saved_queries ?? []) labels.set(`saved:${q.name}`, q.label || q.name);
  return labels;
}

export default function MetricsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const id = Number(projectId);
  return (
    <div className="flex h-full overflow-hidden">
      <NavRail projectId={id} current="metrics" />
      <div className="flex-1 min-w-0 overflow-hidden"><MetricsContent id={id} /></div>
    </div>
  );
}

function MetricsContent({ id }: { id: number }) {
  const { data: status, isLoading, error } = useSemanticStatus(id);
  const ready = !!status?.available && status.can_query;
  const catalogQuery = useSemanticCatalog(id, ready);

  if (isLoading) return <p className="p-6 text-xs text-gray-500">Loading…</p>;
  if (error || !status) return <p className="p-6 text-xs text-red-400">Couldn't load the semantic layer status: {errorText(error)}</p>;
  if (status.counts.metrics === 0) {
    return <p className="p-6 text-xs text-gray-500">This project has no metrics yet. Define some in YAML and they'll show up here after dbt parses.</p>;
  }
  if (!ready) return <MetricsUnavailable projectId={id} status={status} />;
  if (catalogQuery.isLoading) return <p className="p-6 text-xs text-gray-500">Loading metrics…</p>;
  if (!catalogQuery.data) return <p className="p-6 text-xs text-red-400">Couldn't load the metrics: {errorText(catalogQuery.error)}</p>;
  return <Explorer projectId={id} catalog={catalogQuery.data} />;
}

function Explorer({ projectId, catalog }: { projectId: number; catalog: SemanticCatalogDto }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => stateFromParams(params), [params]);
  const saved = state.savedQuery ? catalog.saved_queries.find((q) => q.name === state.savedQuery) ?? null : null;
  // A saved query runs by name; its definition drives the options and the chart shape
  const effective = saved ? stateFromSavedQuery(saved) : state;
  const options = useMemo(() => groupByOptions(catalog, effective.metrics), [catalog, effective.metrics]);
  const grain = allowedGrains(options, effective.groupBy).includes(effective.grain) ? effective.grain : allowedGrains(options, effective.groupBy)[0];
  const body = useMemo(() => toRequest({ ...state, grain }, options), [state, grain, options]);

  const explain = useExplain(projectId, body);
  const result = useMetricResult(projectId, body);
  const { data: target } = useActiveTarget(projectId);
  const labels = useMemo(() => labelsFor(catalog), [catalog]);
  const { data: graph } = useQuery({ queryKey: ['graph', projectId], queryFn: () => api.models.graph(projectId) });
  const { open } = useOpenInFiles(projectId);

  const update = useCallback((patch: Partial<ExplorerState>) => {
    setParams((prev) => writeState(prev, { ...stateFromParams(prev), ...patch }));
  }, [setParams]);

  const shape = useMemo(() => {
    const time = effective.groupBy.find((g) => options.find((o) => o.name === g)?.kind === 'time');
    return {
      metrics: effective.metrics,
      timeColumn: time ? groupByColumn(time, options, grain) : null,
      dimensionColumns: effective.groupBy.filter((g) => g !== time && options.some((o) => o.name === g)),
      labels: Object.fromEntries(labels),
    };
  }, [effective.metrics, effective.groupBy, options, grain, labels]);

  const run = result.run;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && body && !explain.error) { e.preventDefault(); run(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [run, body, explain.error]);

  const metricUid = useMemo(() => {
    const uids = new Map<string, string>();
    for (const n of graph?.nodes ?? []) if (n.resource_type === 'metric' && n.original_file_path) uids.set(n.name, n.unique_id);
    return uids;
  }, [graph]);

  const runSaved = (q: CatalogSavedQuery) => {
    update({ savedQuery: q.name });
    run({ saved_query: q.name });
  };

  const save = async () => {
    if (!body || state.savedQuery) return;
    const name = await promptDialog('Name for the saved query (lowercase, digits, underscores):',
      state.metrics.join('_by_').slice(0, 60), { title: 'Save as saved query', confirmLabel: 'Save' });
    if (!name) return;
    try {
      const { path } = await semanticApi.saveQuery(projectId, { ...body, name: name.trim() });
      await alertDialog(`Added \`${name.trim()}\` to ${path}. It shows up under Saved queries once dbt re-parses.`, { title: 'Saved query added' });
    } catch (err) {
      await alertDialog(errorText(err) ?? 'Saving failed', { title: "Couldn't save the query" });
    }
  };

  const openInWorkspace = async (sql: string) => {
    try {
      await writeWorkspaceSql(projectId, state.savedQuery ?? state.metrics.join('_'), sql);
      navigate(`/projects/${projectId}/workspace`);
    } catch (err) {
      await alertError(err);
    }
  };

  const fine = grain === 'day' || grain === 'hour';
  return (
    <div className="flex h-full min-h-0">
      <MetricsSidebar
        catalog={catalog}
        selected={state.savedQuery ? [] : state.metrics}
        savedQuery={state.savedQuery}
        onToggleMetric={(m) => update({ savedQuery: null, metrics: state.metrics.includes(m) ? state.metrics.filter((x) => x !== m) : [...state.metrics, m] })}
        onRunSaved={runSaved}
        onEditSaved={(q) => setParams((prev) => writeState(prev, stateFromSavedQuery(q)))}
        onOpenYaml={(m) => { const uid = metricUid.get(m); if (uid) open(uid); }}
      />
      <main className="flex flex-col flex-1 min-w-0 min-h-0">
        <QueryBar
          state={{ ...state, grain }}
          options={options}
          labels={labels}
          onChange={update}
          target={target?.target ?? null}
          running={result.running}
          canRun={!!body && !explain.error}
          onRun={() => run()}
          onCancel={result.cancel}
          onSave={body && !state.savedQuery ? save : null}
        />
        <ResultsPane
          result={result.result}
          loadingResult={result.loading}
          sql={explain.data?.sql ?? null}
          sqlError={errorText(explain.error)}
          runError={errorText(result.runError)}
          running={result.running}
          definitionsChanged={result.definitionsChanged}
          shape={shape}
          grain={grain}
          truncatedHint={fine && shape.timeColumn ? 'Try a coarser grain (week or month) or add a filter.' : 'Add a filter or a limit to narrow it.'}
          onRun={() => run()}
          onOpenInWorkspace={openInWorkspace}
        />
      </main>
    </div>
  );
}
