import { useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { FileText, Pencil, RefreshCw, BookMarked } from 'lucide-react';
import type { DocsNodeDto } from '../../../../lib/api';
import type { DocsPagesListDto, DocsPageSegmentDto } from '../../../../lib/docsPagesApi';
import { extractHeadings, type Heading, type LinkContext } from '../../lib/docsPageLinks';
import { MarkdownPage } from './MarkdownPage';
import { scrollToAnchor, useDocsPage, useMarkdownLinkHandler, useNodeResolver } from './useDocsPages';

interface PageDetailProps {
  projectId: number;
  path: string;
  list: DocsPagesListDto;
  nodes: Map<string, DocsNodeDto>;
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** One Markdown page from the docs folder: header (title, path, Edit), body, and an outline. */
export function PageDetail({ projectId, path, list, nodes }: PageDetailProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const containerRef = useRef<HTMLDivElement>(null);
  const { data, isLoading, error } = useDocsPage(projectId, path);
  const resolveNode = useNodeResolver(projectId);
  const onLink = useMarkdownLinkHandler(projectId, containerRef, true);

  const ctx = useMemo<LinkContext>(() => ({
    base: 'docs', dir: folderOf(path), docsDir: list.dir, docsInProject: list.in_project, resolveNode,
  }), [path, list.dir, list.in_project, resolveNode]);

  const outline = useMemo<Heading[]>(() => (data?.segments ?? [])
    .filter((s) => s.kind === 'markdown')
    .flatMap((s) => extractHeadings(s.text))
    .filter((h) => h.depth === 2 || h.depth === 3), [data]);

  // Arriving with #anchor (a link from another page): scroll once the page has rendered
  useEffect(() => {
    if (!data || !location.hash) return;
    const id = decodeURIComponent(location.hash.slice(1));
    const frame = requestAnimationFrame(() => scrollToAnchor(containerRef.current, id));
    return () => cancelAnimationFrame(frame);
  }, [data, location.hash]);

  if (isLoading) {
    return <div className="flex items-center justify-center h-32 text-gray-600"><RefreshCw className="w-4 h-4 animate-spin" /></div>;
  }
  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-gray-600 text-sm">
        <FileText className="w-6 h-6" />
        <p>{error instanceof Error ? error.message : 'This page is no longer in the docs folder.'}</p>
      </div>
    );
  }

  const shownPath = list.dir ? `${list.dir}/${data.path}` : data.path;
  return (
    <div ref={containerRef} className="flex flex-col min-h-full">
      <div className="px-8 py-3 border-b border-gray-800 flex items-center gap-4">
        <div className="min-w-0 flex-1 flex items-center gap-2 text-[11px] text-gray-500">
          <span className="px-1.5 py-0.5 rounded border bg-sky-950/40 text-sky-300 border-sky-900/60">page</span>
          <span className="font-mono truncate" title={shownPath}>{shownPath}</span>
        </div>
        {data.project_path && (
          <button
            onClick={() => navigate(`/projects/${projectId}/files?path=${encodeURIComponent(data.project_path!)}`)}
            title="Edit this page in Files"
            className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 text-xs rounded border border-gray-700 text-gray-300 hover:bg-surface-elevated transition-colors"
          >
            <Pencil className="w-3.5 h-3.5" /> Edit
          </button>
        )}
      </div>
      <div className="flex gap-8 px-8 py-6">
        <article className="prose-readme min-w-0 flex-1 max-w-4xl">
          {data.segments.map((segment, i) => (
            <Segment key={i} segment={segment} projectId={projectId} ctx={ctx} onLink={onLink} nodes={nodes} />
          ))}
        </article>
        {outline.length >= 2 && (
          <nav className="hidden xl:block w-48 shrink-0 sticky top-6 self-start text-xs">
            <p className="text-gray-500 font-medium mb-2">On this page</p>
            {outline.map((h) => (
              <button
                key={h.id}
                onClick={() => scrollToAnchor(containerRef.current, h.id)}
                style={{ paddingLeft: (h.depth - 2) * 10 }}
                className="block w-full text-left py-0.5 text-gray-500 hover:text-gray-200 truncate transition-colors"
                title={h.text}
              >
                {h.text}
              </button>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}

interface SegmentProps {
  segment: DocsPageSegmentDto;
  projectId: number;
  ctx: LinkContext;
  onLink: ReturnType<typeof useMarkdownLinkHandler>;
  nodes: Map<string, DocsNodeDto>;
}

function Segment({ segment, projectId, ctx, onLink, nodes }: SegmentProps) {
  if (segment.kind === 'markdown') return <MarkdownPage projectId={projectId} text={segment.text} ctx={ctx} onLink={onLink} />;
  return (
    <aside className="my-4 rounded-md border border-purple-900/60 bg-purple-950/20">
      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 border-b border-purple-900/40 text-[11px] text-purple-300">
        <BookMarked className="w-3.5 h-3.5" />
        <span>docs block <code>{segment.name}</code></span>
        {segment.used_by.length > 0 && <span className="text-gray-500">used by</span>}
        {segment.used_by.map((uid) => (
          <button
            key={uid}
            onClick={() => onLink({ kind: 'node', uid })}
            className="px-1.5 py-0.5 rounded bg-surface-elevated text-gray-300 hover:text-gray-100 font-mono"
            title={uid}
          >
            {nodes.get(uid)?.name ?? uid.split('.').slice(2).join('.')}
          </button>
        ))}
        {segment.used_by.length === 0 && <span className="text-gray-500">not used by any node</span>}
      </div>
      <div className="px-3 py-2">
        <MarkdownPage projectId={projectId} text={segment.text} ctx={ctx} onLink={onLink} />
      </div>
    </aside>
  );
}
