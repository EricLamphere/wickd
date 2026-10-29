// One dashboard as a whiteboard (plan 12): Metrics rail | canvas | Widgets rail, with the
// period bar on top. Always editable: every change is saved to the file a moment later and
// can be undone (⌘Z / ⇧⌘Z). Changed widgets that have no stored result run on their own;
// Refresh runs everything in one batch. Present hides the rails.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DndContext, DragOverlay, defaultDropAnimationSideEffects, type DropAnimation } from '@dnd-kit/core';
import { dashboardsApi, type DashboardDoc, type DashboardWidget, type WidgetType } from '../../../../../lib/dashboardsApi';
import { alertDialog, confirmDialog, promptDialog } from '../../../../../lib/dialogs';
import type { SemanticCatalogDto } from '../../../../../lib/semanticApi';
import { relativeTime } from '../../../lib/relativeTime';
import { statusesByMetric } from '../../monitors/monitorView';
import { useMonitors } from '../../monitors/useMonitors';
import { useOpenInFiles } from '../../../lib/openInFiles';
import type { ExplorerState } from '../../lib/metricQuery';
import {
  addMetric, canvasWidthOf, duplicateWidget, widthToPx, explorerStateFromBody, querySignature, insertWidget, metricsInUse, newWidget, removeWidget,
  replaceWidget, widgetFromQuery, widgetTitle, withDashboardFilter,
} from '../dashboardModel';
import { ExportDashboardModal } from '../ExportDashboardModal';
import { errorText, useDashboard, useDashboardResults } from '../useDashboards';
import { BuilderHeader } from './BuilderHeader';
import { Canvas } from './Canvas';
import { MetricsRail, type RailItem } from './MetricsRail';
import { PeriodBar } from './PeriodBar';
import { useBuilderDnd } from './useBuilderDnd';
import { useDashboardEditor } from './useDashboardEditor';
import { WidgetsRail, type RailTab } from './WidgetsRail';
import { WidgetFrame } from '../widgets/WidgetFrame';
import { aiApi, type AiProposalDto } from '../../../../../lib/aiApi';
import { ProposalReviewModal } from '../../../components/Wicky/ProposalReviewModal';
import { pickFilters, type Pick } from '../drill';

/** The dragged copy glides into the widget's new spot on drop. */
const DROP_ANIMATION: DropAnimation = {
  duration: 180,
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0.25' } } }),
};
import { METRICS_RAIL, useRailWidth, WIDGETS_RAIL } from './RailResize';

interface Props {
  projectId: number;
  slug: string;
  catalog: SemanticCatalogDto;
  labels: Map<string, string>;
  target: string | null;
  onBack: () => void;
  onOpenExplorer: (state: ExplorerState) => void;
}

const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

/** Widgets whose saved definition changed (all of them when the dashboard's period, grain or filters did). */
function changedWidgets(before: DashboardDoc, after: DashboardDoc): string[] {
  const shared = (d: DashboardDoc) => JSON.stringify([d.period, d.grain, d.filters]);
  if (shared(before) !== shared(after)) return after.widgets.map((w) => w.id);
  const old = new Map(before.widgets.map((w) => [w.id, JSON.stringify({ ...w, width: 0, height: 0, title: '' })]));
  return after.widgets.filter((w) => old.get(w.id) !== JSON.stringify({ ...w, width: 0, height: 0, title: '' })).map((w) => w.id);
}

