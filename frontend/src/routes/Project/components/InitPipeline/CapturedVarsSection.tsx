import { useState } from 'react';
import type { ScriptTestResultDto } from '../../../../lib/api';
import { detectExports, normalizeVarName } from './capturedVars';

const MAX_VALUE_PREVIEW = 60;

function preview(value: string): string {
  const oneLine = value.replace(/\n/g, '⏎');
  return oneLine.length > MAX_VALUE_PREVIEW ? `${oneLine.slice(0, MAX_VALUE_PREVIEW)}…` : oneLine;
}

interface CapturedVarsSectionProps {
  vars: string[];
  onChange: (vars: string[]) => void;
  /** Current editor text, scanned for `export` lines to suggest. */
  script: string;
  /** Last test run, to show per-variable whether the script exported it. */
  testResult: ScriptTestResultDto | null;
}

/**
 * The script editor's "save exported variables" section: what capturing does,
 * the variables captured so far (with the last test's result for each), the
 * script's own exports as one-click suggestions, and an always-visible input.
 * Every button is type="button" so it never submits the modal's form.
 */
export function CapturedVarsSection({ vars, onChange, script, testResult }: CapturedVarsSectionProps) {
  const [draft, setDraft] = useState('');
  const suggestions = detectExports(script).filter((name) => !vars.includes(name));
  const draftName = normalizeVarName(draft);
  const canAdd = draftName !== '' && !vars.includes(draftName);

  const add = (name: string) => {
    if (name && !vars.includes(name)) onChange([...vars, name]);
  };

  const submitDraft = () => {
    if (!canAdd) return;
    add(draftName);
    setDraft('');
  };

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-gray-800 bg-surface-elevated/30 px-4 py-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-xs font-semibold text-gray-200">Save exported variables to the project</h3>
        <p className="text-xs text-gray-500 leading-relaxed">
          After each successful run, the variables listed here are read from the script's{' '}
          <code className="font-mono text-gray-400">export</code>s and saved as project env vars, so later
          steps and every dbt command can use them. Variables the script doesn't export are skipped.
        </p>
      </div>

      {vars.length > 0 && (
        <ul className="flex flex-col divide-y divide-gray-800 rounded border border-gray-800 bg-surface-panel">
          {vars.map((name) => (
            <CapturedVarRow
              key={name}
              name={name}
              testResult={testResult}
              onRemove={() => onChange(vars.filter((v) => v !== name))}
            />
          ))}
        </ul>
      )}

      {suggestions.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500">Exported by this script:</span>
          {suggestions.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => add(name)}
              title={`Save ${name} to the project after each run`}
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-dashed border-gray-600 text-xs font-mono text-gray-300 hover:border-brand-500 hover:text-brand-300 transition-colors"
            >
              <span className="text-brand-400">+</span>
              {name}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submitDraft(); }
          }}
          placeholder="Variable name, e.g. SNOWFLAKE_TOKEN"
          className="flex-1 min-w-0 px-2.5 py-1.5 rounded bg-surface-elevated border border-gray-700 text-xs font-mono text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
        <button
          type="button"
          onClick={submitDraft}
          disabled={!canAdd}
          className="px-3 py-1.5 text-xs rounded bg-surface-elevated hover:bg-brand-900/40 text-gray-300 hover:text-brand-300 disabled:opacity-40 disabled:hover:bg-surface-elevated disabled:hover:text-gray-300 transition-colors"
        >
          Add
        </button>
      </div>
      {draft.trim() !== '' && draftName !== draft.trim() && (
        <p className="-mt-1.5 text-[11px] text-gray-500">
          Will be saved as <code className="font-mono text-gray-400">{draftName}</code>
        </p>
      )}
    </section>
  );
}

interface CapturedVarRowProps {
  name: string;
  testResult: ScriptTestResultDto | null;
  onRemove: () => void;
}

function CapturedVarRow({ name, testResult, onRemove }: CapturedVarRowProps) {
  const captured = testResult?.captured[name];
  const missing = testResult?.missing.includes(name) ?? false;

  return (
    <li className="flex items-center gap-3 px-3 py-2 min-w-0">
      <span className="text-xs font-mono text-gray-200 shrink-0">{name}</span>
      <span className="flex-1 min-w-0 truncate text-[11px]">
        {captured !== undefined && (
          <span className="text-green-400" title={captured}>✓ test run exported {preview(captured)}</span>
        )}
        {missing && <span className="text-amber-400">not exported in the last test run</span>}
      </span>
      <button
        type="button"
        onClick={onRemove}
        title={`Stop saving ${name}`}
        className="text-xs text-gray-500 hover:text-red-400 transition-colors shrink-0"
      >
        Remove
      </button>
    </li>
  );
}
