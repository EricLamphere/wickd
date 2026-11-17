// A note's body: GitHub-flavored Markdown, raw HTML off (react-markdown's default), links in the
// system browser, local images through the notes asset route (only files in the notes or note
// images folder; remote images show their alt text, so a note never loads remote content).
import { memo, useMemo, type MouseEvent } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { notesApi } from '../../../../lib/notesApi';
import { openExternal } from '../../../../lib/openExternal';
import { widgetLinkHref } from '../lib/widgetLinks';

const REMOTE = /^[a-z][a-z0-9+.-]*:|^\/\//i;

export const NoteMarkdown = memo(function NoteMarkdown({ projectId, body }: { projectId: number; body: string }) {
  const components = useMemo<Components>(() => ({
    a: ({ href, children }) => {
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
  }), [projectId]);
  if (!body.trim()) return <p className="text-xs italic text-gray-500">No details written.</p>;
  return (
    <div className="prose-readme text-xs">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{body}</ReactMarkdown>
    </div>
  );
});
