import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ChevronUp, Folder } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../../../lib/api';

interface FolderPickerModalProps {
  initialDir: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

function parentOf(absPath: string): string {
  const parts = absPath.split('/').filter(Boolean);
  if (parts.length === 0) return '/';
  return '/' + parts.slice(0, -1).join('/');
}

export function FolderPickerModal({ initialDir, onSelect, onClose }: FolderPickerModalProps) {
  const [currentDir, setCurrentDir] = useState(initialDir || '/');

  const { data: entries = [], isLoading, error } = useQuery({
    queryKey: ['filesystem-browse', currentDir],
    queryFn: () => api.filesystem.browse(currentDir),
  });
  const folders = entries.filter((e) => e.is_dir);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-surface-panel border border-gray-700 rounded-lg shadow-2xl w-[520px] max-h-[560px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-gray-200">Choose a folder</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-sm">✕</button>
        </div>

        <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800 bg-surface-elevated/40">
          <button
            onClick={() => setCurrentDir(parentOf(currentDir))}
            disabled={currentDir === '/'}
            title="Go up one folder"
            className="p-1 rounded text-gray-400 hover:text-gray-200 hover:bg-surface-elevated transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <span className="flex-1 text-xs font-mono text-gray-400 truncate" title={currentDir}>{currentDir}</span>
        </div>

        <div className="flex-1 overflow-auto py-1 min-h-[200px]">
          {isLoading && <p className="px-4 py-3 text-xs text-gray-500">Loading…</p>}
          {error && <p className="px-4 py-3 text-xs text-red-400">Couldn't open this folder.</p>}
          {!isLoading && !error && folders.length === 0 && (
            <p className="px-4 py-3 text-xs text-gray-600 italic">No subfolders</p>
          )}
          {folders.map((node) => (
            <button
              key={node.path}
              onClick={() => setCurrentDir(node.path)}
              className="w-full flex items-center gap-1.5 py-1 px-3 text-xs text-left text-gray-300 rounded hover:bg-surface-elevated transition-colors"
            >
              <ChevronRight className="w-3 h-3 shrink-0 text-gray-500" />
              <Folder className="w-3.5 h-3.5 shrink-0 text-yellow-500/70" />
              <span className="truncate">{node.name}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-gray-800">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded border border-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onSelect(currentDir)}
            className="px-3 py-1.5 text-xs rounded bg-brand-600 hover:bg-brand-500 text-white transition-colors"
          >
            Save here
          </button>
        </div>
      </div>
    </div>
  );
}
