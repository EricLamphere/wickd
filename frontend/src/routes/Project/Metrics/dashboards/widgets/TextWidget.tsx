// Text: headings, notes and lists in GitHub-flavored Markdown (nested lists, bold, italic,
// strikethrough, code, quotes, tables, task lists, links). Raw HTML stays off (react-markdown's
// default) so a dashboard file can't inject markup; links open in the system browser (a bare domain as https) and
// images show their alt text, so a dashboard never loads remote content.
import { memo, type MouseEvent } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { openExternal } from '../../../../../lib/openExternal';
import { rehypeListMarkers, type HastNode } from '../../lib/listMarkers';
import { widgetLinkHref } from '../../lib/widgetLinks';

const components: Components = {
  a: ({ href, children }) => {
    const url = widgetLinkHref(href);
    if (!url) return <a title={`Not a web address: ${href ?? ''}`} className="cursor-default">{children}</a>;
    const open = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); openExternal(url); };
    return <a href={url} onClick={open} title={url}>{children}</a>;
  },
  img: ({ alt }) => <span className="italic text-gray-500">{alt}</span>,
  li: ({ node, children }) => {
    const marker = (node as HastNode | undefined)?.properties?.dataMarker;
    return (
      <li>
        {typeof marker === 'string' && marker && <span className="widget-li-marker" aria-hidden>{marker}</span>}
        <div className="min-w-0">{children}</div>
      </li>
    );
  },
};

export const TextWidget = memo(function TextWidget({ body }: { body: string }) {
  if (!body.trim()) return <p className="text-xs text-gray-500">Write a heading or a note in the widget's settings.</p>;
  return (
    <div className="h-full overflow-auto prose-readme prose-widget">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeListMarkers]} components={components}>{body}</ReactMarkdown>
    </div>
  );
});
