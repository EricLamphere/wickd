import { Plus, Trash2 } from 'lucide-react';
import type { GlobalEnvVarDto } from '../../lib/api';
import { InlineCode, StepHeading } from './fields';
import type { StepProps } from './types';

const EMPTY_ROW: GlobalEnvVarDto = { key: '', value: '' };

const INPUT_CLASS =
  'px-2 py-1.5 bg-surface-elevated border border-gray-700 rounded font-mono text-xs text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-brand-500';

/** Wizard step: global (default) env vars, applied to global setup's pip install and every project. */
export function EnvVarsStep({ form, update, error }: StepProps) {
  const saved = form.envVars ?? [];
  // Always show at least one row to type into; a blank row is dropped on save.
  const rows = saved.length > 0 ? saved : [EMPTY_ROW];

  const setRow = (index: number, patch: Partial<GlobalEnvVarDto>) =>
    update({ envVars: rows.map((row, i) => (i === index ? { ...row, ...patch } : row)) });
  const removeRow = (index: number) => update({ envVars: rows.filter((_, i) => i !== index) });
  const addRow = () => update({ envVars: [...rows, EMPTY_ROW] });

  return (
    <>
      <StepHeading title="Default environment variables (optional)">
        Variables every project runs with, e.g. <InlineCode className="text-gray-300">PIP_INDEX_URL</InlineCode> for a
        private package index or warehouse credentials your <InlineCode className="text-gray-300">profiles.yml</InlineCode>{' '}
        reads.
      </StepHeading>

      <div className="flex flex-col gap-2 px-3 py-2.5 mb-4 bg-surface-elevated border border-gray-800 rounded text-xs text-gray-400 leading-relaxed">
        <p>These are set when global setup runs pip install at the end of this wizard, and for every dbt and init run.</p>
        <p>
          If a variable also appears in a project's <span className="text-gray-200">active profile</span>, the profile's
          value wins. <span className="text-gray-200">Project environment variables</span> take priority over both.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              value={row.key}
              onChange={(e) => setRow(i, { key: e.target.value })}
              placeholder="KEY"
              spellCheck={false}
              aria-label="Variable name"
              className={`w-48 shrink-0 ${INPUT_CLASS}`}
            />
            <span className="text-xs text-gray-600">=</span>
            <input
              value={row.value}
              onChange={(e) => setRow(i, { value: e.target.value })}
              placeholder="value"
              spellCheck={false}
              aria-label="Variable value"
              className={`flex-1 min-w-0 ${INPUT_CLASS}`}
            />
            <button
              type="button"
              onClick={() => removeRow(i)}
              title="Remove"
              className="p-1 text-gray-600 hover:text-red-400 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      <button
        type="button"
        onClick={addRow}
        className="flex items-center gap-1.5 mt-3 text-xs text-gray-500 hover:text-gray-300"
      >
        <Plus className="w-3 h-3" />
        Add variable
      </button>
      <p className="mt-4 text-xs text-gray-500">Change these any time in Global Settings → Profiles.</p>
    </>
  );
}
