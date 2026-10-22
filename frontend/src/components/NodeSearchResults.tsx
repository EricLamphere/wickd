import type { NodeSearchHit, Project } from '../lib/api';
import { nodeSearchSubtitle, nodeSearchUrl, unindexedNotice } from '../lib/nodeSearch';
import { useNodeSearch } from '../lib/useNodeSearch';
import { typeIconFor } from '../routes/Project/lib/nodeTypeIcon';

interface NodeSearchResultsProps {
  query: string;
  projects: Project[];
  onOpen: (url: string) => void;
}

function HitRow({ hit, onOpen }: { hit: NodeSearchHit; onOpen: (url: string) => void }) {
  return (
    <button
      onClick={(e) => onOpen(nodeSearchUrl(hit, e.metaKey || e.ctrlKey ? 'files' : 'dag'))}
      title="Open in the DAG (⌘-click to open the file)"
      className="w-full flex items-start gap-3 px-3 py-2 text-left rounded-lg hover:bg-surface-elevated focus:bg-surface-elevated focus:outline-none transition-colors"
    >
      <span className="w-4 shrink-0 text-center text-sm leading-5 text-gray-500">{typeIconFor(hit.resource_type)}</span>
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2">
          <span className="text-sm text-gray-200 truncate">{hit.name}</span>
          <span className="text-[10px] text-gray-600 shrink-0">{hit.resource_type}</span>
        </span>
        <span className="block text-xs font-mono text-gray-600 truncate">{nodeSearchSubtitle(hit)}</span>
        {hit.description && (
          <span className="block text-xs text-gray-500 truncate">{hit.description}</span>
        )}
      </span>
    </button>
  );
}

/** Home page: models, sources, seeds, snapshots, exposures and columns matching the search box, across all projects. */
export function NodeSearchResults({ query, projects, onOpen }: NodeSearchResultsProps) {
  const { data, pending, error } = useNodeSearch(query);
  const notice = data ? unindexedNotice(data.unindexed_project_ids, projects) : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-1">
        <span className="text-xs text-gray-600 font-medium">Models &amp; columns</span>
        {pending && <span className="text-[11px] text-gray-700">searching…</span>}
      </div>
      {error && <p className="px-1 text-xs text-red-400">Search failed: {String(error)}</p>}
      {data && data.hits.length === 0 && (
        <p className="px-1 text-xs text-gray-600">No models, sources or columns match “{query.trim()}”.</p>
      )}
      {data && data.hits.length > 0 && (
        <div className="flex flex-col border border-gray-800 rounded-lg p-1 bg-surface-panel">
          {data.hits.map((hit) => (
            <HitRow key={`${hit.project_id}:${hit.unique_id}`} hit={hit} onOpen={onOpen} />
          ))}
        </div>
      )}
      {data?.truncated && (
        <p className="px-1 text-[11px] text-gray-600">Showing the top {data.hits.length} matches. Keep typing to narrow it down.</p>
      )}
      {notice && <p className="px-1 text-[11px] text-gray-600">{notice}</p>}
    </div>
  );
}
