import { useMemo } from 'react';
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen } from 'lucide-react';
import type { DocsPageDto } from '../../../../lib/docsPagesApi';
import { pageNodeId } from '../../lib/docsLastView';
import { buildPagesTree, filterPages, type PageDir } from './pageFolders';

interface PagesTreeProps {
  pages: DocsPageDto[];
  selectedNode: string | null;
  onSelect: (node: string) => void;
  filterQ: string;
  expanded: Set<string>;
  onToggle: (key: string, open: boolean) => void;
}

/** The docs folder's pages as a folder tree, filtered by title and path. Folders open while filtering. */
export function PagesTree({ pages, selectedNode, onSelect, filterQ, expanded, onToggle }: PagesTreeProps) {
  const tree = useMemo(() => buildPagesTree(filterPages(pages, filterQ)), [pages, filterQ]);
  if (tree.dirs.length === 0 && tree.pages.length === 0) {
    return <p className="text-xs text-gray-600 italic px-3 py-4">{filterQ ? 'No pages match.' : 'No Markdown pages in the docs folder yet.'}</p>;
  }
  return (
    <DirContents dir={tree} depth={1} forceOpen={filterQ.trim().length > 0}
      selectedNode={selectedNode} onSelect={onSelect} expanded={expanded} onToggle={onToggle} />
  );
}

interface DirContentsProps extends Omit<PagesTreeProps, 'pages' | 'filterQ'> {
  dir: PageDir;
  depth: number;
  forceOpen: boolean;
}

function DirContents({ dir, depth, forceOpen, selectedNode, onSelect, expanded, onToggle }: DirContentsProps) {
  const indent = depth * 12;
  return (
    <>
      {dir.dirs.map((child) => {
        const open = forceOpen || expanded.has(child.key);
        return (
          <div key={child.key}>
            <button
              onClick={() => onToggle(child.key, !open)}
              style={{ paddingLeft: indent }}
              className="w-full text-left py-1 pr-3 text-xs flex items-center gap-1.5 text-gray-500 hover:text-gray-300 transition-colors"
            >
              <span className="shrink-0 text-gray-600">{open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}</span>
              <span className="shrink-0 text-gray-600">{open ? <FolderOpen className="w-3.5 h-3.5" /> : <Folder className="w-3.5 h-3.5" />}</span>
              <span className="truncate">{child.name}</span>
            </button>
            {open && (
              <DirContents dir={child} depth={depth + 1} forceOpen={forceOpen}
                selectedNode={selectedNode} onSelect={onSelect} expanded={expanded} onToggle={onToggle} />
            )}
          </div>
        );
      })}
      {dir.pages.map((page) => {
        const node = pageNodeId(page.path);
        const selected = node === selectedNode;
        return (
          <button
            key={page.path}
            onClick={() => onSelect(node)}
            title={page.path}
            style={{ paddingLeft: indent + 4 }}
            className={`w-full text-left py-1 pr-3 text-xs flex items-center gap-1.5 transition-colors
              ${selected ? 'bg-brand-900/40 text-brand-300' : 'text-gray-400 hover:text-gray-200 hover:bg-surface-elevated/50'}`}
          >
            <FileText className={`w-3.5 h-3.5 shrink-0 ${selected ? 'text-brand-400' : 'text-sky-400'}`} />
            <span className="truncate">{page.title}</span>
            {selected && <ChevronRight className="w-3 h-3 ml-auto shrink-0 opacity-60" />}
          </button>
        );
      })}
    </>
  );
}
