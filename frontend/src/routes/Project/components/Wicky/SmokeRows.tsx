// A drafted metric's smoke query (LIMIT 5, run before review): what the metric returns today.
import type { SemanticDraftItem } from '../../../../lib/aiApi';

function cell(value: unknown): string {
  if (value == null) return '∅';
  const text = String(value).replace(/T00:00:00$| 00:00:00$/, '');
  return typeof value === 'number' && !Number.isInteger(value) ? String(Math.round(value * 1000) / 1000) : text;
}

/** The rows as one compact line each ("2026-10-27 · 412.5"); errors in amber.
 *  `summary`: just "✓ returns N rows" (chat history, where every metric is listed). */
export function SmokeRows({ smoke, summary = false }: { smoke: SemanticDraftItem['smoke']; summary?: boolean }) {
  if (!smoke) return null;
  if ('error' in smoke) {
    return <span className="block mt-0.5 text-amber-400 break-words line-clamp-3" title={smoke.error}>✗ {smoke.error}</span>;
  }
  if (smoke.rows.length === 0) return <span className="block mt-0.5 text-amber-400">✓ runs, but returned no rows</span>;
  if (summary) return <span className="ml-1 text-emerald-400">✓ returns rows</span>;
  return (
    <span className="block mt-0.5 font-mono text-[10px] text-gray-500">
      <span className="text-emerald-400 font-sans text-xs">✓ returns</span>
      {smoke.rows.map((row, i) => <span key={i} className="block">{row.map(cell).join(' · ')}</span>)}
    </span>
  );
}
