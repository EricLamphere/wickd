// Metrics → Dashboards (?tab=dashboards): the project's dashboard files, or one of them
// (?dashboard=<slug>, a history entry). The open dashboard is remembered per project for the
// session, so leaving the page and coming back reopens it.
import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, LayoutDashboard, Link2, Plus } from 'lucide-react';
import { dashboardsApi, type DashboardWidget } from '../../../../lib/dashboardsApi';
import { alertDialog, promptDialog } from '../../../../lib/dialogs';
import type { SemanticCatalogDto } from '../../../../lib/semanticApi';
import { relativeTime } from '../../lib/relativeTime';
import { DashboardBuilder } from './builder/DashboardBuilder';
import { errorText, useDashboardList } from './useDashboards';

interface Props {
  projectId: number;
  catalog: SemanticCatalogDto;
  labels: Map<string, string>;
  target: string | null;
  /** a widget in the metric explorer, as it showed here */
  onOpenExplorer: (widget: DashboardWidget) => void;
  /** a metric's page (single-metric widgets' menu) */
  onOpenMetric: (metric: string) => void;
}

const PARAM = 'dashboard';
const rememberKey = (projectId: number) => `metrics-dashboard:${projectId}`;

function remembered(projectId: number): string | null {
  try { return sessionStorage.getItem(rememberKey(projectId)); } catch { return null; }
}

function remember(projectId: number, slug: string | null): void {
  try {
    if (slug) sessionStorage.setItem(rememberKey(projectId), slug); else sessionStorage.removeItem(rememberKey(projectId));
  } catch { /* storage unavailable */ }
}

export function DashboardsTab({ projectId, catalog, labels, target, onOpenExplorer, onOpenMetric }: Props) {
  const [params, setParams] = useSearchParams();
  const slug = params.get(PARAM);
  const list = useDashboardList(projectId);

  const open = (next: string | null, replace = false) => {
    remember(projectId, next);
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next) p.set(PARAM, next); else p.delete(PARAM);
      return p;
    }, { replace });
  };

  useEffect(() => {
    if (slug) { remember(projectId, slug); return; }
    const last = remembered(projectId);
    if (last && list.data?.dashboards.some((d) => d.slug === last)) open(last, true);
  }, [slug, list.data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (slug) {
    return <DashboardBuilder key={slug} projectId={projectId} slug={slug} catalog={catalog} labels={labels} target={target}
      onBack={() => open(null)} onOpenExplorer={onOpenExplorer} onOpenMetric={onOpenMetric} />;
  }

  const create = async () => {
    const title = await promptDialog('Title for the new dashboard:', '', { title: 'New dashboard', confirmLabel: 'Create' });
    if (!title?.trim()) return;
    try {
      const created = await dashboardsApi.create(projectId, title.trim());
      open(created.slug);
    } catch (err) {
      await alertDialog(errorText(err) ?? 'Creating failed', { title: "Couldn't create the dashboard" });
    }
  };

  return (
    <div className="flex flex-col gap-4 p-6 max-w-5xl">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-gray-100">Dashboards</h2>
          <p className="text-[11px] text-gray-500">
            Metrics laid out as widgets, saved as YAML in <span className="font-mono">{list.data?.folder ?? 'wickd/dashboards'}</span> so
            they're versioned with your project.
          </p>
        </div>
        <button onClick={create} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-brand-600 text-white hover:bg-brand-500">
          <Plus className="w-3.5 h-3.5" />New dashboard
        </button>
      </div>
      {list.isLoading && <p className="text-xs text-gray-500">Loading…</p>}
      {list.error && <p className="text-xs text-red-400">{errorText(list.error)}</p>}
      {list.data && list.data.dashboards.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <LayoutDashboard className="w-6 h-6 text-gray-600" />
          <p className="text-xs text-gray-400">No dashboards yet.</p>
          <p className="max-w-sm text-[11px] text-gray-500">Create one, then drag metrics onto it. You can also send a query from Explore with Add to dashboard….</p>
        </div>
      )}
      <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(16rem,1fr))]">
        {list.data?.dashboards.map((d) => (
          <button key={d.slug} onClick={() => open(d.slug)}
            className="flex flex-col gap-1.5 p-3 text-left bg-surface-panel border border-gray-800 rounded hover:border-gray-600">
            <span className="flex items-center gap-2 text-xs font-medium text-gray-100">
              <LayoutDashboard className="w-3.5 h-3.5 text-gray-500 shrink-0" /><span className="truncate">{d.title}</span>
            </span>
            {d.error ? (
              <span className="flex items-start gap-1 text-[11px] text-red-300"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                <span className="line-clamp-2">{d.error}</span></span>
            ) : (
              <span className="text-[11px] text-gray-500">
                {d.widget_count} widget{d.widget_count === 1 ? '' : 's'}{d.modified_at ? ` · edited ${relativeTime(d.modified_at)}` : ''}
              </span>
            )}
            <span className="flex items-center gap-2 text-[10px] font-mono text-gray-600 truncate">
              {d.path}{d.exposure && (
                <span className={`flex items-center gap-0.5 ${d.exposure_status === 'missing' ? 'text-red-400'
                  : d.exposure_status === 'out_of_date' ? 'text-yellow-400' : d.exposure_status === 'found' ? 'text-emerald-400' : 'text-gray-500'}`}
                  title={d.exposure_status === 'missing' ? "This exposure isn't in the project any more (dead link)"
                    : d.exposure_status === 'out_of_date' ? "This exposure doesn't list all the dashboard's metrics" : undefined}>
                  <Link2 className="w-3 h-3" />{d.exposure}{d.exposure_status === 'missing' && ' · dead link'}{d.exposure_status === 'out_of_date' && ' · out of date'}</span>
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
