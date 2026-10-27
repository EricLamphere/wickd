interface MeterBarProps {
  value: number;
  max: number;
  /** Tailwind background class for the filled part. */
  tone?: string;
  className?: string;
  title?: string;
}

/** A thin horizontal bar: `value` as a share of `max`. */
export function MeterBar({ value, max, tone = 'bg-brand-500', className = 'w-20', title }: MeterBarProps) {
  const pct = max > 0 ? Math.max(2, Math.min(100, (value / max) * 100)) : 0;
  return (
    <span className={`inline-block h-1.5 rounded-full bg-gray-800 overflow-hidden align-middle ${className}`} title={title}>
      <span className={`block h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
    </span>
  );
}
