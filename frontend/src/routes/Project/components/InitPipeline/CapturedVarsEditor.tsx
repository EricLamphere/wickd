import { useEffect, useRef, useState } from 'react';

/** Env var names are stored upper-case with anything outside [A-Z0-9_] turned into `_`. */
export function normalizeVarName(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

interface CapturedVarsEditorProps {
  vars: string[];
  onChange: (vars: string[]) => void;
}

/**
 * Chips for the env vars a custom step captures after it runs, with an inline
 * "+ add" input. Shared by the step tile and the script editor modal; every
 * button is type="button" so it never submits the modal's form.
 */
export function CapturedVarsEditor({ vars, onChange }: CapturedVarsEditorProps) {
  const [newVar, setNewVar] = useState('');
  const [inputOpen, setInputOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputOpen) inputRef.current?.focus();
  }, [inputOpen]);

  const closeInput = () => {
    setNewVar('');
    setInputOpen(false);
  };

  const handleAdd = () => {
    const name = normalizeVarName(newVar);
    if (name && !vars.includes(name)) onChange([...vars, name]);
    closeInput();
  };

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-[10px] text-gray-600 font-medium uppercase tracking-wider shrink-0">Captured vars</span>
      {vars.map((v) => (
        <span
          key={v}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface-elevated border border-gray-700 text-[11px] font-mono text-gray-300"
        >
          {v}
          <button
            type="button"
            onClick={() => onChange(vars.filter((x) => x !== v))}
            className="text-gray-600 hover:text-red-400 transition-colors leading-none"
            title="Remove"
          >
            ×
          </button>
        </span>
      ))}
      {inputOpen ? (
        <input
          ref={inputRef}
          value={newVar}
          onChange={(e) => setNewVar(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); handleAdd(); }
            if (e.key === 'Escape') { e.stopPropagation(); closeInput(); }
          }}
          onBlur={handleAdd}
          placeholder="VAR_NAME"
          className="w-28 px-1.5 py-0.5 rounded bg-surface-elevated border border-brand-600 text-[11px] font-mono text-gray-200 placeholder-gray-600 focus:outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => setInputOpen(true)}
          className="text-[10px] text-gray-600 hover:text-brand-400 transition-colors"
          title="Add a variable to capture"
        >
          + add
        </button>
      )}
    </div>
  );
}
