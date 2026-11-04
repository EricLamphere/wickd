import { createContext, useCallback, useContext } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * What differs between one project's Docs page and the home page's combined docs. The
 * detail components stay the same; they ask the scope how to address a node.
 */
export interface DocsScope {
  /** The `?node=` value that selects this node (combined docs prefix it with its project). */
  nodeParam: (uid: string) => string;
  /** Project-page actions that need ProjectLayout (refactors, proposals review). */
  canEdit: boolean;
}

const PROJECT_SCOPE: DocsScope = { nodeParam: (uid) => uid, canEdit: true };

const DocsScopeContext = createContext<DocsScope>(PROJECT_SCOPE);

export const DocsScopeProvider = DocsScopeContext.Provider;

export function useDocsScope(): DocsScope {
  return useContext(DocsScopeContext);
}

/**
 * Selects a docs node as a new history entry (so back/forward steps through it),
 * keeping the browse tab and dropping the previous node's detail tab (?view=).
 */
export function useSelectDocsNode(): (uid: string) => void {
  const [searchParams, setSearchParams] = useSearchParams();
  const { nodeParam } = useDocsScope();
  return useCallback((uid: string) => {
    const param = nodeParam(uid);
    if (searchParams.get('node') === param) return;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('node', param);
      next.delete('view');
      return next;
    });
  }, [searchParams, setSearchParams, nodeParam]);
}
