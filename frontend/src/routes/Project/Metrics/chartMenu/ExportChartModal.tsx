// Download a metric chart: a PNG of it as on screen, or its rows as CSV. Written by POST
// /exports/chart into the chosen folder (the desktop webview has no download manager), like
// dashboard exports; the folder is remembered. `render` produces the file when Save is clicked.
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, FolderOpen, X } from 'lucide-react';
import { api, ApiError, exportFieldError } from '../../../../lib/api';
import { FolderPickerModal } from '../../components/DagExport/FolderPickerModal';

export type ChartFileFormat = 'png' | 'csv';

export interface RenderedChartFile {
  content: string;
  encoding: 'utf8' | 'base64';
}

interface Props {
  projectId: number;
  format: ChartFileFormat;
  /** without the extension */
  defaultName: string;
  render: () => Promise<RenderedChartFile>;
  onClose: () => void;
}

const INPUT = 'w-full bg-surface-elevated border border-gray-700 rounded px-3 py-1.5 text-xs text-gray-100 font-mono placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-brand-500';
const DIR_KEY = 'wickd:chart-export-dir';

type Phase = { kind: 'idle' } | { kind: 'working' } | { kind: 'conflict'; message: string } | { kind: 'done'; path: string };

function storedDir(): string {
  try { return localStorage.getItem(DIR_KEY) ?? ''; } catch { return ''; }
}

export function ExportChartModal({ projectId, format, defaultName, render, onClose }: Props) {
  const [filename, setFilename] = useState(`${defaultName}.${format}`);
  const [directory, setDirectory] = useState(storedDir);
  const [picking, setPicking] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const { data: defaultDir } = useQuery({ queryKey: ['export-default-dir'], queryFn: () => api.exports.defaultDir(), staleTime: Infinity });

  useEffect(() => { if (!directory && defaultDir) setDirectory(defaultDir.path); }, [defaultDir]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || picking) return;
      e.preventDefault(); // the Investigate window stays open
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, picking]);

  const save = async (overwrite: boolean) => {
    setError(null);
    setPhase({ kind: 'working' });
    try {
      const file = await render();
      const result = await api.exports.chart(projectId, { directory, filename, format, ...file, overwrite });
      try { localStorage.setItem(DIR_KEY, directory); } catch { /* storage unavailable */ }
      setPhase({ kind: 'done', path: result.path });
    } catch (err) {
      const field = exportFieldError(err);
      if (err instanceof ApiError && err.status === 409 && field) { setPhase({ kind: 'conflict', message: field.message }); return; }
      setPhase({ kind: 'idle' });
      setError(field?.message ?? (err instanceof Error ? err.message : String(err)));
    }
  };

  const working = phase.kind === 'working';
  const title = format === 'png' ? 'Download PNG' : 'Download CSV';
  return (
    <>
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={onClose}>
        <div role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}
          className="flex flex-col w-full max-w-lg mx-4 bg-surface-panel border border-gray-700 rounded-lg shadow-2xl">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-800">
            <h2 className="text-sm font-semibold text-gray-100">{title}</h2>
            <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
          </div>
          {phase.kind === 'done' ? (
            <div className="flex flex-col items-center gap-3 p-6 text-center">
              <CheckCircle2 size={28} className="text-emerald-400" />
              <p className="text-sm text-gray-100">Saved</p>
              <p className="text-xs font-mono text-gray-400 break-all">{phase.path}</p>
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
              <div className="flex flex-col gap-3 p-5">
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
                <button onClick={() => save(phase.kind === 'conflict')} disabled={working || !directory.trim() || !filename.trim()}
                  className="px-4 py-1.5 text-xs rounded bg-brand-600 text-white font-medium hover:bg-brand-500 disabled:opacity-50">
                  {working ? 'Saving…' : phase.kind === 'conflict' ? 'Replace' : 'Save'}
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
