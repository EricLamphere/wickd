import { useEffect, useState } from 'react';
import { api, type InitStepDto } from '../../../../lib/api';
import { StatusLogPopover } from '../StatusLogPopover';
import { CapturedVarsEditor } from './CapturedVarsEditor';
import { TILE_WIDTH_PCT, type StepRunState, type StepStatus } from './flow';

// ---- status icon ----

function StatusIcon({ status, log }: { status: StepStatus; log: string }) {
  if (status === 'idle') return null;

  const iconEl = (
    <>
      {status === 'running' && (
        <svg className="w-4 h-4 text-blue-400 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 100 16v-4l-3 3 3 3v-4a8 8 0 01-8-8z" />
        </svg>
      )}
      {status === 'success' && (
        <svg className="w-4 h-4 text-green-400" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
        </svg>
      )}
      {status === 'error' && (
        <svg className="w-4 h-4 text-red-400" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      )}
    </>
  );

  let panel: React.ReactNode | null = null;
  if (status === 'running') {
    panel = <p className="text-xs text-gray-300">Running…</p>;
  } else if (status === 'success') {
    panel = (
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium text-green-400">Complete</p>
        {log && <pre className="text-[11px] font-mono text-gray-400 whitespace-pre-wrap leading-relaxed">{log}</pre>}
      </div>
    );
  } else if (status === 'error') {
    panel = (
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium text-red-400">Failed</p>
        <pre className="text-[11px] font-mono text-gray-400 whitespace-pre-wrap leading-relaxed">
          {log || 'No output captured.'}
        </pre>
      </div>
    );
  }

  return <StatusLogPopover icon={iconEl} panel={panel} align="start" />;
}

// ---- step tile ----

const BASE_STEP_PREVIEWS: Record<string, string> = {
  'pip install':       '# Install Python requirements\n# Reads global + project requirements.txt',
  'dbt deps':          '# Install dbt package dependencies\n# Runs: dbt deps',
  'dbt docs generate': '# Generate dbt docs and catalog\n# Runs: dbt compile --write-catalog (or dbt docs generate)',
  'dbt compile':       '# Compile dbt models and populate compiled_code\n# Runs: dbt compile',
};

// Running tiles glow blue (the pulse animation drives box-shadow; the ring is
// the reduced-motion fallback), finished ones settle green or red.
const STATUS_TILE: Record<StepStatus, string> = {
  idle:    'border-gray-800 bg-surface-panel',
  running: 'border-blue-500 bg-gradient-to-br from-blue-950/50 via-surface-panel to-surface-panel ring-2 ring-blue-500/30 motion-safe:animate-step-glow',
  success: 'border-green-600/80 bg-gradient-to-br from-green-950/40 via-surface-panel to-surface-panel ring-1 ring-green-500/20',
  error:   'border-red-600/80 bg-gradient-to-br from-red-950/50 via-surface-panel to-surface-panel ring-1 ring-red-500/25',
};

const STATUS_BADGE: Record<StepStatus, string> = {
  idle:    'border-gray-700 text-gray-500',
  running: 'border-blue-500 text-blue-300',
  success: 'border-green-500 text-green-300',
  error:   'border-red-500 text-red-300',
};

