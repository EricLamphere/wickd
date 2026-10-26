import { useEffect, useRef, useState } from 'react';

interface InlineNameInputProps {
  initial: string;
  /** Called with the trimmed name; an empty or unchanged name means cancel. */
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

/** VS Code-style inline name box: selects the name without its extension, Enter commits, Escape cancels. */
export function InlineNameInput({ initial, onSubmit, onCancel }: InlineNameInputProps) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    const dot = initial.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    const name = value.trim();
    if (commit && name && name !== initial) onSubmit(name);
    else onCancel();
  };

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation(); // keep tree shortcuts (Delete, arrows, ⌘C…) out of the text box
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      spellCheck={false}
      className="flex-1 min-w-0 bg-surface-elevated border border-brand-500 rounded px-1 py-0 text-xs text-gray-100 focus:outline-none"
    />
  );
}
