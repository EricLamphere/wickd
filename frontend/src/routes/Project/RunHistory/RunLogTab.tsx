// The Runs page detail panel's Log tab: the invocation's captured dbt output, colored by line
// (ANSI codes stripped), with Copy and Download (written by POST /exports/log, since the desktop
// webview has no download manager).
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, Download } from 'lucide-react';
import { api, type RunInvocationDto } from '../../../lib/api';
import { stripAnsi } from '../../../lib/ansi';
import { alertError } from '../../../lib/dialogs';
import { logLineTone, type LogTone } from '../../../lib/logLineTone';
import { ExportChartModal } from '../Metrics/chartMenu/ExportChartModal';
import { runLogFilename, runLogText } from './runLog';

const RUN_LOG_TONE_CLASS: Record<LogTone | 'none', string> = {
  error: 'text-red-400',
  warn: 'text-amber-400',
  success: 'text-emerald-400',
  accent: '',
  none: '',
};

const COPIED_MS = 1500;
const TOOL_BUTTON = 'flex items-center gap-1 px-2 py-1 text-xs rounded bg-surface-elevated hover:bg-gray-700 text-gray-400 hover:text-gray-200 disabled:opacity-40 transition-colors';

interface RunLogTabProps {
  projectId: number;
  invocation: RunInvocationDto;
}

export function RunLogTab({ projectId, invocation }: RunLogTabProps) {
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const { data, isLoading } = useQuery<{ lines: string[] }>({
    queryKey: ['run-invocation-log', projectId, invocation.id],
    queryFn: () => api.runHistory.log(projectId, invocation.id),
  });

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const lines = data?.lines ?? [];
  const text = runLogText(invocation.cli_command, lines);

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard access is not available here.');
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (err) {
      await alertError(new Error(`Couldn't copy the log: ${err instanceof Error ? err.message : String(err)}`));
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="shrink-0 flex items-center justify-end gap-1.5 px-4 py-1.5 border-b border-gray-800 bg-surface-app">
        <button onClick={copy} disabled={lines.length === 0} title="Copy the log" className={TOOL_BUTTON}>
          {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button onClick={() => setDownloading(true)} disabled={lines.length === 0} title="Save the log to a file" className={TOOL_BUTTON}>
          <Download className="w-3 h-3" />Download
        </button>
      </div>
      <div className="flex-1 overflow-auto bg-surface-app font-mono text-xs text-gray-300 p-4">
        {invocation.cli_command && (
          <div className="mb-3 pb-3 border-b border-gray-800">
            <span className="text-gray-500">$ </span>
            <span className="text-brand-300">{invocation.cli_command}</span>
          </div>
        )}
        {isLoading ? (
          <span className="text-gray-500">Loading…</span>
        ) : lines.length === 0 ? (
          <span className="text-gray-500">No log captured for this invocation.</span>
        ) : (
          lines.map((line, i) => (
            <div key={i} className={`whitespace-pre leading-5 ${RUN_LOG_TONE_CLASS[logLineTone(line) ?? 'none']}`}>
              {stripAnsi(line)}
            </div>
          ))
        )}
      </div>
      {downloading && (
        <ExportChartModal
          projectId={projectId}
          format="log"
          defaultName={runLogFilename(invocation.command, invocation.id)}
          render={async () => ({ content: text, encoding: 'utf8' })}
          onClose={() => setDownloading(false)}
        />
      )}
    </div>
  );
}
