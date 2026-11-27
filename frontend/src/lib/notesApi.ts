// Typed helpers for metric notes (Base; plan 30): Markdown files under the project's
// NOTES_PATH (default wickd/notes), images under NOTES_IMG_PATH (default wickd/img).
// Mirrors backend/app/api/metric_notes.py.
import { del, get, post, postForm, put } from './api';

export type NoteStatus = 'open' | 'resolved';
/** what kind of note (plan 33): only an incident has a status */
export type NoteType = 'note' | 'release' | 'incident';

/** Where a note's saved widget lived (a dashboard's widget), when it came from one. */
export interface NoteSource {
  dashboard?: string;
  widget?: string;
}

export interface MetricNoteDto {
  slug: string;
  /** relative to the project root */
  path: string;
  title: string;
  /** inclusive ISO dates; null when the file doesn't parse */
  start: string | null;
  end: string | null;
  /** empty = applies to every metric */
  metrics: string[];
  dimension: string | null;
  value: string | null;
  created: string | null;
  tags: string[];
  type: NoteType;
  /** an incident's state: open (shown red) or resolved; null for other types */
  status: NoteStatus | null;
  resolved: string | null;
  /** 'yearly' = the same dates every year */
  recurs: 'yearly' | null;
  /** the widget the note was written about (the query view's encoding) */
  widget: Record<string, unknown> | null;
  source: NoteSource | null;
  /** derived from the body (`model:x`, `commit:sha`, `[[slug]]`) plus frontmatter lists */
  models: string[];
  commits: string[];
  links: string[];
  body: string;
  /** why the file couldn't be read (the note is listed, but applies nowhere) */
  error: string | null;
  /** a metric or dimension the semantic layer doesn't know (renamed or removed?) */
  warnings: string[];
  modified_at: string | null;
}

export interface MetricNotesListDto {
  folder: string;
  img_folder: string;
  notes: MetricNoteDto[];
}

export interface MetricNoteBody {
  title: string;
  start: string;
  end: string;
  metrics: string[];
  dimension: string | null;
  value: string | null;
  tags: string[];
  type: NoteType;
  status: NoteStatus | null;
  resolved: string | null;
  recurs: 'yearly' | null;
  widget: Record<string, unknown> | null;
  source: NoteSource | null;
  body: string;
}

/** Draft with Wicky (Pro): a note about a monitor's flagged period. */
export interface NoteDraftRequest {
  monitor_id: number;
  period: string;
  slice: string;
  target?: string | null;
}

const base = (projectId: number) => `/projects/${projectId}/metric-notes`;

export const notesApi = {
  list: (projectId: number) => get<MetricNotesListDto>(base(projectId)),
  get: (projectId: number, slug: string) => get<MetricNoteDto>(`${base(projectId)}/${encodeURIComponent(slug)}`),
  create: (projectId: number, body: MetricNoteBody) => post<MetricNoteDto>(base(projectId), body),
  save: (projectId: number, slug: string, body: MetricNoteBody, baseModifiedAt: string | null) =>
    put<MetricNoteDto>(`${base(projectId)}/${encodeURIComponent(slug)}`, { ...body, base_modified_at: baseModifiedAt }),
  remove: (projectId: number, slug: string, removeImages: boolean) =>
    del<void>(`${base(projectId)}/${encodeURIComponent(slug)}?remove_images=${removeImages}`),
  orphanImages: (projectId: number, slug: string) =>
    get<{ images: string[] }>(`${base(projectId)}/${encodeURIComponent(slug)}/orphan-images`),
  /** returns the image's path relative to the notes folder (`../img/x-1.png`), ready for Markdown */
  uploadImage: (projectId: number, file: Blob, name: string) => {
    const form = new FormData();
    form.append('name', name || 'note');
    form.append('file', file, (file as File).name || 'paste.png');
    return postForm<{ path: string }>(`${base(projectId)}/images`, form);
  },
  draft: (projectId: number, req: NoteDraftRequest) => post<{ title: string; body: string }>(`${base(projectId)}/draft`, req),
  assetUrl: (projectId: number, path: string) => `/api${base(projectId)}/asset?path=${encodeURIComponent(path)}`,
};
