// The text widget's editor: a Markdown textarea with a formatting toolbar and shortcuts
// (⌘B bold, ⌘I italic, ⌘⇧X strikethrough, ⌘E code, ⌘K link, Tab / ⇧Tab indent, Enter continues
// a list). Edits go through the browser's insertText command, so ⌘Z undoes them.
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Bold, Code, Heading1, Heading2, Heading3, Italic, Link, List, ListChecks, ListOrdered, Quote, Strikethrough } from 'lucide-react';
import {
  continueList, indentLines, insertLink, toggleLineFormat, toggleWrap, type LineFormat, type TextEdit,
} from '../../lib/markdownEdit';

type Command = (text: string, start: number, end: number) => TextEdit | null;

const wrap = (marker: string): Command => (t, s, e) => toggleWrap(t, s, e, marker);
const line = (format: LineFormat): Command => (t, s, e) => toggleLineFormat(t, s, e, format);

interface Tool { label: string; icon: ReactNode; run: Command; keys?: string }

const ICON = 'w-3.5 h-3.5';
const TOOLS: (Tool | 'sep')[] = [
  { label: 'Bold', keys: '⌘B', icon: <Bold className={ICON} />, run: wrap('**') },
  { label: 'Italic', keys: '⌘I', icon: <Italic className={ICON} />, run: wrap('_') },
  { label: 'Strikethrough', keys: '⌘⇧X', icon: <Strikethrough className={ICON} />, run: wrap('~~') },
  { label: 'Code', keys: '⌘E', icon: <Code className={ICON} />, run: wrap('`') },
  { label: 'Link', keys: '⌘K', icon: <Link className={ICON} />, run: insertLink },
  'sep',
  { label: 'Heading', icon: <Heading1 className={ICON} />, run: line('h1') },
  { label: 'Subheading', icon: <Heading2 className={ICON} />, run: line('h2') },
  { label: 'Small heading', icon: <Heading3 className={ICON} />, run: line('h3') },
  'sep',
  { label: 'Bulleted list', icon: <List className={ICON} />, run: line('bullet') },
  { label: 'Numbered list', icon: <ListOrdered className={ICON} />, run: line('number') },
  { label: 'Checklist', icon: <ListChecks className={ICON} />, run: line('task') },
  { label: 'Quote', icon: <Quote className={ICON} />, run: line('quote') },
];

/** ⌘/Ctrl shortcuts: key (lowercase) → command; `shift` ones need Shift too. */
const SHORTCUTS: Record<string, Command> = { b: wrap('**'), i: wrap('_'), e: wrap('`'), k: insertLink };
const SHIFT_SHORTCUTS: Record<string, Command> = { x: wrap('~~') };

/** Apply `edit` as one undoable change: replace only the span that differs, then restore the selection. */
function apply(el: HTMLTextAreaElement, edit: TextEdit, onChange: (text: string) => void) {
  const old = el.value;
  let a = 0;
  while (a < old.length && a < edit.text.length && old[a] === edit.text[a]) a += 1;
  let b = 0;
  while (b < old.length - a && b < edit.text.length - a && old[old.length - 1 - b] === edit.text[edit.text.length - 1 - b]) b += 1;
  const insert = edit.text.slice(a, edit.text.length - b);
  el.focus();
  el.setSelectionRange(a, old.length - b);
  // execCommand is deprecated but still the only way to edit a textarea without losing undo
  const ok = insert ? document.execCommand('insertText', false, insert) : document.execCommand('delete');
  if (!ok || el.value !== edit.text) onChange(edit.text);
  requestAnimationFrame(() => el.setSelectionRange(edit.start, edit.end));
}

export function MarkdownEditor({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const run = (command: Command) => {
    const el = ref.current;
    if (!el) return false;
    const edit = command(el.value, el.selectionStart, el.selectionEnd);
    if (!edit) return false;
    apply(el, edit, onChange);
    return true;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    let command: Command | undefined;
    if (mod && !e.altKey) command = (e.shiftKey ? SHIFT_SHORTCUTS : SHORTCUTS)[key];
    else if (e.key === 'Tab' && !mod && !e.altKey) command = (t, s, en) => indentLines(t, s, en, e.shiftKey);
    else if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) command = continueList;
    if (command && run(command)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return (
    <div className="flex flex-col rounded border border-gray-700 bg-surface-app focus-within:border-brand-600">
      <div className="flex flex-wrap items-center gap-0.5 px-1 py-0.5 border-b border-gray-800" role="toolbar" aria-label="Formatting">
        {TOOLS.map((tool, i) => tool === 'sep'
          ? <span key={`sep-${i}`} className="w-px h-3.5 mx-0.5 bg-gray-800" />
          : (
            <button key={tool.label} type="button" title={tool.keys ? `${tool.label} (${tool.keys})` : tool.label} aria-label={tool.label}
              onMouseDown={(e) => e.preventDefault()} onClick={() => run(tool.run)}
              className="p-1 rounded text-gray-400 hover:bg-gray-800 hover:text-gray-100">
              {tool.icon}
            </button>
          ))}
      </div>
      <textarea ref={ref} value={value} rows={10} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown}
        aria-label="Text" spellCheck data-keyboard-owner=""
        className="w-full px-2 py-1 bg-transparent text-xs text-gray-200 font-mono leading-5 outline-none resize-y" />
    </div>
  );
}
