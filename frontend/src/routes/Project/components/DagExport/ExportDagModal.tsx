import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, FolderOpen, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, exportFieldError, ApiError, type GraphDto } from '../../../../lib/api';
import {
  buildExportHeader, defaultExportFilename, withExtension, type ExportFormat,
} from '../../lib/dagExport/config';
import type { LineageResults } from '../../lib/dagExport/html';
import { renderExport } from '../../lib/dagExport';
import { loadPrefs, savePrefs, type ExportPrefs } from '../../lib/dagExport/prefs';
import type { DagScene } from '../../lib/dagExport/scene';
import type { FilterState } from '../../lib/dagFilter';
import { FormatPicker, IncludesPicker, ThemePicker } from './ExportOptions';
import { FolderPickerModal } from './FolderPickerModal';

interface ExportDagModalProps {
  projectId: number;
  projectName: string;
  filter: FilterState;
  scene: DagScene;
  /** The whole project (live statuses applied), for whole-project HTML exports. */
  graph: GraphDto;
  nodeHeights: Map<string, number>;
  expandedNodes: Set<string>;
  /** Finished column lineage, or null when it hasn't been loaded. */
  lineage: LineageResults | null;
  lineageLoading: boolean;
  onLoadLineage: () => void;
  /** Column lineage is a wickd Pro feature; when locked, its checkbox offers the upgrade instead. */
  columnLineageLocked: boolean;
  onUpgradeColumnLineage: () => void;
  onClose: () => void;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'conflict'; message: string }
  | { kind: 'done'; path: string; downscaled: boolean };

const INPUT = 'w-full bg-surface-elevated border border-gray-700 rounded px-3 py-1.5 text-xs text-gray-100 font-mono placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-brand-500';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{title}</h3>
      {children}
    </section>
  );
}

