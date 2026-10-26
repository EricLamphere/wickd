import { useCallback } from 'react';
import Editor from '@monaco-editor/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type GraphDto } from '../../../../lib/api';
import { useProjectEvents } from '../../../../lib/sse';
import { useTheme } from '../../../../lib/useTheme';
import { useOpenInFiles } from '../../lib/openInFiles';

interface NodeSqlPanelProps {
  projectId: number;
  graph: GraphDto | null;
  selectedNodeId: string | null;
}

const CODE_LANGUAGES: Record<string, string> = { sql: 'sql', py: 'python' };

function codeLanguage(path: string | null): string | null {
  const ext = path?.split('.').pop()?.toLowerCase() ?? '';
  return CODE_LANGUAGES[ext] ?? null;
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-gray-600 select-none">
      {message}
    </div>
  );
}

/** Node SQL tab: the selected node's uncompiled source, read straight from its
 *  file (so unsaved-to-manifest edits show up), read-only. */
export function NodeSqlPanel({ projectId, graph, selectedNodeId }: NodeSqlPanelProps) {
  const qc = useQueryClient();
  const theme = useTheme();
  const { canOpen, open } = useOpenInFiles(projectId);

  const node = graph?.nodes.find((n) => n.unique_id === selectedNodeId) ?? null;
  const path = node?.original_file_path ?? null;
  const language = codeLanguage(path);

  const { data, error, isLoading } = useQuery({
    queryKey: ['file-content', projectId, path],
    queryFn: () => api.files.getContent(projectId, path as string),
    enabled: !!path && !!language,
  });

  useProjectEvents(projectId, useCallback((event) => {
    if (event.type === 'files_changed') {
      qc.invalidateQueries({ queryKey: ['file-content', projectId] });
    }
  }, [projectId, qc]));

  if (!selectedNodeId) {
    return <EmptyState message="Select a node in the DAG or open a model file to see its SQL." />;
  }
  if (!graph) return <EmptyState message="Loading graph…" />;
  if (!node) return <EmptyState message="The selected node isn't in the project graph." />;
  if (!path || !language) {
    return <EmptyState message={`${node.name} is a ${node.resource_type} defined in ${path ?? 'YAML'} — it has no SQL of its own.`} />;
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-1 border-b border-gray-800 shrink-0 select-none">
        <span className="text-xs font-mono text-gray-300 truncate">{node.name}</span>
        <span className="text-xs font-mono text-gray-600 truncate">{path}</span>
        <span className="text-xs text-gray-600">· read-only</span>
        {canOpen(node.unique_id) && (
          <button
            onClick={() => open(node.unique_id)}
            className="ml-auto text-xs text-brand-400 hover:text-brand-300"
          >
            Open in Files
          </button>
        )}
      </div>
      <div className="flex-1 overflow-hidden">
        {isLoading ? (
          <EmptyState message="Loading…" />
        ) : error ? (
          <EmptyState message={`Couldn't read ${path}: ${error instanceof Error ? error.message : String(error)}`} />
        ) : (
          <Editor
            key={path}
            language={language}
            value={data?.content ?? ''}
            theme={theme === 'light' ? 'vs-light' : 'vs-dark'}
            options={{
              readOnly: true,
              domReadOnly: true,
              fontSize: 13,
              fontFamily: 'Menlo, Monaco, "Courier New", monospace',
              lineNumbers: 'on',
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              wordWrap: 'off',
              tabSize: 2,
              automaticLayout: true,
              padding: { top: 8 },
            }}
          />
        )}
      </div>
    </div>
  );
}