function formatLastRun(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

interface StepTileProps {
  step: InitStepDto;
  /** Position in the flow (shown as the step number badge). */
  index: number;
  offsetPct: number;
  projectId: number;
  runState: StepRunState | null;
  onToggle: (enabled: boolean) => void;
  onRunStep: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onCapturedVarsChange: (vars: string[]) => void;
  tileRef: (el: HTMLDivElement | null) => void;
  onHandlePointerDown: (e: React.PointerEvent) => void;
  isDragging: boolean;
}

export function StepTile({ step, index, offsetPct, projectId, runState, onToggle, onRunStep, onEdit, onDelete, onCapturedVarsChange, tileRef, onHandlePointerDown, isDragging }: StepTileProps) {
  const displayName = step.name.replace(/^(base|custom):\s*/, '');
  const prefix = step.is_base ? 'base' : 'custom';
  const status: StepStatus = runState?.status ?? 'idle';
  const lastRunAt = status === 'running' ? null : (runState?.finishedAt ?? step.last_finished_at);
  const [preview, setPreview] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (step.is_base) {
      setPreview(BASE_STEP_PREVIEWS[displayName] ?? null);
    } else {
      api.init.getScriptContent(projectId, displayName)
        .then((content) => {
          const lines = content.split('\n').slice(0, 4).join('\n');
          setPreview(lines || null);
        })
        .catch(() => setPreview(null));
    }
  }, [step.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRun = async () => {
    setRunning(true);
    try {
      await onRunStep();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      alert(message.startsWith('409') ? 'Init pipeline is already running for this project.' : message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      ref={tileRef}
      style={{ marginLeft: `${offsetPct}%`, width: `${TILE_WIDTH_PCT}%` }}
      className={`relative rounded-xl border px-4 py-3 flex flex-col gap-2 ${STATUS_TILE[status]}
        ${isDragging
          // The dragged tile's transform is written directly to the DOM on
          // every pointermove (see the effect above) so it tracks the
          // cursor at full frame rate — a CSS transition on transform here
          // would fight that, easing toward each new position instead of
          // following it 1:1. Other (non-dragged) tiles keep transition-all
          // so their reflow when the array reorders reads as a smooth
          // "make room" shift instead of an instant snap.
          ? 'opacity-90 shadow-2xl scale-[1.02] z-10'
          : 'transition-all duration-300'}
        ${step.enabled ? '' : 'opacity-60'}`}
    >
      {/* Step number, straddling the left edge */}
      <span
        className={`absolute -left-3 top-3 w-6 h-6 flex items-center justify-center rounded-full border-2 bg-surface-app text-[10px] font-semibold transition-colors ${STATUS_BADGE[status]}`}
      >
        {index + 1}
      </span>

      {/* Header row */}
      <div className="flex items-center gap-2.5">
        <span
          onPointerDown={onHandlePointerDown}
          title="Drag to reorder"
          className="px-0.5 text-gray-500 hover:text-gray-300 cursor-grab active:cursor-grabbing shrink-0 select-none text-lg leading-none touch-none transition-colors"
        >
          ⠿
        </span>

        {/* Enable toggle */}
        <button
          onClick={() => onToggle(!step.enabled)}
          title={step.enabled ? 'Disable' : 'Enable'}
          className={`w-8 h-4 rounded-full transition-colors shrink-0 flex items-center px-0.5
            ${step.enabled ? 'bg-brand-600 justify-end' : 'bg-gray-700 justify-start'}`}
        >
          <span className="w-3 h-3 rounded-full bg-white shadow" />
        </button>

        {/* Name */}
        <div className="flex-1 min-w-0">
          <span className="text-[10px] text-gray-600 font-mono mr-1.5">{prefix}:</span>
          <span className="text-sm font-medium text-gray-200">{displayName}</span>
        </div>

        {lastRunAt && (
          <span
            title={`Last run ${new Date(lastRunAt).toLocaleString()}`}
            className="text-[11px] text-gray-500 shrink-0 tabular-nums"
          >
            {formatLastRun(lastRunAt)}
          </span>
        )}

        {/* Run this step */}
        <button
          onClick={handleRun}
          disabled={running || status === 'running'}
          title="Run this step"
          className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-surface-elevated hover:bg-brand-900/40 text-gray-400 hover:text-brand-300 disabled:opacity-40 transition-colors shrink-0"
        >
          {(running || status === 'running') ? (
            <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 100 16v-4l-3 3 3 3v-4a8 8 0 01-8-8z" />
            </svg>
          ) : (
            <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
            </svg>
          )}
          Run
        </button>

        <StatusIcon status={status} log={runState?.log ?? ''} />
      </div>

      {/* Code preview */}
      {preview && (
        <pre className="text-[11px] text-gray-500 font-mono bg-surface-elevated/60 rounded px-3 py-2 overflow-hidden leading-relaxed max-h-[4.5rem] select-none whitespace-pre-wrap break-all">
          {preview}
        </pre>
      )}

      {/* Captured variables (custom steps only) */}
      {!step.is_base && (
        <div className="pt-0.5">
          <CapturedVarsEditor vars={step.captured_vars} onChange={onCapturedVarsChange} />
        </div>
      )}

      {/* Action buttons */}
      {(onEdit || onDelete) && (
        <div className="flex gap-3 pt-0.5">
          {onEdit && (
            <button onClick={onEdit} className="text-xs text-gray-500 hover:text-brand-400 transition-colors">
              Edit
            </button>
          )}
          {onDelete && (
            <button onClick={onDelete} className="text-xs text-gray-500 hover:text-red-400 transition-colors">
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}
