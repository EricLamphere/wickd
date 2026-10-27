interface DumbbellProps {
  /** usual value (e.g. median) */
  from: number;
  /** current value */
  to: number;
  /** shared scale across rows, so dumbbells compare */
  max: number;
  width?: number;
  title?: string;
}

/** Usual → now on a shared scale: a grey dot, a bar, and an amber (slower) or green (faster) dot. */
export function Dumbbell({ from, to, max, width = 150, title }: DumbbellProps) {
  const pad = 5;
  const scale = (v: number) => pad + (Math.max(0, Math.min(v, max)) / (max || 1)) * (width - pad * 2);
  const a = scale(from);
  const b = scale(to);
  const slower = to >= from;
  return (
    <svg width={width} height={14} role="img" aria-label={title} className="overflow-visible">
      {title && <title>{title}</title>}
      <line x1={pad} x2={width - pad} y1={7} y2={7} className="stroke-gray-800" strokeWidth={2} strokeLinecap="round" />
      <line x1={a} x2={b} y1={7} y2={7} className={slower ? 'stroke-amber-500/70' : 'stroke-emerald-500/70'} strokeWidth={3} strokeLinecap="round" />
      <circle cx={a} cy={7} r={3.5} className="fill-gray-500" />
      <circle cx={b} cy={7} r={4} className={slower ? 'fill-amber-400' : 'fill-emerald-400'} />
    </svg>
  );
}
