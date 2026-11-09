import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { aiApi } from '../../../../lib/aiApi';
import { fileChoices, resolveFileInput, unitTestFileKey } from '../../lib/unitTests';

const OTHER = '__other__';
type OtherMode = 'existing' | 'new';

/** The file last chosen for this model ('' = default; null when never chosen / unreadable). */
export function readRememberedFile(projectId: number, uniqueId: string): string | null {
  try { return localStorage.getItem(unitTestFileKey(projectId, uniqueId)); } catch { return null; }
}

export function rememberFile(projectId: number, uniqueId: string, file: string | null): void {
  try { localStorage.setItem(unitTestFileKey(projectId, uniqueId), file ?? ''); } catch { /* storage unavailable */ }
}

interface Props {
  projectId: number;
  uniqueId: string;
  /** null = the default location; otherwise what to send as `file` */
  onChange: (file: string | null) => void;
}

const INPUT = 'px-2 py-1 rounded bg-surface-panel border border-gray-700 text-gray-200 focus:outline-none focus:border-brand-500';

function ModeTabs({ mode, onMode }: { mode: OtherMode; onMode: (m: OtherMode) => void }) {
  return (
    <div className="flex self-start rounded border border-gray-700 overflow-hidden">
      {(['existing', 'new'] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onMode(m)}
          className={`px-2 py-0.5 ${mode === m ? 'bg-gray-700 text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}
        >
          {m === 'existing' ? 'Existing file' : 'New file'}
        </button>
      ))}
    </div>
  );
}

function ExistingFileList({ files, selected, onSelect }: { files: string[]; selected: string; onSelect: (f: string) => void }) {
  const [filter, setFilter] = useState('');
  const shown = files.filter((f) => f.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <div className="flex flex-col gap-1">
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={`Filter ${files.length} YAML file${files.length === 1 ? '' : 's'}…`}
        spellCheck={false}
        className={INPUT}
      />
      <ul className="max-h-40 overflow-y-auto rounded border border-gray-800" role="listbox">
        {shown.map((f) => (
          <li key={f}>
            <button
              type="button"
              role="option"
              aria-selected={f === selected}
              onClick={() => onSelect(f)}
              className={`w-full px-2 py-1 text-left font-mono truncate ${f === selected ? 'bg-brand-900/50 text-brand-200' : 'text-gray-300 hover:bg-gray-800'}`}
              title={f}
            >
              {f}
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="px-2 py-1 text-gray-600">No matching files</li>}
      </ul>
    </div>
  );
}

/** "Write to": the default location, a file that already has this model's unit tests,
 *  the file used last time, or another file — picked from the project's YAML files or
 *  a new name. The last choice is remembered per model (rememberFile() on Generate). */
export function UnitTestFilePicker({ projectId, uniqueId, onChange }: Props) {
  const { data: options } = useQuery({
    queryKey: ['unit-test-files', projectId, uniqueId],
    queryFn: () => aiApi.unitTestFileOptions(projectId, uniqueId),
    staleTime: 30_000,
  });
  const [remembered] = useState(() => readRememberedFile(projectId, uniqueId));
  const [choice, setChoice] = useState('');
  const [mode, setMode] = useState<OtherMode>('existing');
  const [picked, setPicked] = useState('');
  const [newName, setNewName] = useState('');
  const choices = options ? fileChoices(options, remembered) : [];

  // once the options load: start on the remembered file
  useEffect(() => {
    if (!options || !remembered) return;
    if (choices.some((c) => c.value === remembered)) setChoice(remembered);
    else if (options.files.includes(remembered)) { setChoice(OTHER); setMode('existing'); setPicked(remembered); }
    else { setChoice(OTHER); setMode('new'); setNewName(remembered); }
  }, [options]); // eslint-disable-line react-hooks/exhaustive-deps

  const other = choice === OTHER;
  const resolvedNew = options ? resolveFileInput(newName, options.model_dir) : '';
  useEffect(() => {
    if (!other) onChange(choice || null);
    else onChange(mode === 'existing' ? (picked || null) : (newName.trim() || null));
  }, [choice, mode, picked, newName]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col gap-1">
      <span className="text-gray-500">Write to</span>
      <select value={choice} onChange={(e) => setChoice(e.target.value)} className={INPUT}>
        {!options && <option value="">Default location</option>}
        {choices.map((c) => <option key={c.value || 'default'} value={c.value}>{c.label}</option>)}
        {options && <option value={OTHER}>Another file…</option>}
      </select>
      {other && options && (
        <div className="flex flex-col gap-1.5 pl-2 border-l border-gray-800">
          <ModeTabs mode={mode} onMode={setMode} />
          {mode === 'existing' ? (
            <>
              <ExistingFileList files={options.files} selected={picked} onSelect={setPicked} />
              {!picked && <span className="text-amber-400/80">Pick a file, or the default location is used.</span>}
            </>
          ) : (
            <>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={`e.g. ${uniqueId.split('.').pop()}_unit_tests`}
                spellCheck={false}
                className={`${INPUT} font-mono`}
              />
              <span className="text-gray-500">
                {resolvedNew
                  ? <>{options.files.includes(resolvedNew) ? 'Adds to the existing' : 'Creates'} <code className="text-brand-300">{resolvedNew}</code></>
                  : <>A bare name goes in <code>{options.model_dir}/</code>; add a path for another folder in your models.</>}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
