import { DURATION_CLASS, DURATION_LEGEND } from '../lib/durationOverlay';

export default function DurationLegend({ empty }: { empty: boolean }) {
  return (
    <div className="flex items-center gap-3 px-3 py-1.5 rounded-full bg-zinc-800/90 border border-zinc-700 text-[10px] text-zinc-400 shadow-lg">
      {empty ? (
        <span>No run timings yet. Run or build models to see durations.</span>
      ) : (
        <>
          <span className="text-zinc-500">Median run time vs. same type:</span>
          {DURATION_LEGEND.map(({ bucket, label }) => (
            <span key={bucket} className="flex items-center gap-1">
              <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${DURATION_CLASS[bucket].dot}`} />
              {label}
            </span>
          ))}
        </>
      )}
    </div>
  );
}