export function ExportDagModal(props: ExportDagModalProps) {
  const { projectId, projectName, filter, scene, graph, nodeHeights, expandedNodes, lineage, lineageLoading, onLoadLineage, columnLineageLocked, onUpgradeColumnLineage, onClose } = props;
  const [prefs, setPrefs] = useState<ExportPrefs>(loadPrefs);
  const [filename, setFilename] = useState(() => defaultExportFilename(projectName, prefs.format, new Date()));
  const [directory, setDirectory] = useState(prefs.directory);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<{ field: string | null; message: string } | null>(null);

  const { data: defaultDir } = useQuery({
    queryKey: ['export-default-dir'],
    queryFn: () => api.exports.defaultDir(),
    staleTime: Infinity,
  });
  useEffect(() => {
    if (!directory && defaultDir) setDirectory(defaultDir.path);
  }, [defaultDir]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !pickingFolder) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pickingFolder]);

  const includes = {
    ...prefs.includes,
    columnLineage: prefs.includes.columnLineage && lineage !== null && !columnLineageLocked,
  };
  const summary = useMemo(() => buildExportHeader({
    projectName,
    filter,
    nodeCount: scene.nodes.length,
    edgeCount: scene.edges.length,
    exportedAt: new Date(),
    includes: prefs.format === 'html' ? includes : undefined,
  }), [projectName, filter, scene, prefs.format, includes.modelLineage, includes.columnLineage, includes.wholeProject]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (patch: Partial<ExportPrefs>) => setPrefs((p) => ({ ...p, ...patch }));
  const setFormat = (format: ExportFormat) => {
    update({ format });
    setFilename((f) => withExtension(f, format));
  };

  const submit = async (overwrite: boolean) => {
    setError(null);
    setPhase({ kind: 'working' });
    try {
      const rendered = await renderExport({
        format: prefs.format, theme: prefs.theme, includes, scene, projectName, filter, lineage,
        graph, nodeHeights, expanded: expandedNodes,
      });
      const result = await api.exports.dag(projectId, {
        directory, filename, format: prefs.format, content: rendered.content, encoding: rendered.encoding, overwrite,
      });
      savePrefs({ ...prefs, directory });
      setPhase({ kind: 'done', path: result.path, downscaled: (rendered.scale ?? 2) < 1 });
    } catch (err) {
      const fieldErr = exportFieldError(err);
      if (err instanceof ApiError && err.status === 409 && fieldErr) {
        setPhase({ kind: 'conflict', message: fieldErr.message });
        return;
      }
      setPhase({ kind: 'idle' });
      setError(fieldErr ?? { field: null, message: err instanceof Error ? err.message : String(err) });
    }
  };

  const empty = scene.nodes.length === 0;
  const working = phase.kind === 'working';

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Export DAG"
        className="bg-surface-panel border border-gray-700 rounded-lg shadow-2xl w-full max-w-xl mx-4 max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-gray-100">Export DAG</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors" title="Close">
            <X size={16} />
          </button>
        </div>

        {phase.kind === 'done' ? (
          <div className="p-6 flex flex-col items-center gap-3 text-center">
            <CheckCircle2 size={28} className="text-emerald-400" />
            <p className="text-sm text-gray-100">DAG exported</p>
            <p className="text-xs font-mono text-gray-400 break-all">{phase.path}</p>
            {phase.downscaled && (
              <p className="text-[11px] text-amber-300">
                This DAG is too large for a full-resolution PNG, so it was scaled down. Export SVG for full detail.
              </p>
            )}
            <div className="flex gap-2 pt-2">
              <button
                onClick={() => api.exports.reveal(phase.path).catch(() => {})}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:text-gray-100 hover:border-gray-600 transition-colors"
              >
                <FolderOpen size={13} /> Show in Finder
              </button>
              <button onClick={onClose} className="px-4 py-1.5 text-xs rounded bg-brand-600 hover:bg-brand-500 text-white font-medium transition-colors">
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="p-5 flex flex-col gap-5 overflow-auto">
              <Section title="Format">
                <FormatPicker value={prefs.format} onChange={setFormat} />
              </Section>

              {prefs.format === 'html' && (
                <Section title="Include">
                  <IncludesPicker
                    value={prefs.includes}
                    onChange={(v) => update({ includes: v })}
                    lineageReady={lineage !== null}
                    lineageLoading={lineageLoading}
                    onLoadLineage={onLoadLineage}
                    columnLineageLocked={columnLineageLocked}
                    onUpgradeColumnLineage={onUpgradeColumnLineage}
                    shownCount={scene.nodes.length}
                    totalCount={graph.nodes.length}
                  />
                </Section>
              )}

              <Section title="Theme">
                <ThemePicker value={prefs.theme} onChange={(theme) => update({ theme })} />
              </Section>

              <Section title="What's exported">
                <p className="text-[11px] text-gray-500 -mt-1">
                  The DAG exactly as it's filtered on screen. This summary is printed at the top of the export.
                </p>
                <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 px-3 py-2 rounded bg-surface-elevated/60 border border-gray-800 text-xs">
                  {summary.rows.map((r) => (
                    <div key={r.label} className="contents">
                      <dt className="text-gray-500">{r.label}</dt>
                      <dd className="font-mono text-gray-200 break-words">{r.value}</dd>
                    </div>
                  ))}
                </dl>
                {empty && <p className="text-xs text-amber-300">No nodes match the current filter, so there's nothing to export.</p>}
              </Section>

              <Section title="Save to">
                <div className="flex gap-2">
                  <input
                    value={directory}
                    onChange={(e) => setDirectory(e.target.value)}
                    placeholder="~/Downloads"
                    aria-label="Folder"
                    className={INPUT}
                  />
                  <button
                    type="button"
                    onClick={() => setPickingFolder(true)}
                    className="px-3 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:text-gray-100 hover:border-gray-600 shrink-0 transition-colors"
                  >
                    Browse…
                  </button>
                </div>
                {error?.field === 'directory' && <p className="text-xs text-red-400">{error.message}</p>}
                <input
                  value={filename}
                  onChange={(e) => { setFilename(e.target.value); if (phase.kind === 'conflict') setPhase({ kind: 'idle' }); }}
                  aria-label="File name"
                  className={INPUT}
                />
                {error?.field === 'filename' && <p className="text-xs text-red-400">{error.message}</p>}
              </Section>

              {error && error.field !== 'directory' && error.field !== 'filename' && (
                <p className="text-xs text-red-400 bg-red-950/40 border border-red-900 rounded px-3 py-2">{error.message}</p>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-800">
              {phase.kind === 'conflict' && (
                <span className="mr-auto text-xs text-amber-300">{phase.message} Replace it?</span>
              )}
              <button onClick={onClose} className="px-4 py-1.5 text-xs rounded bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors">
                Cancel
              </button>
              <button
                onClick={() => submit(phase.kind === 'conflict')}
                disabled={empty || working || !directory.trim() || !filename.trim()}
                className="px-4 py-1.5 text-xs rounded bg-brand-600 hover:bg-brand-500 text-white font-medium transition-colors disabled:opacity-50"
              >
                {working ? 'Exporting…' : phase.kind === 'conflict' ? 'Replace' : 'Export'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>

    {/* Outside the backdrop: React bubbles the picker's clicks up the component tree */}
    {pickingFolder && (
        <FolderPickerModal
          initialDir={directory || defaultDir?.path || ''}
          onSelect={(path) => { setDirectory(path); setPickingFolder(false); }}
          onClose={() => setPickingFolder(false)}
        />
      )}
    </>
  );
}
