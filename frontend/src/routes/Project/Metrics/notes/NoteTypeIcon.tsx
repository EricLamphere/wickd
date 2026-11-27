// A note's type at a glance (plan 33): Note (sticky note, amber), Release (rocket, sky), Incident
// (a red circle with a dot while open; a yellow circle with a check once resolved). Used wherever a
// note is listed or shown.
import { CheckCircle2, CircleDot, Rocket, StickyNote } from 'lucide-react';
import type { NoteStatus, NoteType } from '../../../../lib/notesApi';

export const NOTE_TYPES: readonly { id: NoteType; label: string }[] = [
  { id: 'note', label: 'Note' },
  { id: 'release', label: 'Release' },
  { id: 'incident', label: 'Incident' },
];

const LABEL: Record<NoteType, string> = { note: 'Note', release: 'Release', incident: 'Incident' };

/** "Note", "Release", "Open incident", "Resolved incident" */
export function noteTypeLabel(note: { type?: NoteType | null; status?: NoteStatus | null }): string {
  const type = note.type ?? 'note';
  if (type !== 'incident') return LABEL[type];
  return note.status === 'resolved' ? 'Resolved incident' : 'Open incident';
}

export function noteTypeColor(note: { type?: NoteType | null; status?: NoteStatus | null }): string {
  switch (note.type ?? 'note') {
    case 'release': return 'text-sky-300';
    case 'incident': return note.status === 'resolved' ? 'text-yellow-400' : 'text-red-400';
    default: return 'text-amber-300';
  }
}

export function NoteTypeIcon({ note, className = 'w-3.5 h-3.5' }: {
  note: { type?: NoteType | null; status?: NoteStatus | null }; className?: string;
}) {
  const Icon = note.type === 'release' ? Rocket
    : note.type === 'incident' ? (note.status === 'resolved' ? CheckCircle2 : CircleDot)
    : StickyNote;
  const label = noteTypeLabel(note);
  return <Icon className={`shrink-0 ${noteTypeColor(note)} ${className}`} aria-label={label}><title>{label}</title></Icon>;
}
