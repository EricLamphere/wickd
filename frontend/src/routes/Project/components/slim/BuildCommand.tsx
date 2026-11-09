import { useEffect, useState } from 'react';
import { Check, Copy, Terminal } from 'lucide-react';

const COPIED_RESET_MS = 1500;

/** The build dialog's output: the exact dbt command Build will run, copyable. */
export function BuildCommand({ command, note }: { command: string | null; note?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = () => {
    if (!command) return;
    navigator.clipboard.writeText(command).then(() => setCopied(true), () => setCopied(false));
  };
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <div className="flex items-start gap-2 px-3 py-2.5 rounded-md border border-gray-700 bg-surface-app">
        <Terminal size={13} className="mt-0.5 text-gray-500 shrink-0" />
        <code className="flex-1 min-w-0 text-xs leading-relaxed text-gray-100 whitespace-pre-wrap break-all select-text">
          {command ?? 'Waiting for the preview…'}
        </code>
        <button onClick={copy} disabled={!command} title="Copy the command"
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-gray-400 hover:bg-gray-800 hover:text-gray-200 disabled:opacity-40 shrink-0">
          {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {note && <span className="text-[11px] text-gray-500">{note}</span>}
    </div>
  );
}
