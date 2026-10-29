// The builder's title row: back, title (click to rename), file path, exposure, save status,
// undo / redo, Present, and the dashboard actions (exposure, export, delete, refresh).
import {
  ArrowLeft, Check, CloudOff, Download, Link2, Loader2, Maximize2, Minimize2, Redo2, RefreshCw, Trash2, Undo2,
} from 'lucide-react';
import type { SaveState } from './useDashboardEditor';

const BTN = 'flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:border-gray-500 disabled:opacity-40';
const ICON = 'p-1.5 rounded text-gray-400 hover:text-gray-100 hover:bg-gray-800 disabled:opacity-30 disabled:hover:bg-transparent';

interface Props {
  title: string;
  path: string;
  exposure: string | null;
  save: SaveState;
  present: boolean;
  canUndo: boolean;
  canRedo: boolean;
  running: boolean;
  target: string | null;
  hasMetrics: boolean;
  hasWidgets: boolean;
  onBack: () => void;
  onRename: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onPresent: () => void;
  onExposure: () => void;
  onExport: () => void;
  onDelete: () => void;
  onRefresh: () => void;
  onReload: () => void;
}

function SaveStatus({ save, onReload }: { save: SaveState; onReload: () => void }) {
  if (save.kind === 'saving' || save.kind === 'pending') {
    return <span className="flex items-center gap-1 text-[11px] text-gray-500"><Loader2 className="w-3 h-3 animate-spin" />Saving…</span>;
  }
  if (save.kind === 'error') {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-red-300" title={save.message}>
        <CloudOff className="w-3 h-3" />{save.conflict ? 'The file changed on disk' : "Couldn't save"}
        {save.conflict && <button onClick={onReload} className="underline underline-offset-2 hover:text-red-200">Load it (discard my changes)</button>}
      </span>
    );
  }
  return <span className="flex items-center gap-1 text-[11px] text-gray-500"><Check className="w-3 h-3" />Saved</span>;
}

export function BuilderHeader(p: Props) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <button onClick={p.onBack} className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-200 shrink-0" data-export-hide="">
        <ArrowLeft className="w-3.5 h-3.5" />Dashboards
      </button>
      <button onClick={p.onRename} disabled={p.present} title="Rename" className="min-w-0 text-sm font-semibold text-gray-100 truncate hover:text-white">
        {p.title}
      </button>
      {!p.present && <span className="hidden xl:inline text-[11px] font-mono text-gray-600 truncate">{p.path}</span>}
      {p.exposure && (
        <span className="flex items-center gap-1 px-1.5 py-px text-[10px] rounded border border-gray-700 text-gray-400" title="Registered as a dbt exposure">
          <Link2 className="w-3 h-3" />{p.exposure}
        </span>
      )}
      {!p.present && <SaveStatus save={p.save} onReload={p.onReload} />}
      <div className="flex-1" />
      {!p.present && (
        <div className="flex items-center" data-export-hide="">
          <button onClick={p.onUndo} disabled={!p.canUndo} title="Undo (⌘Z)" aria-label="Undo" className={ICON}><Undo2 className="w-4 h-4" /></button>
          <button onClick={p.onRedo} disabled={!p.canRedo} title="Redo (⇧⌘Z)" aria-label="Redo" className={ICON}><Redo2 className="w-4 h-4" /></button>
        </div>
      )}
      <div className="flex items-center gap-2" data-export-hide="">
        <button onClick={p.onPresent} className={BTN} title={p.present ? 'Back to editing (Esc)' : 'Hide the rails'}>
          {p.present ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}{p.present ? 'Edit' : 'Present'}
        </button>
        {!p.present && !p.exposure && (
          <button onClick={p.onExposure} disabled={!p.hasMetrics} title="Write a dbt exposure for this dashboard" className={BTN}>
            <Link2 className="w-3.5 h-3.5" />Register as exposure
          </button>
        )}
        <button onClick={p.onExport} disabled={!p.hasWidgets} className={BTN}><Download className="w-3.5 h-3.5" />Export</button>
        {!p.present && <button onClick={p.onDelete} title="Delete dashboard" aria-label="Delete dashboard" className={BTN}><Trash2 className="w-3.5 h-3.5" /></button>}
        <button onClick={p.onRefresh} disabled={p.running || !p.hasMetrics} title="Run every widget on the warehouse in one batch"
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40">
          {p.running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh{p.target ? ` on ${p.target}` : ''}
        </button>
      </div>
    </div>
  );
}
