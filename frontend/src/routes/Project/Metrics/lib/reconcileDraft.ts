// Debug tab → Reconcile with SQL: the starting query, written by hand from what the debug run
// resolved — the metric's formula (simple / ratio / derived), each input's table, expression,
// aggregation and filter, and the group-by expressions — so it runs as-is and independently of
// MetricFlow. Metrics it can't write (cumulative, conversion, offsets, inputs on several tables)
// get a skeleton with … placeholders, which Run refuses until they're replaced.
// Never contains Jinja, not even in comments: dbt renders `{{ … }}` in comments too.
// Unit-tested in reconcileDraft.test.ts.
import type { DebugInputDto, DebugResultDto } from '../../../../lib/metricDebugApi';
import type { MetricQueryBody } from '../../../../lib/semanticApi';

export const PLACEHOLDER = '…';
const AGG_SQL: Record<string, (expr: string) => string> = {
  sum: (e) => `sum(${e})`,
  count: (e) => `count(${e})`,
  count_distinct: (e) => `count(distinct ${e})`,
  average: (e) => `avg(${e})`,
  avg: (e) => `avg(${e})`,
  min: (e) => `min(${e})`,
  max: (e) => `max(${e})`,
  sum_boolean: (e) => `sum(case when ${e} then 1 else 0 end)`,
};
const GRAINS = ['day', 'week', 'month', 'quarter', 'year'];
const MAX_DEPTH = 10;

class CannotDraft extends Error {}

