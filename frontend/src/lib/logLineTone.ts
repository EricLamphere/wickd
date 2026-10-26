export type LogTone = 'error' | 'warn' | 'success' | 'accent';

// dbt's end-of-run summary: "Done. PASS=2 WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=2"
const SUMMARY_COUNT = /\b(PASS|WARN|ERROR|SKIP)=(\d+)/g;
// "Completed with 1 error, 0 partial successes, and 2 warnings:"
const COMPLETED_WITH = /Completed with (\d+) errors?.*?(\d+) warnings?/;

function summaryTone(line: string): LogTone | null {
  const counts = new Map([...line.matchAll(SUMMARY_COUNT)].map((m) => [m[1], Number(m[2])]));
  if (counts.size < 2) return null;
  if ((counts.get('ERROR') ?? 0) > 0) return 'error';
  if ((counts.get('WARN') ?? 0) > 0 || (counts.get('SKIP') ?? 0) > 0) return 'warn';
  return 'success';
}

/** How to color one line of dbt output: summaries by their counts, other lines by keyword. */
export function logLineTone(line: string): LogTone | null {
  const summary = summaryTone(line);
  if (summary) return summary;
  const completed = COMPLETED_WITH.exec(line);
  if (completed) {
    if (Number(completed[1]) > 0) return 'error';
    return Number(completed[2]) > 0 ? 'warn' : 'success';
  }
  if (/\b(ERROR|FAIL|FAILED)\b/.test(line) || /\berror\b/i.test(line)) return 'error';
  if (/\bWARN(ING)?\b/.test(line) || /\bwarn(ing)?\b/.test(line)) return 'warn';
  if (/\b(OK|PASS|SUCCESS)\b/.test(line) || /\bsuccess(ful(ly)?)?\b/i.test(line)) return 'success';
  if (line.includes('>>>') || line.includes('===') || line.includes('---')) return 'accent';
  return null;
}
