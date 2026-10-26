import { useLayoutEffect, useRef, useState } from 'react';
import type { TreeNode } from './types';

export type TreeAction =
  | 'new-file' | 'new-folder' | 'reveal'
  | 'cut' | 'copy' | 'paste' | 'duplicate'
  | 'copy-path' | 'copy-relative-path'
  | 'rename' | 'delete';

interface ContextMenuProps {
  x: number;
  y: number;
  /** null = the tree's empty space (acts on the project root) */
  node: TreeNode | null;
  /** How many items the action applies to (the selection, when the node is part of it). */
  count: number;
  canPaste: boolean;
  onAction: (action: TreeAction) => void;
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
const MOD = IS_MAC ? '⌘' : 'Ctrl+';

export const REVEAL_LABEL = IS_MAC
  ? 'Reveal in Finder'
  : /Win/i.test(typeof navigator !== 'undefined' ? navigator.platform : '') ? 'Reveal in File Explorer' : 'Open Containing Folder';

function Item({ label, hint, onClick, danger = false, disabled = false }: {
  label: string; hint?: string; onClick: () => void; danger?: boolean; disabled?: boolean;
}) {
  return (
    <button
      // On click, not mousedown: an action that opens an inline name box would otherwise
      // have the rest of the click land on the tree and blur (cancel) it straight away.
      // The menu's own onMouseDown keeps the window's dismiss listener from firing first.
      onClick={(e) => { e.stopPropagation(); if (!disabled) onClick(); }}
      disabled={disabled}
      className={`w-full flex items-center gap-6 px-3 py-1.5 text-left text-xs rounded-sm transition-colors
        ${danger ? 'text-red-400 hover:bg-red-900/30' : 'text-gray-300 hover:bg-gray-700'}
        ${disabled ? 'opacity-40 cursor-not-allowed hover:bg-transparent' : ''}`}
    >
      <span className="flex-1">{label}</span>
      {hint && <span className="text-gray-500">{hint}</span>}
    </button>
  );
}

function Divider() {
  return <div className="my-1 border-t border-gray-700" />;
}

export function ContextMenu({ x, y, node, count, canPaste, onAction }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    setPos({
      x: x + rect.width > window.innerWidth ? window.innerWidth - rect.width - 8 : x,
      y: y + rect.height > window.innerHeight ? window.innerHeight - rect.height - 8 : y,
    });
  }, [x, y]);

  const many = count > 1;
  const act = (a: TreeAction) => () => onAction(a);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[220px] bg-surface-panel border border-gray-700 rounded-lg shadow-xl py-1 text-sm"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Item label="New File…" onClick={act('new-file')} />
      <Item label="New Folder…" onClick={act('new-folder')} />
      <Item label={REVEAL_LABEL} onClick={act('reveal')} disabled={many} />
      <Divider />
      {node && <Item label={many ? `Cut ${count} items` : 'Cut'} hint={`${MOD}X`} onClick={act('cut')} />}
      {node && <Item label={many ? `Copy ${count} items` : 'Copy'} hint={`${MOD}C`} onClick={act('copy')} />}
      <Item label="Paste" hint={`${MOD}V`} onClick={act('paste')} disabled={!canPaste} />
      {node && <Item label="Duplicate" onClick={act('duplicate')} />}
      <Divider />
      <Item label="Copy Path" hint={IS_MAC ? '⌥⌘C' : 'Shift+Alt+C'} onClick={act('copy-path')} disabled={many} />
      <Item label="Copy Relative Path" hint={IS_MAC ? '⌥⇧⌘C' : 'Ctrl+Shift+Alt+C'} onClick={act('copy-relative-path')} disabled={many} />
      {node && (
        <>
          <Divider />
          <Item label="Rename…" hint={IS_MAC ? 'Enter' : 'F2'} onClick={act('rename')} disabled={many} />
          <Item label={many ? `Delete ${count} items` : 'Delete'} hint={IS_MAC ? '⌘⌫' : 'Delete'} onClick={act('delete')} danger />
        </>
      )}
    </div>
  );
}
