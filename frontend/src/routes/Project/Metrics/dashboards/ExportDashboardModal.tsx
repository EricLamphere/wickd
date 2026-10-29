// Export a dashboard to a file: self-contained HTML (charts as rendered, data embedded, hover
// readouts) or PNG. Written by POST /exports/dashboard into the chosen folder (the desktop
// webview has no download manager). The export says which target and when the data was queried.
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FolderOpen, X } from 'lucide-react';
import { api, ApiError, exportFieldError } from '../../../../lib/api';
import type { DashboardDoc, WidgetResultDto } from '../../../../lib/dashboardsApi';
import { FolderPickerModal } from '../../components/DagExport/FolderPickerModal';
import { renderDashboardExport, type DashboardExportFormat } from '../../lib/dashboardExport';
import { compareLabel, currentLabel, rangeLabel, resolveCompare, resolveCurrent } from './dashboardModel';
import { filterLabel } from '../lib/metricQuery';

interface Props {
  projectId: number;
  doc: DashboardDoc;
  slug: string;
  target: string | null;
  results: WidgetResultDto[];
  gridRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}

const INPUT = 'w-full bg-surface-elevated border border-gray-700 rounded px-3 py-1.5 text-xs text-gray-100 font-mono placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-brand-500';
const DIR_KEY = 'wickd:dashboard-export-dir';

type Phase = { kind: 'idle' } | { kind: 'working' } | { kind: 'conflict'; message: string } | { kind: 'done'; path: string; downscaled: boolean };

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function storedDir(): string {
  try { return localStorage.getItem(DIR_KEY) ?? ''; } catch { return ''; }
}

