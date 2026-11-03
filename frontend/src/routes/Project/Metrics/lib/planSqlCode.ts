// Which lines of a step's SELECT do that step's work, so the Debug tab can highlight the code
// rather than the comment naming the step. MetricFlow writes several steps into one SELECT and
// only names them in the comments above it; each step is found by what it reliably writes:
//   read            the semantic model's table in FROM / JOIN (its relation from the debug result)
//   metric time     the `… AS metric_time__<grain>` column, else where its date column is used
//   time range      the WHERE line with the period's dates
//   filter          the other WHERE lines
//   join, combine…  the JOIN … ON … lines
//   aggregate       the aggregate functions in the SELECT list, and GROUP BY
//   compute         the `… AS <metric>` columns
//   order & limit   ORDER BY / LIMIT
// Only the step's own lines are read (other steps' nested SELECTs are already cut out). Nothing
// found → [] and the caller falls back to the comment line. Pure; tested in planSqlCode.test.ts.
import type { DebugModelDto, PlanNodeDto } from '../../../../lib/metricDebugApi';

type Clause = 'select' | 'from' | 'join' | 'where' | 'group' | 'order' | 'other';

interface CodeLine {
  n: number;
  text: string;
  clause: Clause;
}

const CLAUSES: [RegExp, Clause][] = [
  [/^SELECT\b/, 'select'],
  [/^FROM\b/, 'from'],
  [/^((LEFT|RIGHT|FULL|INNER|CROSS)\s+)?(OUTER\s+)?JOIN\b/, 'join'],
  [/^ON\b/, 'join'],
  [/^(WHERE|HAVING|QUALIFY)\b/, 'where'],
  [/^GROUP\s+BY\b/, 'group'],
  [/^(ORDER\s+BY|LIMIT)\b/, 'order'],
];

const AGGREGATE = /\b(SUM|COUNT|AVG|MIN|MAX|MEDIAN|PERCENTILE_CONT|PERCENTILE_DISC|APPROX_COUNT_DISTINCT|APPROX_PERCENTILE|STDDEV|STDDEV_SAMP|STDDEV_POP|VARIANCE|VAR_SAMP|BOOL_OR|BOOL_AND|ANY_VALUE)\s*\(/i;
const JOIN_KINDS = new Set(['join', 'combine', 'join_over_time', 'join_time_spine', 'join_conversion']);

/** The step's code lines (comments skipped), each tagged with the clause it's in. */
function codeLines(lines: string[], ranges: [number, number][]): CodeLine[] {
  const out: CodeLine[] = [];
  let clause: Clause = 'other';
  for (const [a, b] of ranges) {
    for (let n = a; n <= b; n += 1) {
      const text = (lines[n - 1] ?? '').trim();
      if (!text || text.startsWith('--')) continue;
      const upper = text.toUpperCase();
      clause = CLAUSES.find(([re]) => re.test(upper))?.[1] ?? clause;
      out.push({ n, text, clause });
    }
  }
  return out;
}

/** A table name as text to compare: no quotes, backticks or brackets, lower case. */
function bare(text: string): string {
  return text.replace(/["`[\]]/g, '').toLowerCase();
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function dates(node: PlanNodeDto): string[] {
  return [node.time_range?.start, node.time_range?.end].filter((d): d is string => !!d).map((d) => d.slice(0, 10));
}

function readLines(node: PlanNodeDto, code: CodeLine[], models: Record<string, DebugModelDto>): CodeLine[] {
  const tables = code.filter((l) => l.clause === 'from' || l.clause === 'join');
  const relation = node.semantic_model ? models[node.semantic_model]?.relation : null;
  if (relation) return tables.filter((l) => bare(l.text).includes(bare(relation)));
  // no relation to look for: the SELECT's one plain FROM (not a subquery), when there is exactly one
  const plain = tables.filter((l) => l.clause === 'from' && !l.text.includes('(') && !l.text.startsWith(')') && !/^FROM$/i.test(l.text));
  return plain.length === 1 ? plain : [];
}

/** The 1-based lines that do node's work in its step's SELECT (`ranges`), [] when none can be told apart. */
export function codeLinesFor(node: PlanNodeDto, lines: string[], ranges: [number, number][],
  models: Record<string, DebugModelDto> = {}, plan: readonly PlanNodeDto[] = []): number[] {
  const code = codeLines(lines, ranges);
  const select = code.filter((l) => l.clause === 'select' && !/^SELECT$/i.test(l.text));
  const where = code.filter((l) => l.clause === 'where');
  let found: CodeLine[] = [];
  switch (node.kind) {
    case 'read': found = readLines(node, code, models); break;
    case 'metric_time': {
      found = select.filter((l) => /\bAS\s+metric_time__\w+/i.test(l.text));
      // not selected (a breakdown without time): where its date column is used instead
      const column = node.agg_time_dimension;
      if (!found.length && column) {
        const word = new RegExp(`\\b${escape(column)}\\b`, 'i');
        found = [...select, ...where].filter((l) => word.test(l.text));
      }
      break;
    }
    case 'constrain_time': {
      const days = dates(node);
      found = where.filter((l) => days.some((d) => l.text.includes(d)));
      if (!found.length) found = where.filter((l) => /\bBETWEEN\b/i.test(l.text));
      break;
    }
    case 'filter': {
      // the WHERE lines that aren't the period's (a time range merged into the same SELECT)
      const periodDays = plan.filter((n) => n.kind === 'constrain_time').flatMap(dates);
      found = where.filter((l) => !periodDays.some((d) => l.text.includes(d)));
      break;
    }
    case 'aggregate':
      found = [...select.filter((l) => AGGREGATE.test(l.text)), ...code.filter((l) => l.clause === 'group')];
      break;
    case 'compute': {
      const names = node.metrics ?? [];
      found = select.filter((l) => names.some((m) => new RegExp(`\\bAS\\s+${escape(m)}\\s*,?$`, 'i').test(l.text)));
      break;
    }
    case 'order_limit': found = code.filter((l) => l.clause === 'order'); break;
    default:
      if (JOIN_KINDS.has(node.kind)) found = code.filter((l) => l.clause === 'join');
  }
  return [...new Set(found.map((l) => l.n))].sort((a, b) => a - b);
}
