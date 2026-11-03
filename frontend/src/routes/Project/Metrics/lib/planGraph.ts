// Debug tab: MetricFlow's plan drawn as a small left-to-right graph (dagre), and where each step
// sits in MetricFlow's full SQL so clicking a step can highlight it. MetricFlow writes several
// steps into one SELECT (listing them in the comments above it); a step without its own SELECT
// is in the SELECT of the step it feeds. Pure; tested in planGraph.test.ts.
import dagre from 'dagre';
import type { DebugResultDto, PlanNodeDto } from '../../../../lib/metricDebugApi';
import { codeLinesFor } from './planSqlCode';

export const PLAN_NODE_W = 150;
export const PLAN_NODE_H = 48;

export interface PlacedNode {
  id: string;
  x: number;
  y: number;
}

export interface PlanLayout {
  width: number;
  height: number;
  nodes: PlacedNode[];
  /** each edge as its points, source → target */
  edges: { from: string; to: string; points: { x: number; y: number }[] }[];
}

/** Top-left corners for each node and the edges' points, with `pad` around the graph. */
export function layoutPlan(plan: readonly PlanNodeDto[], pad = 8): PlanLayout {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', ranksep: 26, nodesep: 12, marginx: pad, marginy: pad });
  const ids = new Set(plan.map((n) => n.id));
  for (const n of plan) g.setNode(n.id, { width: PLAN_NODE_W, height: PLAN_NODE_H });
  for (const n of plan) for (const input of n.inputs) if (ids.has(input)) g.setEdge(input, n.id);
  dagre.layout(g);
  const graph = g.graph();
  return {
    width: Math.ceil(graph.width ?? 0),
    height: Math.ceil(graph.height ?? 0),
    nodes: plan.map((n) => {
      const p = g.node(n.id);
      return { id: n.id, x: p.x - PLAN_NODE_W / 2, y: p.y - PLAN_NODE_H / 2 };
    }),
    edges: g.edges().map((e) => ({ from: e.v, to: e.w, points: g.edge(e).points.map((pt) => ({ x: pt.x, y: pt.y })) })),
  };
}

/** The SQL step a node is written in: its own, else (merged) the one of the step it feeds into. */
export function stepIndexFor(plan: readonly PlanNodeDto[], id: string): number | null {
  const byId = new Map(plan.map((n) => [n.id, n]));
  const seen = new Set<string>();
  let frontier = [id];
  while (frontier.length) {
    const next: string[] = [];
    for (const cur of frontier) {
      if (seen.has(cur)) continue;
      seen.add(cur);
      const node = byId.get(cur);
      if (node?.step != null) return node.step;
      for (const n of plan) if (n.inputs.includes(cur)) next.push(n.id);
    }
    frontier = next;
  }
  return null;
}

export interface SqlSpan {
  /** 1-based, inclusive: the step's SELECT with the comments above it */
  start: number;
  end: number;
  /** [start, end] line ranges to highlight: the span minus the other steps' SELECTs nested in it */
  ranges: [number, number][];
  /** the comment line naming this step, when one does */
  focus: number | null;
  /** the lines doing this step's work (planSqlCode.ts); [] → show `focus` instead */
  code: number[];
}

const isComment = (line: string) => line.trim().startsWith('--');

/** A step's lines in the full SQL: its comments + SELECT, and the SELECT's first line. */
function stepLines(sql: string, lines: string[], step: { labels: string[]; sql: string }): { start: number; first: number; end: number } | null {
  const body = step.sql.split('\n').slice(step.labels.length).join('\n');
  const at = body ? sql.indexOf(body) : -1;
  if (at < 0) return null;
  const first = sql.slice(0, at).split('\n').length; // 1-based line of the SELECT
  let start = first;
  while (start > 1 && isComment(lines[start - 2])) start -= 1;
  return { start, first, end: first + body.split('\n').length - 1 };
}

/** [start, end] minus the holes, as ranges. */
function without(start: number, end: number, holes: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let cur = start;
  for (const [a, b] of [...holes].sort((x, y) => x[0] - y[0])) {
    if (b < cur || a > end) continue;
    if (a > cur) out.push([cur, a - 1]);
    cur = Math.max(cur, b + 1);
  }
  if (cur <= end) out.push([cur, end]);
  return out;
}

/** Where node `id` is in the full SQL (null when its step can't be found there). */
export function sqlSpanFor(result: Pick<DebugResultDto, 'sql' | 'steps' | 'plan'> & { models?: DebugResultDto['models'] }, id: string): SqlSpan | null {
  const node = result.plan.find((n) => n.id === id);
  const index = stepIndexFor(result.plan, id);
  const step = index === null ? undefined : result.steps.find((s) => s.index === index);
  if (!node || !step) return null;
  const lines = result.sql.split('\n');
  const own = stepLines(result.sql, lines, step);
  if (!own) return null;
  const { start, first, end } = own;
  // other steps' SELECTs inside this one are theirs, not this step's
  const holes = result.steps
    .filter((s) => s.index !== step.index)
    .map((s) => stepLines(result.sql, lines, s))
    .filter((r): r is NonNullable<typeof r> => !!r && r.start > start && r.end <= end)
    .map((r): [number, number] => [r.start, r.end]);
  const label = node.label.toLowerCase();
  const model = node.semantic_model ? `'${node.semantic_model.toLowerCase()}'` : null;
  let focus: number | null = null;
  for (let n = start; n < first; n += 1) {
    const text = lines[n - 1].replace(/^\s*--\s*/, '').trim().toLowerCase();
    if (text === label) { focus = n; break; }
    if (focus === null && node.kind === 'read' && model && text.startsWith('read') && text.includes(model)) focus = n;
  }
  const ranges = without(start, end, holes);
  return { start, end, ranges, focus, code: codeLinesFor(node, lines, ranges, result.models ?? {}, result.plan) };
}
