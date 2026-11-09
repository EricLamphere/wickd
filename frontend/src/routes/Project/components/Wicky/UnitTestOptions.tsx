import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { aiApi, type UnitTestRequest } from '../../../../lib/aiApi';
import { focusFromSelection } from '../../lib/unitTests';
import type { FocusHint } from '../../lib/wickyEvents';
import { UnitTestFilePicker, rememberFile } from './UnitTestFilePicker';

interface UnitTestOptionsProps {
  projectId: number;
  uniqueId: string;
  /** SQL selected in Files ("Unit test this logic…"), to preselect the focus */
  focusHint?: FocusHint;
  onStart: (options: UnitTestRequest) => void;
  onCancel: () => void;
}

const WHOLE = '';

/** Choose what a generated unit test covers (the whole model, a CTE or a CASE column),
 *  whether to mask text values, and which file it's written to (remembered per model). */
export function UnitTestOptions({ projectId, uniqueId, focusHint, onStart, onCancel }: UnitTestOptionsProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['unit-test-focus', projectId, uniqueId],
    queryFn: () => aiApi.unitTestFocusOptions(projectId, uniqueId),
    staleTime: 30_000,
  });
  const options = data?.options ?? [];
  const [focus, setFocus] = useState(WHOLE);
  const [mask, setMask] = useState(false);
  const [file, setFile] = useState<string | null>(null);

  useEffect(() => {
    if (focusHint && options.length > 0) setFocus(focusFromSelection(options, focusHint.selection, focusHint.before) ?? WHOLE);
  }, [focusHint, options.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="flex flex-col gap-2 p-2 rounded border border-gray-700 bg-surface-elevated/60"
      onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
    >
      <span className="text-gray-400">
        Wicky picks a few real rows per input that hit each branch, runs the model on them, and proposes a
        unit test with what it produces today. Review the rows before accepting.
      </span>
      <label className="flex flex-col gap-1">
        <span className="text-gray-500">Logic to cover</span>
        <select
          autoFocus
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
          className="px-2 py-1 rounded bg-surface-panel border border-gray-700 text-gray-200 focus:outline-none focus:border-brand-500"
        >
          <option value={WHOLE}>The whole model</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        {isLoading && <span className="flex items-center gap-1 text-gray-500"><Loader2 size={11} className="animate-spin" />Reading the SQL…</span>}
        {data && !data.compiled && <span className="text-gray-500">Compile the model to pick a CTE or CASE column.</span>}
      </label>
      <label className="flex items-start gap-2 text-gray-300">
        <input type="checkbox" checked={mask} onChange={(e) => setMask(e.target.checked)} className="mt-0.5" />
        <span>
          Mask text values
          <span className="block text-gray-500">Sampled rows are written to your repo. Masking swaps text for stable fakes (join keys still match); dates, numbers and values the SQL compares stay.</span>
        </span>
      </label>
      <UnitTestFilePicker projectId={projectId} uniqueId={uniqueId} onChange={setFile} />
      <div className="flex items-center justify-end gap-2">
        <button onClick={onCancel} className="px-2 py-0.5 text-gray-500 hover:text-gray-300">Cancel</button>
        <button
          onClick={() => {
            rememberFile(projectId, uniqueId, file);
            onStart({ focus: focus || null, mask, file });
          }}
          className="px-2.5 py-1 rounded bg-brand-600 text-white hover:bg-brand-500"
        >
          Generate unit test
        </button>
      </div>
    </div>
  );
}
