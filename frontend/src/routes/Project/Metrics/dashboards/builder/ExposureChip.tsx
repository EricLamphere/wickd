// The dashboard's linked exposure in the header: green when it's clean, yellow when its metrics
// differ from the dashboard's (Update exposure), red when it's gone from the project (a dead
// link, per dbt's manifest). Its menu opens the YAML, updates it, unlinks it (removes `exposure:`
// from the dashboard file, leaving the exposure), or unlinks and deletes the exposure (reviewed).
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ExternalLink, Link2, Link2Off, RefreshCw, Trash2, Unlink } from 'lucide-react';

export type ExposureStatus = 'found' | 'out_of_date' | 'missing' | 'unknown' | null;

interface Props {
  name: string;
  status: ExposureStatus;
  path: string | null;
  canOpen: boolean;
  drift: { add: string[]; remove: string[] } | null;
  onOpen: () => void;
  onUpdate: () => void;
  onUnlink: () => void;
  onDelete: () => void;
}

/** "adds avg_order_value; removes orders" */
export function driftText(drift: { add: string[]; remove: string[] } | null): string {
  if (!drift) return '';
  return [drift.add.length ? `adds ${drift.add.join(', ')}` : '', drift.remove.length ? `removes ${drift.remove.join(', ')}` : '']
    .filter(Boolean).join('; ');
}

export function ExposureChip({ name, status, path, canOpen, drift, onOpen, onUpdate, onUnlink, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);
  const missing = status === 'missing';
  const stale = status === 'out_of_date';
  const title = missing ? `The exposure ${name} isn't in the project any more (per dbt's last parse)`
    : stale ? `The exposure ${name} doesn't match this dashboard's metrics: updating it ${driftText(drift)}`
      : status === 'found' ? `Registered as the dbt exposure ${name}${path ? ` in ${path}` : ''}, up to date` : `Linked to the dbt exposure ${name}`;
  const tone = missing ? 'border-red-800 bg-red-950/40 text-red-300 hover:border-red-600'
    : stale ? 'border-yellow-800 bg-yellow-950/40 text-yellow-300 hover:border-yellow-600'
      : status === 'found' ? 'border-emerald-800 bg-emerald-950/40 text-emerald-300 hover:border-emerald-600'
        : 'border-gray-700 text-gray-400 hover:border-gray-500';
  const exists = status === 'found' || stale;
  return (
    <div ref={ref} className="relative shrink-0" data-export-hide="">
      <button onClick={() => setOpen((o) => !o)} title={title} aria-label={`Exposure ${name}`} aria-expanded={open}
        className={`flex items-center gap-1 px-1.5 py-px text-[10px] rounded border ${tone}`}>
        {missing ? <Link2Off className="w-3 h-3" /> : stale ? <AlertTriangle className="w-3 h-3" /> : <Link2 className="w-3 h-3" />}
        {name}{missing && ' · dead link'}{stale && ' · out of date'}
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-6 z-40 w-64 py-1 bg-surface-elevated border border-gray-700 rounded shadow-xl">
          <p className="px-3 pt-1 pb-1.5 text-[11px] text-gray-400 border-b border-gray-800">{title}.</p>
          {stale && (
            <button role="menuitem" onClick={() => { setOpen(false); onUpdate(); }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-800">
              <RefreshCw className="w-3.5 h-3.5" />Update the exposure YAML
            </button>
          )}
          {(status === 'found' || stale) && (
            <button role="menuitem" disabled={!canOpen} onClick={() => { setOpen(false); onOpen(); }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-40">
              <ExternalLink className="w-3.5 h-3.5" />Open the exposure YAML
            </button>
          )}
          <button role="menuitem" onClick={() => { setOpen(false); onUnlink(); }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-800">
            <Unlink className="w-3.5 h-3.5" />Unlink{exists ? ' (keeps the exposure)' : ''}
          </button>
          {exists && (
            <button role="menuitem" onClick={() => { setOpen(false); onDelete(); }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs text-red-300 hover:bg-gray-800">
              <Trash2 className="w-3.5 h-3.5" />Unlink and delete exposure
            </button>
          )}
        </div>
      )}
    </div>
  );
}