export function DashboardBuilder({ projectId, slug, catalog, labels, target, onBack, onOpenExplorer }: Props) {
  const detail = useDashboard(projectId, slug);
  // The saved dashboard when a results request starts (the editor exists further down)
  const savedDocRef = useRef<() => DashboardDoc | null>(() => null);
  const detailDoc = detail.data?.dashboard ?? null;
  const snapshot = useCallback(() => savedDocRef.current() ?? detailDoc, [detailDoc]);
  const { results, refresh } = useDashboardResults(projectId, slug, !!detailDoc, snapshot);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<RailTab>('widgets');
  const [present, setPresent] = useState(false);
  const [running, setRunning] = useState<Set<string> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  // Register as exposure: the proposal under review (nothing is written until it's accepted)
  const [review, setReview] = useState<AiProposalDto | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const leftRail = useRailWidth(METRICS_RAIL);
  const rightRail = useRailWidth(WIDGETS_RAIL);
  const { data: monitorData } = useMonitors(projectId);
  const { canOpen, open: openInFiles } = useOpenInFiles(projectId);
  const monitors = useMemo(() => monitorData?.monitors ?? [], [monitorData]);
  const monitorStatuses = useMemo(() => statusesByMetric(monitors), [monitors]);

  const run = useCallback(async (ids?: string[]) => {
    setRunning(new Set(ids ?? []));
    try {
      await refresh.mutateAsync(ids);
    } catch (err) {
      setNotice(errorText(err) ?? 'Refresh failed');
    } finally {
      setRunning(null);
    }
  }, [refresh]);

  // After a save: run the changed widgets that have no stored result for their new queries
  const onSaved = useCallback(async (before: DashboardDoc, after: DashboardDoc) => {
    const changed = new Set(changedWidgets(before, after));
    if (!changed.size) return;
    const fresh = await results.refetch();
    const toRun = (fresh.data?.widgets ?? []).filter((w) => changed.has(w.widget_id) && w.status === 'not_run').map((w) => w.widget_id);
    if (toRun.length) run(toRun);
  }, [results, run]);

  const editor = useDashboardEditor(projectId, slug, detail.data, onSaved);
  savedDocRef.current = editor.savedDoc;
  const { doc, apply } = editor;
  const select = useCallback((widget: DashboardWidget) => { setSelected(widget.id); setTab('configure'); }, []);
  const dnd = useBuilderDnd({ doc, catalog, labels, apply, onCreated: select, onNotice: setNotice });

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (present) setPresent(false); else setSelected(null); return; }
      if (typing(e.target) || present) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) editor.redo(); else editor.undo(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { e.preventDefault(); apply((d) => removeWidget(d, selected)); setSelected(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor, apply, present, selected]);

  const byId = useMemo(() => new Map((results.data?.widgets ?? []).map((r) => [r.widget_id, r])), [results.data]);

  if (detail.isLoading) return <p className="p-6 text-xs text-gray-500">Loading…</p>;
  if (!detail.data) return <p className="p-6 text-xs text-red-400">Couldn't load the dashboard: {errorText(detail.error)}</p>;
  if (!doc) {
    return (
      <div className="flex flex-col gap-2 p-6">
        <button onClick={onBack} className="self-start text-xs text-gray-500 hover:text-gray-200">← Dashboards</button>
        <p className="text-xs text-red-400">{detail.data.path} isn't a valid dashboard: {detail.data.error}</p>
        <p className="text-[11px] text-gray-500">Fix the file in Files (or your editor); it reloads when it's saved.</p>
      </div>
    );
  }

  const selectedWidget = doc.widgets.find((w) => w.id === selected) ?? null;
  const draggedWidget = dnd.active?.kind === 'widget' ? doc.widgets.find((w) => w.id === (dnd.active as { id: string }).id) ?? null : null;
  const ids = doc.widgets.map((w) => w.id);
  const hasMetrics = metricsInUse(doc).size > 0;
  const asOf = (results.data?.widgets ?? []).map((w) => w.ran_at).filter((t): t is string => !!t).sort()[0];

  const addFromRail = (item: RailItem) => {
    if (item.kind === 'saved') { const w = widgetFromQuery({ saved_query: item.name }, catalog, ids); apply((d) => insertWidget(d, w)); select(w); return; }
    if (selectedWidget) {
      const result = addMetric(selectedWidget, item.name, catalog);
      if (result.widget) { apply((d) => replaceWidget(d, result.widget)); return; }
      setNotice(`${result.error} — added a new widget instead`);
    }
    const w = newWidget('summary', ids, [item.name], catalog);
    apply((d) => insertWidget(d, w));
    select(w);
  };
  const addType = (type: WidgetType) => { const w = newWidget(type, ids, [], catalog); apply((d) => insertWidget(d, w)); select(w); };
  const rename = async () => {
    const title = await promptDialog('Dashboard title:', doc.title, { title: 'Rename dashboard', confirmLabel: 'Rename' });
    if (title?.trim() && title.trim() !== doc.title) apply((d) => ({ ...d, title: title.trim() }));
  };
  const registerExposure = async () => {
    const owner = await promptDialog('Owner of the exposure (shown in dbt docs). wickd drafts a `type: dashboard` exposure that depends on every metric on this dashboard, for you to review.',
      '', { title: 'Register as exposure', confirmLabel: 'Review' });
    if (!owner?.trim()) return;
    try {
      setReview(await dashboardsApi.proposeExposure(projectId, slug, owner.trim()));
    } catch (err) {
      await alertDialog(errorText(err) ?? 'Registering failed', { title: "Couldn't register the exposure" });
    }
  };
  const updateExposure = async () => {
    try {
      const proposal = await dashboardsApi.proposeExposureUpdate(projectId, slug);
      if (proposal.status === 'ready') setReview(proposal); else setNotice(proposal.error_message ?? 'The exposure is already up to date');
    } catch (err) {
      await alertDialog(errorText(err) ?? 'Updating failed', { title: "Couldn't update the exposure" });
    }
  };
  const deleteExposure = async () => {
    try {
      setReview(await dashboardsApi.proposeExposureDelete(projectId, slug));
    } catch (err) {
      await alertDialog(errorText(err) ?? 'Deleting failed', { title: "Couldn't delete the exposure" });
    }
  };
  const closeReview = async () => {
    const shown = review;
    setReview(null);
    if (!shown) return;
    const latest = await aiApi.proposal(projectId, shown.id).catch(() => shown);
    const summary = latest.result.summary as { name?: string; path?: string; update?: boolean; delete?: boolean; file_deleted?: boolean } | undefined;
    if (latest.status === 'applied' && summary?.delete) {
      setNotice(`Deleted the exposure ${summary.name ?? ''}${summary.file_deleted ? ` and ${summary.path ?? 'its file'}` : ` from ${summary.path ?? 'your YAML'}`}, and unlinked the dashboard`);
    } else if (latest.status === 'applied' && summary?.update) {
      setNotice(`Updated the exposure ${summary.name ?? ''} in ${summary.path ?? 'your YAML'}`);
    } else if (latest.status === 'applied') {
      setNotice(`Registered as the exposure ${summary?.name ?? ''} in ${summary?.path ?? 'your YAML'}; it shows in the DAG, Impact and Docs after dbt re-parses`);
    }
  };
  const remove = async () => {
    if (!await confirmDialog(`Delete ${detail.data.path}? The file is removed from the project.`, { confirmLabel: 'Delete', danger: true })) return;
    try { await dashboardsApi.remove(projectId, slug); onBack(); } catch (err) { setNotice(errorText(err) ?? 'Deleting failed'); }
  };

  const frameProps = (widget: DashboardWidget) => {
    const result = byId.get(widget.id);
    const status = (widget.metrics ?? []).map((m) => monitorStatuses.get(m)).find((s) => s?.status && s.status !== 'ok') ?? null;
    const ranQuery = result ? Object.values(result.queries)[0]?.query : undefined;
    const applyFilter = (pick: Pick) => {
      apply((d) => pickFilters(pick).reduce(withDashboardFilter, d));
      setNotice(`Filtered the dashboard to ${pick.values.map((v) => `${v.dimension} = ${v.value}`).join(', ')}`);
    };
    const openFiltered = (pick: Pick) => {
      const base = result?.queries.current?.query ?? ranQuery;
      if (base) onOpenExplorer(explorerStateFromBody({ ...base, where: [...(base.where ?? []), ...pickFilters(pick)] }, catalog));
    };
    return {
      projectId, widget, result, labels, title: widgetTitle(widget, labels), selected: selected === widget.id, present,
      loading: results.isLoading, refreshing: !!running && (running.size === 0 || running.has(widget.id)), monitors,
      // results computed for other settings: show "Updating…" rather than old data under the new settings
      updating: !!result && results.data?.signatures[widget.id] !== undefined && results.data.signatures[widget.id] !== querySignature(doc, widget),
      monitorStatus: status, filtered: !!ranQuery?.where?.length, dropHint: dnd.hintFor(widget),
      onSelect: () => select(widget), onRun: () => run([widget.id]), onApplyFilter: applyFilter, onOpenFiltered: openFiltered,
      onOpenInExplorer: () => { if (ranQuery) onOpenExplorer(explorerStateFromBody(ranQuery, catalog)); },
      onDuplicate: () => apply((d) => duplicateWidget(d, widget.id)),
      onRemove: () => { apply((d) => removeWidget(d, widget.id)); if (selected === widget.id) setSelected(null); },
      onResize: (size: { width: number; height: number }) => apply((d) => replaceWidget(d, { ...widget, ...size })),
    };
  };

  return (
    <DndContext {...dnd.dndProps}>
      <div className="flex flex-col h-full min-h-0">
        <div className="flex flex-col gap-2 px-4 py-2.5 border-b border-gray-800 bg-surface-panel shrink-0">
          <BuilderHeader title={doc.title} path={detail.data.path} exposure={doc.exposure ?? null} save={editor.state} present={present}
            exposureStatus={doc.exposure === detail.data.exposure ? detail.data.exposure_status : 'unknown'}
            exposurePath={detail.data.exposure_path}
            exposureDrift={detail.data.exposure_drift}
            onUpdateExposure={updateExposure}
            onDeleteExposure={deleteExposure}
            canOpenExposure={!!detail.data.exposure_unique_id && canOpen(detail.data.exposure_unique_id)}
            onOpenExposure={() => { if (detail.data?.exposure_unique_id) openInFiles(detail.data.exposure_unique_id); }}
            onUnlinkExposure={() => {
              apply((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'exposure')) as DashboardDoc);
              setNotice(detail.data?.exposure_status === 'found'
                ? `Unlinked. The exposure is still in ${detail.data.exposure_path ?? 'your YAML'}; delete it there if you don't need it.`
                : 'Unlinked the exposure from this dashboard.');
            }}
            canUndo={editor.canUndo} canRedo={editor.canRedo} running={!!running} target={results.data?.target ?? target}
            hasMetrics={hasMetrics} hasWidgets={doc.widgets.length > 0} onBack={onBack} onRename={rename} onUndo={editor.undo}
            onRedo={editor.redo} onPresent={() => { setPresent((p) => !p); setSelected(null); }} onExposure={registerExposure}
            onExport={() => setExporting(true)} onDelete={remove} onRefresh={() => run()}
            onReload={async () => { const latest = await detail.refetch(); if (latest.data) editor.reload(latest.data); }} />
          <PeriodBar projectId={projectId} doc={doc} catalog={catalog} onChange={(next) => apply(() => next)}
            asOf={asOf ? `Data as of ${relativeTime(asOf)}` : null} />
        </div>
        {/* The rails float over the canvas; the canvas keeps its fixed width and scrolls out from under them */}
        <div className="relative flex-1 min-h-0">
          <div className="absolute inset-0 overflow-auto">
            {results.error && (
              <p className="sticky top-0 z-20 px-4 py-2 text-xs text-center text-red-300 bg-red-950/60">{errorText(results.error)}</p>
            )}
            <Canvas widgets={dnd.ordered(doc.widgets)} present={present} frameProps={frameProps} gridRef={gridRef}
              onClearSelection={() => { setSelected(null); setTab('widgets'); }}
              dropping={!!dnd.active && dnd.active.kind !== 'widget'}
              canvasWidth={canvasWidthOf(doc)} onCanvasWidth={(px) => apply((d) => ({ ...d, canvas_width: px }))}
              insetLeft={present ? 0 : leftRail.width} insetRight={present ? 0 : rightRail.width} />
          </div>
          {!present && <MetricsRail catalog={catalog} labels={labels} inUse={metricsInUse(doc)} monitorStatuses={monitorStatuses} onAdd={addFromRail} rail={leftRail} />}
          {!present && (
            <WidgetsRail tab={tab} onTab={setTab} widget={selectedWidget} onAddType={addType} projectId={projectId} doc={doc}
              catalog={catalog} labels={labels} onNotice={setNotice} onChange={(w) => apply((d) => replaceWidget(d, w))} rail={rightRail}
              canvasWidth={canvasWidthOf(doc)} onCanvasWidth={(px) => apply((d) => ({ ...d, canvas_width: px }))} />
          )}
        </div>
      </div>
      <DragOverlay dropAnimation={draggedWidget ? DROP_ANIMATION : null}>
        {draggedWidget ? (
          <div className="pointer-events-none" style={{ width: widthToPx(draggedWidget.width, canvasWidthOf(doc)) }}>
            <WidgetFrame {...frameProps(draggedWidget)} containerWidth={canvasWidthOf(doc)}
              style={{ width: '100%', opacity: 0.92, boxShadow: '0 18px 40px rgb(0 0 0 / 0.45)', cursor: 'grabbing' }} />
          </div>
        ) : dnd.overlay()}
      </DragOverlay>
      {notice && (
        <div role="status" className="fixed bottom-14 left-1/2 z-50 -translate-x-1/2 px-3 py-2 text-xs rounded border border-gray-700 bg-surface-elevated text-gray-200 shadow-xl">
          {notice}
        </div>
      )}
      {review && <ProposalReviewModal projectId={projectId} proposal={review} onClose={closeReview} />}
      {exporting && (
        <ExportDashboardModal projectId={projectId} doc={doc} slug={slug} target={results.data?.target ?? target}
          results={results.data?.widgets ?? []} gridRef={gridRef} onClose={() => setExporting(false)} />
      )}
    </DndContext>
  );
}
