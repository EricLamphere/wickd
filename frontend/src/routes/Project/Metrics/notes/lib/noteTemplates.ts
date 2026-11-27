// Note templates (plan 33): picking one in New note sets the note's type and fills in tags and a
// body outline. Picking another takes out what the last one put in and you haven't changed since
// (its title, its outline, its tags, its type), so switching templates doesn't pile them up.
// Built in; project templates in files are a follow-up. Pure; tested in noteTemplates.test.ts.
import type { NoteStatus, NoteType } from '../../../../../lib/notesApi';
import type { NotePrefill } from './metricNotes';

export interface NoteTemplate {
  id: 'incident' | 'release' | 'backfill' | 'definition';
  label: string;
  hint: string;
  /** used when the title is empty */
  title: string;
  tags: string[];
  type: NoteType;
  /** an incident's starting state */
  status: NoteStatus | null;
  body: string;
}

export const NOTE_TEMPLATES: readonly NoteTemplate[] = [
  {
    id: 'incident', label: 'Incident', hint: 'Something broke: open until resolved, shown red', title: 'Incident: ',
    tags: ['incident'], type: 'incident', status: 'open',
    body: '**What happened:** \n\n**Impact:** \n\n**Cause:** \n\n**Fix:** \n',
  },
  {
    id: 'release', label: 'Release', hint: 'A launch or change expected to move the metric', title: 'Release: ',
    tags: ['release'], type: 'release', status: null,
    body: '**What changed:** \n\n**Expected effect:** \n\n**Commit:** commit:\n',
  },
  {
    id: 'backfill', label: 'Backfill', hint: 'Data reloaded or corrected for past dates', title: 'Backfill: ',
    tags: ['backfill'], type: 'note', status: null,
    body: '**What was reloaded:** model:\n\n**Dates affected:** \n\n**Why:** \n',
  },
  {
    id: 'definition', label: 'Definition change', hint: 'The metric is calculated differently from these dates',
    title: 'Definition change: ', tags: ['definition-change'], type: 'note', status: null,
    body: '**Before:** \n\n**After:** \n\n**Why:** \n\n**Commit:** commit:\n',
  },
];

const sameTag = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The form without what `template` put in that's still as it left it. */
export function withoutTemplate(form: NotePrefill, template: NoteTemplate): NotePrefill {
  // the outline, alone or appended after what was written before it, if it's untouched
  const body = form.body.endsWith(template.body) ? form.body.slice(0, form.body.length - template.body.length).replace(/\s+$/, '') : form.body;
  const untouchedType = form.type === template.type && form.status === template.status;
  return {
    ...form,
    title: form.title === template.title ? '' : form.title,
    body: body ? (body === form.body ? body : `${body}\n`) : '',
    tags: form.tags.filter((t) => !template.tags.some((x) => sameTag(x, t))),
    ...(untouchedType ? { type: 'note' as const, status: null, resolved: null } : {}),
  };
}

/**
 * The form with `template` applied: its type (and an incident's status), its tags added, its title
 * when the title is empty, and its outline as the body when the body is empty (or after what's
 * written). `previous` (the template picked last) is taken out first where it's untouched.
 */
export function applyTemplate(form: NotePrefill, template: NoteTemplate, previous: NoteTemplate | null = null): NotePrefill {
  const base = previous ? withoutTemplate(form, previous) : form;
  const tags = [...base.tags];
  for (const t of template.tags) if (!tags.some((x) => sameTag(x, t))) tags.push(t);
  const body = base.body.trim() ? `${base.body.replace(/\s+$/, '')}\n\n${template.body}` : template.body;
  return {
    ...base,
    title: base.title.trim() ? base.title : template.title,
    tags,
    type: template.type,
    status: template.status,
    resolved: null,
    body,
  };
}
