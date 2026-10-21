import { useEffect, useRef, useState } from 'react';
import { TILE_WIDTH_PCT } from './flow';

interface AddStepTileProps {
  offsetPct: number;
  isFirst: boolean;
  onCreate: () => void;
  onLinkExisting: () => void;
}

/** Greyed-out placeholder at the end of the flow; click it to create or link a script. */
export function AddStepTile({ offsetPct, isFirst, onCreate, onLinkExisting }: AddStepTileProps) {
  const [choosing, setChoosing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!choosing) return;
    const handleOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setChoosing(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setChoosing(false);
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [choosing]);

  const pick = (action: () => void) => {
    setChoosing(false);
    action();
  };

  return (
    <div
      ref={ref}
      style={{ marginLeft: `${offsetPct}%`, width: `${TILE_WIDTH_PCT}%` }}
      className="rounded-xl border-2 border-dashed border-gray-700 transition-all"
    >
      {choosing ? (
        <div className="flex items-center gap-2 px-4 py-3">
          <button
            onClick={() => pick(onCreate)}
            className="flex-1 px-3 py-2 text-xs rounded-lg bg-surface-elevated hover:bg-brand-900/40 text-gray-300 hover:text-brand-300 transition-colors"
          >
            Create new script
          </button>
          <button
            onClick={() => pick(onLinkExisting)}
            className="flex-1 px-3 py-2 text-xs rounded-lg bg-surface-elevated hover:bg-brand-900/40 text-gray-300 hover:text-brand-300 transition-colors"
          >
            Use existing script
          </button>
          <button
            onClick={() => setChoosing(false)}
            title="Cancel"
            className="px-1.5 text-gray-600 hover:text-gray-400 transition-colors"
          >
            ✕
          </button>
        </div>
      ) : (
        <button
          onClick={() => setChoosing(true)}
          className="group w-full flex items-center gap-3 px-4 py-3 text-left text-gray-600 hover:text-gray-400 transition-colors"
        >
          <span className="w-7 h-7 shrink-0 flex items-center justify-center rounded-full border-2 border-dashed border-gray-700 group-hover:border-gray-500 text-base leading-none transition-colors">
            +
          </span>
          <span className="flex flex-col">
            <span className="text-sm font-medium">{isFirst ? 'Add your first step' : 'Add step'}</span>
            <span className="text-[11px] text-gray-700 group-hover:text-gray-600 transition-colors">
              Create a new shell script or link an existing one
            </span>
          </span>
        </button>
      )}
    </div>
  );
}
