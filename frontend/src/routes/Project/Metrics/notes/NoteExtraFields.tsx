// New note / Edit note, plan 33 fields: the type (Note / Release / Incident, an incident open or
// resolved; open ones show red), tags (chips, suggested from other notes), repeats every year, a
// template picker for new notes, and the widget the note is about (saved with it; can be removed).
import { useState, type KeyboardEvent } from 'react';
import { BarChart3, CheckCircle2, CircleDot, Repeat, X } from 'lucide-react';
import type { NoteStatus, NoteType } from '../../../../lib/notesApi';
import { parseTags, todayIso, type NotePrefill } from './lib/metricNotes';
import { NOTE_TEMPLATES, applyTemplate, type NoteTemplate } from './lib/noteTemplates';
import { NOTE_TYPES, NoteTypeIcon } from './NoteTypeIcon';
import { widgetSummary } from './lib/noteWidget';

const INPUT = 'px-2 py-1 rounded border border-gray-700 bg-surface-app text-xs text-gray-200 outline-none focus:border-brand-600';
const LABEL = 'flex flex-col gap-1 text-[11px] text-gray-400';

function TagInput({ tags, suggestions, onChange }: { tags: string[]; suggestions: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const add = (text: string) => {
    const next = parseTags([...tags, ...parseTags(text)].join(','));
    onChange(next);
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',') && draft.trim()) { e.preventDefault(); add(draft); }
    else if (e.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1));
  };
  const offered = suggestions.filter((s) => !tags.some((t) => t.toLowerCase() === s.toLowerCase()));
  return (
    <div className="flex flex-wrap items-center gap-1 min-h-[26px] px-1.5 py-0.5 rounded border border-gray-700 bg-surface-app focus-within:border-brand-600">
      {tags.map((t) => (
        <span key={t} className="inline-flex items-center gap-0.5 px-1.5 py-px text-[10px] rounded bg-gray-800 text-gray-200">
          #{t}
          <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))} className="text-gray-500 hover:text-gray-200">
            <X className="w-2.5 h-2.5" />
          </button>
        </span>
      ))}
      <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onBlur={() => { if (draft.trim()) add(draft); }}
        list="note-tag-suggestions" aria-label="Tags" placeholder={tags.length ? '' : 'e.g. outage, release'}
        className="flex-1 min-w-[6rem] bg-transparent text-xs text-gray-200 outline-none" />
      <datalist id="note-tag-suggestions">{offered.map((s) => <option key={s} value={s} />)}</datalist>
    </div>
  );
}

export function TemplatePicker({ form, last, onPick }: {
  form: NotePrefill;
  /** the template picked last (its untouched parts are replaced) */
  last: NoteTemplate | null;
  onPick: (next: NotePrefill, template: NoteTemplate) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="text-gray-500">Start from</span>
      {NOTE_TEMPLATES.map((t) => (
        <button key={t.id} type="button" title={t.hint} aria-pressed={last?.id === t.id} onClick={() => onPick(applyTemplate(form, t, last), t)}
          className={`px-2 py-0.5 rounded border ${last?.id === t.id ? 'border-brand-600 bg-brand-950/40 text-gray-100' : 'border-gray-700 text-gray-300 hover:border-gray-500 hover:text-gray-100'}`}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function NoteExtraFields({ form, tagSuggestions, onChange }: {
  form: NotePrefill; tagSuggestions: string[]; onChange: (next: NotePrefill) => void;
}) {
  const set = (patch: Partial<NotePrefill>) => onChange({ ...form, ...patch });
  const setStatus = (status: NoteStatus) => set({
    status, resolved: status === 'resolved' ? form.resolved ?? todayIso() : null,
  });
  const setType = (type: NoteType) => set({
    type, status: type === 'incident' ? form.status ?? 'open' : null, resolved: type === 'incident' ? form.resolved : null,
  });
  return (
    <div className="grid grid-cols-2 gap-3">
      <label className={`${LABEL} col-span-2`}>
        Tags
        <TagInput tags={form.tags} suggestions={tagSuggestions} onChange={(tags) => set({ tags })} />
      </label>
      <div className={`${LABEL} col-span-2`}>
        <span>Type</span>
        <div className="flex">
          <div className="flex rounded border border-gray-700" role="radiogroup" aria-label="Type">
            {NOTE_TYPES.map((t) => (
              <button key={t.id} type="button" role="radio" aria-checked={form.type === t.id} onClick={() => setType(t.id)}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs ${form.type === t.id ? 'bg-gray-800 text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}>
                {/* the type's own icon: an incident shows as open here whatever its state */}
                <NoteTypeIcon note={{ type: t.id, status: t.id === 'incident' ? 'open' : null }} />{t.label}
              </button>
            ))}
          </div>
        </div>
        {form.type === 'incident' && (
          <div className="flex flex-wrap items-center gap-1.5 mt-1.5" aria-label="Incident status">
            {form.status !== 'resolved' ? (
              <>
                <span className="flex items-center gap-1 text-[11px] text-red-300"><NoteTypeIcon note={{ type: 'incident', status: 'open' }} className="w-3 h-3" />Open</span>
                <button type="button" onClick={() => setStatus('resolved')}
                  className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-gray-700 text-yellow-300 hover:border-yellow-700">
                  <CheckCircle2 className="w-3.5 h-3.5" />Resolve
                </button>
              </>
            ) : (
              <>
                <span className="flex items-center gap-1 text-[11px] text-yellow-300"><NoteTypeIcon note={{ type: 'incident', status: 'resolved' }} className="w-3 h-3" />Resolved on</span>
                <input type="date" value={form.resolved ?? ''} onChange={(e) => set({ resolved: e.target.value || null })} aria-label="Resolved on" className={INPUT} />
                <button type="button" onClick={() => setStatus('open')}
                  className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-gray-700 text-gray-300 hover:border-gray-500">
                  <CircleDot className="w-3.5 h-3.5" />Reopen
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <label className="col-span-2 flex items-center gap-1.5 text-[11px] text-gray-300" title="Holidays and other dates that are unusual every year: the note applies every year, and seasonal monitors don't flag them">
        <input type="checkbox" checked={form.recurs === 'yearly'} onChange={(e) => set({ recurs: e.target.checked ? 'yearly' : null })} />
        <Repeat className="w-3 h-3" />Repeats every year
      </label>
      {form.widget && (
        <div className="col-span-2 flex items-center gap-2 px-2 py-1.5 rounded border border-gray-800 bg-surface-app text-[11px] text-gray-300">
          <BarChart3 className="w-3.5 h-3.5 shrink-0 text-gray-500" />
          <span className="flex-1 min-w-0 truncate">About: {widgetSummary(form.widget)}{form.source?.dashboard ? ` on ${form.source.dashboard}` : ''}</span>
          <button type="button" onClick={() => set({ widget: null, source: null })} className="text-gray-500 hover:text-gray-200">Don't save it</button>
        </div>
      )}
    </div>
  );
}
