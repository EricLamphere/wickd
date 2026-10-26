import type { DragEvent, MouseEvent } from 'react';
import { FileIcon } from './FileIcon';
import { InlineNameInput } from './InlineNameInput';
import type { TreeNode } from './types';

export const ROW_INDENT = 12;
export const ROW_PAD = 8;

interface TreeRowProps {
  node: TreeNode;
  depth: number;
  active: boolean;
  selected: boolean;
  focused: boolean;
  cut: boolean;
  inDropTarget: boolean;
  loading: boolean;
  renaming: boolean;
  onClick: (e: MouseEvent, node: TreeNode) => void;
  onContextMenu: (e: MouseEvent, node: TreeNode) => void;
  onRename: (node: TreeNode, name: string) => void;
  onRenameCancel: () => void;
  onDragStart: (e: DragEvent, node: TreeNode) => void;
  onDragOver: (e: DragEvent, node: TreeNode) => void;
  onDrop: (e: DragEvent, node: TreeNode) => void;
  onDragEnd: () => void;
}

function rowColors({ active, selected, inDropTarget }: Pick<TreeRowProps, 'active' | 'selected' | 'inDropTarget'>): string {
  if (inDropTarget) return 'bg-brand-900/40 text-gray-100';
  if (selected) return active ? 'bg-brand-900/60 text-brand-200' : 'bg-gray-700/50 text-gray-100';
  if (active) return 'bg-brand-900/30 text-brand-300';
  return 'text-gray-400 hover:bg-surface-elevated/60 hover:text-gray-200';
}

export function TreeRow(props: TreeRowProps) {
  const { node, depth, focused, cut, loading, renaming } = props;
  return (
    <div
      role="treeitem"
      aria-selected={props.selected}
      aria-expanded={node.is_dir ? !!node.expanded : undefined}
      data-path={node.path}
      draggable={!renaming}
      onClick={(e) => props.onClick(e, node)}
      onContextMenu={(e) => props.onContextMenu(e, node)}
      onDragStart={(e) => props.onDragStart(e, node)}
      onDragOver={(e) => props.onDragOver(e, node)}
      onDrop={(e) => props.onDrop(e, node)}
      onDragEnd={props.onDragEnd}
      title={node.path}
      className={`flex items-center gap-1.5 py-[3px] pr-2 text-xs cursor-pointer select-none rounded-sm border
        ${focused ? 'border-brand-500/60' : 'border-transparent'} ${rowColors(props)} ${cut ? 'opacity-50' : ''}`}
      style={{ paddingLeft: depth * ROW_INDENT + ROW_PAD }}
    >
      <span className="w-3 shrink-0 text-[10px] text-gray-600">
        {node.is_dir ? (node.expanded ? '▼' : '▶') : ''}
      </span>
      <FileIcon name={node.name} isDir={node.is_dir} expanded={node.expanded} />
      {renaming ? (
        <InlineNameInput
          initial={node.name}
          onSubmit={(name) => props.onRename(node, name)}
          onCancel={props.onRenameCancel}
        />
      ) : (
        <span className="truncate">{node.name}</span>
      )}
      {loading && (
        <svg className="w-3 h-3 animate-spin ml-auto shrink-0 text-brand-400" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
        </svg>
      )}
    </div>
  );
}

interface NewEntryRowProps {
  depth: number;
  isDir: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

/** The inline "name your new file/folder" row, shown at the top of the target folder. */
export function NewEntryRow({ depth, isDir, onSubmit, onCancel }: NewEntryRowProps) {
  return (
    <div className="flex items-center gap-1.5 py-[3px] pr-2" style={{ paddingLeft: depth * ROW_INDENT + ROW_PAD }}>
      <span className="w-3 shrink-0" />
      <FileIcon name={isDir ? 'folder' : 'new'} isDir={isDir} />
      <InlineNameInput initial="" onSubmit={onSubmit} onCancel={onCancel} />
    </div>
  );
}
