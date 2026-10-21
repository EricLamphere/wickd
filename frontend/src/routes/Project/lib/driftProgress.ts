/** Payload of a `drift_progress` event. The scan probes models in batches; the
 *  batch range (1-based, inclusive) is absent when progress comes from the
 *  stored snapshot instead of an event. */
export interface DriftProgress {
  checked: number;
  total: number;
  current: string;
  batch_start?: number;
  batch_end?: number;
}

export function driftProgressLabel(p: DriftProgress): string {
  const model = p.current ? ` — ${p.current}` : '';
  if (p.batch_start == null || p.batch_end == null) {
    return `Checking ${p.checked} / ${p.total}${model}…`;
  }
  const range = p.batch_start === p.batch_end ? `${p.batch_start}` : `${p.batch_start}–${p.batch_end}`;
  return `Checking ${range} of ${p.total}${model}…`;
}
