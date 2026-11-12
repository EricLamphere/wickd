import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { logLineTone, type LogTone } from '../../../../lib/logLineTone';

interface LogViewProps {
  /** The file being shown, in the toolbar. */
  pathLabel: string;
  lines: readonly string[];
  isLoading: boolean;
  emptyLabel?: string;
  onClear: () => void;
  onRefresh: () => void;
}

/** A log file tail with live lines appended: toolbar (clear, refresh) and auto-scroll. */
export function LogView({ pathLabel, lines, isLoading, emptyLabel = 'No log entries yet.', onClear, onRefresh }: LogViewProps) {
  const logsEndRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll) logsEndRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [lines.length, autoScroll]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1 border-b border-gray-800 shrink-0">
        <span className="text-[10px] text-gray-600 font-mono">{pathLabel}</span>
        <div className="flex items-center gap-2">
          {!autoScroll && (
            <button
              onClick={() => {
                setAutoScroll(true);
                logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
              }}
              className="text-[10px] text-brand-400 hover:text-brand-300 transition-colors"
            >
              ↓ Scroll to bottom
            </button>
          )}
          <button onClick={onClear} className="text-gray-600 hover:text-red-400 transition-colors" title="Clear log file">
            <Trash2 className="w-3 h-3" />
          </button>
          <button onClick={onRefresh} className="text-[10px] text-gray-600 hover:text-gray-300 transition-colors" title="Refresh">
            ↺ Refresh
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto font-mono text-xs p-3 bg-surface-app text-gray-400 leading-relaxed" onScroll={handleScroll}>
        {isLoading && <span className="text-gray-600">Loading…</span>}
        {!isLoading && lines.length === 0 && <span className="text-gray-600">{emptyLabel}</span>}
        {lines.map((line, i) => <LogLine key={i} line={line} />)}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}

const TONE_CLASS: Record<LogTone, string> = {
  error: 'text-red-400',
  warn: 'text-amber-400',
  success: 'text-green-400',
  accent: 'text-brand-300',
};

function LogLine({ line }: { line: string }) {
  const tone = logLineTone(line);
  return <div className={tone ? TONE_CLASS[tone] : undefined}>{line}</div>;
}
