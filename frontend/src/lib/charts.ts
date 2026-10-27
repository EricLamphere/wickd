/** Pure geometry for the small SVG charts in components/charts/. */

export interface Point {
  x: number;
  y: number;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** A round axis maximum at or above `value` (1, 2, 2.5, 5 × 10^n). */
export function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * exp >= value) ?? 10;
  return step * exp;
}

/**
 * Points for `values` in a `width` × `height` box (y grows down), scaled to
 * 0..`max` (default: the largest value) with `pad` px inside each edge.
 */
export function plotPoints(values: readonly number[], width: number, height: number, pad = 2, max?: number): Point[] {
  if (values.length === 0) return [];
  const top = max ?? Math.max(...values);
  const yMax = top > 0 ? top : 1;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  return values.map((v, i) => ({
    x: pad + (values.length === 1 ? innerW / 2 : (i / (values.length - 1)) * innerW),
    y: pad + (1 - Math.max(0, Math.min(v, yMax)) / yMax) * innerH,
  }));
}

export function linePath(points: readonly Point[]): string {
  return points.map((p, i) => `${i ? 'L' : 'M'}${round(p.x)},${round(p.y)}`).join(' ');
}

/** The line closed down to `baseline` (the chart's bottom), for an area fill. */
export function areaPath(points: readonly Point[], baseline: number): string {
  if (points.length === 0) return '';
  const first = points[0];
  const last = points[points.length - 1];
  return `${linePath(points)} L${round(last.x)},${round(baseline)} L${round(first.x)},${round(baseline)} Z`;
}

/** Index of the point nearest to x (for hover readouts). */
export function nearestIndex(points: readonly Point[], x: number): number {
  let best = 0;
  for (let i = 1; i < points.length; i++) {
    if (Math.abs(points[i].x - x) < Math.abs(points[best].x - x)) best = i;
  }
  return best;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
