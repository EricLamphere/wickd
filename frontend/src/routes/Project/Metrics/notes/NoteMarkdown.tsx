// A note's body: GitHub-flavored Markdown, raw HTML off (react-markdown's default), links in the
// system browser, local images through the notes asset route (only files in the notes or note
// images folder; remote images show their alt text, so a note never loads remote content).
// Plan 33: `note:slug` (or an older `[[slug]]`) opens that note, `model:x` opens the node in the DAG, `commit:sha` shows the
// commit (lib/noteMentions.ts turns them into links first).
import { memo, useMemo, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../../../../lib/api';
import { alertDialog } from '../../../../lib/dialogs';
import { notesApi } from '../../../../lib/notesApi';
import { openExternal } from '../../../../lib/openExternal';
import { widgetLinkHref } from '../lib/widgetLinks';
import { linkifyMentions, parseMentionHref } from './lib/noteMentions';
import { openMetricNote } from './noteEvents';
import { noteCommitsKey } from './useNoteCompletions';
import { useNotes } from './useNotes';

const REMOTE = /^[a-z][a-z0-9+.-]*:|^\/\//i;
const MENTION = 'text-brand-300 underline decoration-dotted underline-offset-2 hover:text-brand-200';
const MISSING = 'text-gray-400 line-through decoration-gray-600';

const urlTransform = (url: string) => (parseMentionHref(url) ? url : defaultUrlTransform(url));

function useMentionTargets(projectId: number) {
  const { data: notes } = useNotes(projectId);
  const { data: graph } = useQuery({ queryKey: ['graph', projectId], queryFn: () => api.models.graph(projectId) });
  const { data: log } = useQuery({ queryKey: noteCommitsKey(projectId), queryFn: () => api.git.log(projectId, undefined, 100), retry: false, staleTime: 30_000 });
  return useMemo(() => ({
    note: new Map((notes?.notes ?? []).map((n) => [n.slug, n.title])),
    model: new Map((graph?.nodes ?? []).map((n) => [n.name.toLowerCase(), n.unique_id])),
    commits: log?.entries ?? [],
  }), [notes, graph, log]);
}

export const NoteMarkdown = memo(function NoteMarkdown({ projectId, body }: { projectId: number; body: string }) {
  const navigate = useNavigate();
  const targets = useMentionTargets(projectId);
  const text = useMemo(() => linkifyMentions(body, (slug) => targets.note.get(slug) ?? null), [body, targets]);
  const components = useMemo<Components>(() => {
    const showCommit = (sha: string) => {
      const c = targets.commits.find((e) => e.hash.startsWith(sha));
      void alertDialog(c ? `${c.message}\n\n${c.author} · ${c.date}\n${c.hash}` : `Commit ${sha} isn't in the last 100 commits of this repository.`,
        { title: c ? `Commit ${c.short_hash}` : 'Commit' });
    };
    return {
      a: ({ href, children }) => {
        const mention = parseMentionHref(href);
        if (mention) {
          const stop = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
          if (mention.kind === 'note') {
            const known = targets.note.has(mention.value);
            return <a href="#" className={known ? MENTION : MISSING} title={known ? 'Open this note' : `There's no note ${mention.value}`}
              onClick={(e) => { stop(e); if (known) openMetricNote(mention.value); }}>{children}</a>;
          }
          if (mention.kind === 'model') {
            const uid = targets.model.get(mention.value.toLowerCase()) ?? targets.model.get(mention.value.split('.').pop()!.toLowerCase());
            return <a href="#" className={uid ? MENTION : MISSING} title={uid ? 'Open in the DAG' : `No node named ${mention.value}`}
              onClick={(e) => { stop(e); if (uid) navigate(`/projects/${projectId}/models?model=${encodeURIComponent(uid)}`); }}>{children}</a>;
          }
          return <a href="#" className={`${MENTION} font-mono`} title="Show the commit" onClick={(e) => { stop(e); showCommit(mention.value); }}>{children}</a>;
        }
        const url = widgetLinkHref(href);
        if (!url) return <span className="text-gray-400">{children}</span>;
        const open = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); openExternal(url); };
        return <a href={url} onClick={open} title={url}>{children}</a>;
      },
      img: ({ src, alt, title }) => {
        const ref = typeof src === 'string' ? src : '';
        if (!ref || REMOTE.test(ref) || ref.startsWith('/')) return <span className="italic text-gray-500">{alt}</span>;
        return <img src={notesApi.assetUrl(projectId, ref)} alt={alt ?? ''} title={title} loading="lazy" className="max-w-full rounded border border-gray-800" />;
      },
    };
  }, [projectId, targets, navigate]);
  if (!body.trim()) return <p className="text-xs italic text-gray-500">No details written.</p>;
  return (
    <div className="prose-readme text-xs">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>{text}</ReactMarkdown>
    </div>
  );
});
