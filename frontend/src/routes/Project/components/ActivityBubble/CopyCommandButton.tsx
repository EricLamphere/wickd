import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { alertError } from '../../../../lib/dialogs';

const COPIED_MS = 1500;

/** Copies a dbt command from an activity row; a check mark confirms it. */
export function CopyCommandButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard access is not available here.');
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch (err) {
      await alertError(new Error(`Couldn't copy the command: ${err instanceof Error ? err.message : String(err)}`));
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? 'Copied' : 'Copy command'}
      aria-label={copied ? 'Copied' : `Copy command: ${command}`}
      className="shrink-0 p-1 rounded text-gray-500 hover:bg-gray-700 hover:text-gray-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-400"
    >
      {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}
