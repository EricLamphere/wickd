import { useCallback, useMemo, type RefObject } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DocsDataDto } from '../../../../lib/api';
import { docsPagesApi } from '../../../../lib/docsPagesApi';
import { openExternal } from '../../../../lib/openExternal';
import { useProjectEvents } from '../../../../lib/sse';
import { pageNodeId } from '../../lib/docsLastView';
import { buildNodeResolver, type LinkTarget, type NodeRefKind } from '../../lib/docsPageLinks';

/** The project's docs pages, kept fresh by `docs_pages_changed` (and manifest changes for docs block usage). */
export function useDocsPagesList(projectId: number) {
  const qc = useQueryClient();
  useProjectEvents(projectId, useCallback((event) => {
    if (event.type === 'docs_pages_changed') {
      qc.invalidateQueries({ queryKey: ['docs-pages', projectId] });
      qc.invalidateQueries({ queryKey: ['docs-page', projectId] });
    }
    if (event.type === 'graph_changed' || event.type === 'docs_generated') {
      qc.invalidateQueries({ queryKey: ['docs-page', projectId] });
    }
  }, [projectId, qc]));
  return useQuery({
    queryKey: ['docs-pages', projectId],
    queryFn: () => docsPagesApi.list(projectId),
    staleTime: 30_000,
  });
}

export function useDocsPage(projectId: number, path: string | null) {
  return useQuery({
    queryKey: ['docs-page', projectId, path],
    queryFn: () => docsPagesApi.content(projectId, path!),
    enabled: path !== null,
  });
}

/**
 * Resolves `ref:` / `source:` links against the generated docs. It only reads the cache the Docs
 * page fills (never fetches: the project home page shouldn't load the whole docs blob for a
 * README), so links render as plain text until docs have been opened this session.
 */
export function useNodeResolver(projectId: number): (kind: NodeRefKind, name: string) => string | null {
  const { data } = useQuery<DocsDataDto>({ queryKey: ['docs-data', projectId], queryFn: () => api.docs.data(projectId), enabled: false });
  return useMemo(() => buildNodeResolver(data?.nodes ?? []), [data]);
}

export function scrollToAnchor(root: HTMLElement | null, id: string): void {
  if (!root || !id) return;
  root.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * What clicking a rendered link does. On the Docs page (`inDocs`) pages and nodes are selected in
 * place (a history entry each); elsewhere they open the Docs page.
 */
export function useMarkdownLinkHandler(projectId: number, containerRef: RefObject<HTMLElement | null>, inDocs: boolean) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  return useCallback((target: LinkTarget) => {
    const openDocs = (node: string, browse: string | null, anchor: string | null) => {
      const params = inDocs ? new URLSearchParams(searchParams) : new URLSearchParams();
      params.set('node', node);
      params.delete('view');
      if (browse) params.set('browse', browse);
      const hash = anchor ? `#${encodeURIComponent(anchor)}` : '';
      navigate(inDocs ? { search: `?${params}`, hash } : { pathname: `/projects/${projectId}/docs`, search: `?${params}`, hash });
    };
    switch (target.kind) {
      case 'external': openExternal(target.href); return;
      case 'anchor': scrollToAnchor(containerRef.current, target.id); return;
      case 'file': navigate(`/projects/${projectId}/files?path=${encodeURIComponent(target.path)}`); return;
      case 'page': openDocs(pageNodeId(target.path), 'pages', target.anchor); return;
      case 'node': openDocs(target.uid, searchParams.get('browse') === 'pages' || !inDocs ? 'project' : null, null); return;
      default: return;
    }
  }, [containerRef, inDocs, navigate, projectId, searchParams]);
}