export function ExportDashboardModal({ projectId, doc, slug, target, results, gridRef, onClose }: Props) {
  const [format, setFormat] = useState<DashboardExportFormat>('html');
  const [filename, setFilename] = useState(() => `${slug}-${stamp(new Date())}.html`);
  const [directory, setDirectory] = useState(storedDir);
  const [picking, setPicking] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const { data: defaultDir } = useQuery({ queryKey: ['export-default-dir'], queryFn: () => api.exports.defaultDir(), staleTime: Infinity });

  useEffect(() => { if (!directory && defaultDir) setDirectory(defaultDir.path); }, [defaultDir]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !picking) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, picking]);

  const queried = results.map((r) => r.ran_at).filter((t): t is string => !!t).sort()[0] ?? null;
  const missing = results.filter((r) => r.status === 'not_run' || r.status === 'error').length;
  const current = resolveCurrent(doc.period?.current ?? 'last_30_days');
  const previous = resolveCompare(doc.period?.compare ?? 'previous_period', current);
  const meta = useMemo(() => ({
    title: doc.title,
    subtitle: [
      target ? `Target ${target}` : null,
      queried ? `data queried ${new Date(queried).toLocaleString()}` : 'not queried yet',
      `exported ${new Date().toLocaleString()}`,
    ].filter(Boolean).join(' · '),
    rows: [
      { label: 'Period', value: `${currentLabel(doc.period?.current)}${current ? ` (${rangeLabel(current)})` : ''}` },
      { label: 'Compared with', value: previous ? `${compareLabel(doc.period?.compare)} (${rangeLabel(previous)})` : 'Nothing' },
      ...(doc.filters ?? []).map((w) => ({ label: 'Filter', value: filterLabel(w) })),
    ],
  }), [doc, target, queried, current, previous]);

  const pick = (next: DashboardExportFormat) => {
    setFormat(next);
    setFilename((f) => `${f.replace(/\.(html|png)$/i, '') || slug}.${next}`);
  };

  const submit = async (overwrite: boolean) => {
    if (!gridRef.current) return;
    setError(null);
    setPhase({ kind: 'working' });
    try {
      const rendered = await renderDashboardExport({ format, grid: gridRef.current, doc, results, meta });
      const result = await api.exports.dashboard(projectId, {
        directory, filename, format, content: rendered.content, encoding: rendered.encoding, overwrite,
      });
      try { localStorage.setItem(DIR_KEY, directory); } catch { /* storage unavailable */ }
      setPhase({ kind: 'done', path: result.path, downscaled: (rendered.scale ?? 2) < 1 });
    } catch (err) {
      const field = exportFieldError(err);
      if (err instanceof ApiError && err.status === 409 && field) { setPhase({ kind: 'conflict', message: field.message }); return; }
      setPhase({ kind: 'idle' });
      setError(field?.message ?? (err instanceof Error ? err.message : String(err)));
    }
  };

  const working = phase.kind === 'working';
  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
        <div role="dialog" aria-label="Export dashboard" onClick={(e) => e.stopPropagation()}
          className="flex flex-col w-full max-w-lg mx-4 bg-surface-panel border border-gray-700 rounded-lg shadow-2xl">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-800">
            <h2 className="text-sm font-semibold text-gray-100">Export dashboard</h2>
            <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
          </div>
          {phase.kind === 'done' ? (
            <div className="flex flex-col items-center gap-3 p-6 text-center">
              <CheckCircle2 size={28} className="text-emerald-400" />
              <p className="text-sm text-gray-100">Dashboard exported</p>
              <p className="text-xs font-mono text-gray-400 break-all">{phase.path}</p>
              {phase.downscaled && <p className="text-[11px] text-amber-300">The dashboard was too large for a full-resolution PNG, so it was scaled down.</p>}
              <div className="flex gap-2 pt-2">
                <button onClick={() => api.exports.reveal(phase.path).catch(() => {})}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:border-gray-600">
                  <FolderOpen size={13} />Show in Finder
                </button>
                <button onClick={onClose} className="px-4 py-1.5 text-xs rounded bg-brand-600 text-white hover:bg-brand-500">Done</button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-4 p-5">
                <div className="flex gap-2" role="radiogroup" aria-label="Format">
                  {(['html', 'png'] as const).map((f) => (
                    <button key={f} role="radio" aria-checked={format === f} onClick={() => pick(f)}
                      className={`flex-1 flex flex-col gap-0.5 px-3 py-2 text-left rounded border ${format === f ? 'border-brand-600 bg-brand-950/40' : 'border-gray-700 hover:border-gray-600'}`}>
                      <span className="text-xs font-medium text-gray-100">{f.toUpperCase()}</span>
                      <span className="text-[11px] text-gray-500">{f === 'html' ? 'One file, opens in any browser, hover for values' : 'An image of the dashboard'}</span>
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-gray-500">{meta.subtitle}</p>
                {missing > 0 && (
                  <p className="flex items-start gap-1.5 text-[11px] text-amber-300">
                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                    {missing} widget{missing === 1 ? " has" : 's have'} no data (not run or failed). Refresh the dashboard first to include it.
                  </p>
                )}
                <div className="flex gap-2">
                  <input value={directory} onChange={(e) => setDirectory(e.target.value)} placeholder="~/Downloads" aria-label="Folder" className={INPUT} />
                  <button onClick={() => setPicking(true)} className="px-3 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:border-gray-600 shrink-0">Browse…</button>
                </div>
                <input value={filename} aria-label="File name" className={INPUT}
                  onChange={(e) => { setFilename(e.target.value); if (phase.kind === 'conflict') setPhase({ kind: 'idle' }); }} />
                {error && <p className="px-3 py-2 text-xs text-red-400 bg-red-950/40 border border-red-900 rounded">{error}</p>}
              </div>
              <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-800">
                {phase.kind === 'conflict' && <span className="mr-auto text-xs text-amber-300">{phase.message} Replace it?</span>}
                <button onClick={onClose} className="px-4 py-1.5 text-xs rounded bg-gray-800 text-gray-300 hover:bg-gray-700">Cancel</button>
                <button onClick={() => submit(phase.kind === 'conflict')} disabled={working || !directory.trim() || !filename.trim()}
                  className="px-4 py-1.5 text-xs rounded bg-brand-600 text-white font-medium hover:bg-brand-500 disabled:opacity-50">
                  {working ? 'Exporting…' : phase.kind === 'conflict' ? 'Replace' : 'Export'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      {picking && (
        <FolderPickerModal initialDir={directory || defaultDir?.path || ''}
          onSelect={(path) => { setDirectory(path); setPicking(false); }} onClose={() => setPicking(false)} />
      )}
    </>
  );
}
