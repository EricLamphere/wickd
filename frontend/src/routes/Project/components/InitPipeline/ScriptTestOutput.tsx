import type { ScriptTestResultDto } from '../../../../lib/api';

const MAX_VALUE_PREVIEW = 80;

function preview(value: string): string {
  const oneLine = value.replace(/\n/g, '⏎');
  return oneLine.length > MAX_VALUE_PREVIEW ? `${oneLine.slice(0, MAX_VALUE_PREVIEW)}…` : oneLine;
}

function headline(result: ScriptTestResultDto): string {
  if (result.timed_out) return 'Timed out';
  return result.ok ? 'Passed' : `Failed (exit ${result.return_code})`;
}

interface ScriptTestOutputProps {
  result: ScriptTestResultDto | null;
  running: boolean;
  error: string | null;
}

/** Result of a test run in the script editor: status, output, and which captured vars the script set. */
export function ScriptTestOutput({ result, running, error }: ScriptTestOutputProps) {
  if (!running && !result && !error) return null;

  const tone = running || !result
    ? 'border-blue-900/60 bg-blue-950/20'
    : result.ok
      ? 'border-green-900/60 bg-green-950/20'
      : 'border-red-900/60 bg-red-950/20';
  const capturedEntries = result ? Object.entries(result.captured) : [];

  return (
    <div className={`flex flex-col gap-2 rounded border px-3 py-2 ${error ? 'border-red-900/60 bg-red-950/20' : tone}`}>
      <div className="flex items-center gap-2 text-xs">
        {running && <span className="font-medium text-blue-300">Running test…</span>}
        {!running && error && <span className="font-medium text-red-400">{error}</span>}
        {!running && !error && result && (
          <>
            <span className={`font-medium ${result.ok ? 'text-green-400' : 'text-red-400'}`}>{headline(result)}</span>
            <span className="text-gray-600">{(result.duration_ms / 1000).toFixed(1)}s</span>
            <span className="ml-auto text-[10px] text-gray-600">Test run only. Nothing was saved.</span>
          </>
        )}
      </div>

      {!running && !error && result && (
        <>
          <pre className="max-h-48 overflow-auto rounded bg-surface-elevated/70 px-2.5 py-2 text-[11px] font-mono text-gray-300 whitespace-pre-wrap break-all leading-relaxed">
            {result.log || 'No output.'}
          </pre>

          {(capturedEntries.length > 0 || result.missing.length > 0) && (
            <div className="flex flex-col gap-1 text-[11px] font-mono">
              {capturedEntries.map(([key, value]) => (
                <div key={key} className="flex gap-2 min-w-0">
                  <span className="text-green-400 shrink-0">✓ {key}</span>
                  <span className="text-gray-500 truncate">= {preview(value)}</span>
                </div>
              ))}
              {result.missing.map((key) => (
                <span key={key} className="text-amber-400">! {key} was not exported by the script</span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