/** MetricFlow filter templates as readable text: {{ Dimension('order__status') }} → order__status. */
export function withoutJinja(text: string): string {
  return text
    .replace(/\{\{\s*(?:Dimension|TimeDimension|Entity|Metric)\(\s*['"]([^'"]+)['"][^}]*\}\}/g, '$1')
    .replace(/\{\{|\}\}|\{%|%\}|\{#|#\}/g, '');
}

/** True while the SQL still has the skeleton's … placeholders (outside comments). */
export function hasPlaceholders(sql: string): boolean {
  return sql.split('\n').some((line) => line.replace(/--.*$/, '').includes(PLACEHOLDER));
}

function grainOf(name: string): string | null {
  const last = name.split('__').pop() ?? '';
  return GRAINS.includes(last) ? last : null;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The aggregate SQL for `metric` over one table, following its definition down to simple inputs. */
function metricSql(result: DebugResultDto, metric: string, used: DebugInputDto[], depth = 0): string {
  const def = result.metric_defs?.[metric];
  if (!def || depth > MAX_DEPTH) throw new CannotDraft(`no definition for ${metric}`);
  if (def.type === 'simple') {
    const matches = result.inputs.filter((i) => i.metric === metric);
    const input = matches[0];
    const agg = input?.agg ? AGG_SQL[input.agg] : undefined;
    if (matches.length !== 1 || !agg) throw new CannotDraft(`can't write ${metric}'s aggregation`);
    if (input.filters.length && !input.filter_sql) throw new CannotDraft(`${metric}'s filter needs a join`);
    used.push(input);
    return agg(input.filter_sql ? `case when ${input.filter_sql} then ${input.expr} end` : input.expr);
  }
  if (def.inputs.some((i) => i.offset)) throw new CannotDraft(`${metric} uses an offset`);
  if (def.type === 'ratio') {
    const num = def.inputs.find((i) => i.role === 'numerator');
    const den = def.inputs.find((i) => i.role === 'denominator');
    if (!num || !den) throw new CannotDraft(`${metric} lacks a numerator or denominator`);
    return `1.0 * ${metricSql(result, num.name, used, depth + 1)} / nullif(${metricSql(result, den.name, used, depth + 1)}, 0)`;
  }
  if (def.type === 'derived' && def.expr) {
    const parts = new Map(def.inputs.map((i) => [i.alias ?? i.name, metricSql(result, i.name, used, depth + 1)]));
    const names = [...parts.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
    if (!names.length) throw new CannotDraft(`${metric} has no inputs`);
    return def.expr.replace(new RegExp(`\\b(${names.join('|')})\\b`, 'g'), (name) => `(${parts.get(name)})`);
  }
  throw new CannotDraft(`${def.type} metrics aren't drafted`);
}

function skeleton(columns: string[], keys: string[], relation: string | null, why: string): string {
  const select = columns.map((c, i) => `  ${i ? ', ' : ''}${PLACEHOLDER} as ${c}`).join('\n');
  return [
    '-- A plain query that should return the same numbers as the metric.',
    `-- Couldn't write it for you (${why}): replace each ${PLACEHOLDER} with SQL.`,
    "-- Tables: write the relation, or use ref('model') / source('src', 'table') wrapped in double braces.",
    'select',
    select,
    `from ${relation ?? PLACEHOLDER}`,
    keys.length ? `group by ${keys.map((_, i) => i + 1).join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

/** The starter SQL for Reconcile. */
export function reconcileDraft(body: MetricQueryBody, result: DebugResultDto | undefined): string {
  const metrics = body.metrics ?? [];
  const columns = result?.columns.length ? result.columns : [...(body.group_by ?? []), ...metrics];
  const keys = columns.filter((c) => !metrics.includes(c));
  const firstModel = result?.inputs[0]?.semantic_model;
  const relation = (firstModel && result?.models?.[firstModel]?.relation) || null;
  if (!result) return skeleton(columns, keys, relation, 'the checks haven\'t loaded yet');
  const used: DebugInputDto[] = [];
  let metricExprs: string[];
  try {
    metricExprs = metrics.map((m) => metricSql(result, m, used));
  } catch (err) {
    return skeleton(columns, keys, relation, err instanceof CannotDraft ? err.message : 'unexpected definition');
  }
  const tables = new Set(used.map((i) => i.semantic_model));
  const timeDims = new Set(used.map((i) => i.agg_time_dimension));
  if (tables.size !== 1 || timeDims.size !== 1) {
    return skeleton(columns, keys, relation, tables.size !== 1 ? 'its inputs read several tables' : 'its inputs use different time dimensions');
  }
  const modelName = used[0].semantic_model!;
  const model = result.models[modelName];
  if (!model?.relation) return skeleton(columns, keys, relation, 'the table is unknown');
  const timeExpr = model.dimensions.find((d) => d.name === used[0].agg_time_dimension)?.expr;
  const groupBy = new Map(result.group_by.map((g) => [g.name, g]));
  const keyExprs = keys.map((key) => {
    const g = groupBy.get(key);
    const grain = grainOf(key);
    const expr = g?.kind === 'metric_time' ? timeExpr : g?.semantic_model === modelName ? g.expr : undefined;
    if (!expr) return `${PLACEHOLDER} /* ${key}: from ${g?.semantic_model ?? 'another model'}, join it in */`;
    return grain ? `date_trunc('${grain}', ${expr})` : expr;
  });
  const where: string[] = [];
  if (timeExpr && body.start) where.push(`${timeExpr} >= '${body.start}'`);
  if (timeExpr && body.end) where.push(`${timeExpr} <= '${body.end}'`);
  const queryFilters = (body.where ?? []).map(withoutJinja);
  return [
    `-- ${metrics.join(', ')} written by hand from ${modelName}, without MetricFlow.`,
    ...(queryFilters.length ? [`-- Add the query's filters as conditions: ${queryFilters.join(' AND ')}`] : []),
    'select',
    ...keyExprs.map((e, i) => `  ${i ? ', ' : ''}${e} as ${keys[i]}`),
    ...metricExprs.map((e, i) => `  ${keyExprs.length || i ? ', ' : ''}${e} as ${metrics[i]}`),
    `from ${model.relation}`,
    ...(where.length ? [`where ${where.join('\n  and ')}`] : []),
    ...(keys.length ? [`group by ${keys.map((_, i) => i + 1).join(', ')}`] : []),
  ].join('\n');
}
