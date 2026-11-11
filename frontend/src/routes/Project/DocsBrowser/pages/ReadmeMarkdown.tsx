import { useMemo, useRef } from 'react';
import type { LinkContext } from '../../lib/docsPageLinks';
import { MarkdownPage } from './MarkdownPage';
import { useDocsPagesList, useMarkdownLinkHandler, useNodeResolver } from './useDocsPages';

interface ReadmeMarkdownProps {
  projectId: number;
  text: string;
  /** True on the Docs page (links select in place); false elsewhere (links open the Docs page). */
  inDocs: boolean;
}

/**
 * Markdown that lives at the project root (README, the docs overview), rendered like a docs
 * page: GFM, mermaid, images from the project, links into the docs folder's pages.
 */
export function ReadmeMarkdown({ projectId, text, inDocs }: ReadmeMarkdownProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { data: list } = useDocsPagesList(projectId);
  const resolveNode = useNodeResolver(projectId);
  const onLink = useMarkdownLinkHandler(projectId, containerRef, inDocs);
  const ctx = useMemo<LinkContext>(() => ({
    base: 'project', dir: '', docsDir: list?.dir ?? null, docsInProject: list?.in_project ?? false, resolveNode,
  }), [list?.dir, list?.in_project, resolveNode]);
  return (
    <div ref={containerRef} className="prose-readme">
      <MarkdownPage projectId={projectId} text={text} ctx={ctx} onLink={onLink} />
    </div>
  );
}
