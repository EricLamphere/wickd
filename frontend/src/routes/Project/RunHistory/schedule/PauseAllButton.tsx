// Runs → Schedule's Pause all. A state button rather than a checkbox: while schedules run it
// offers "Pause all"; while paused it reads as an amber "Paused" pill offering Resume all.
import { Pause, Play } from 'lucide-react';

export function PauseAllButton({ paused, onChange }: { paused: boolean; onChange: (paused: boolean) => void }) {
  if (paused) {
    return (
      <button type="button" onClick={() => onChange(false)} aria-pressed title="All schedules are paused. Click to resume them."
        className="ml-auto flex items-center gap-1.5 pl-2 pr-2.5 py-1 rounded-full border border-amber-700/60 bg-amber-950/40 text-amber-300 hover:bg-amber-900/40">
        <span className="flex items-center gap-1 font-medium"><Pause className="w-3 h-3" />Paused</span>
        <span className="text-amber-700">·</span>
        <span className="flex items-center gap-1"><Play className="w-3 h-3" />Resume all</span>
      </button>
    );
  }
  return (
    <button type="button" onClick={() => onChange(true)} aria-pressed={false} title="Stop every schedule from running until you resume"
      className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded border border-gray-700 text-gray-300 hover:bg-surface-elevated hover:text-gray-100">
      <Pause className="w-3.5 h-3.5" />Pause all
    </button>
  );
}
