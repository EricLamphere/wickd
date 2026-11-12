import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { SingleTerminal } from './TerminalPanel';

interface TermTab {
  id: string; // unique per instance
  label: string;
}

let termIdCounter = 0;
function newTermTab(): TermTab {
  termIdCounter += 1;
  return { id: `term-${termIdCounter}`, label: 'bash' };
}

interface TerminalAreaProps {
  /** Folder new terminals start in; null while it's loading. */
  cwd: string | null;
  /** The Terminal tab is showing: opens a first terminal if there is none. */
  active: boolean;
  height: number;
  loadingLabel?: string;
}

/**
 * The bottom pane's Terminal tab: terminal canvases with a VSCode-style tab strip on the
 * right. Every terminal stays mounted once created (hidden when inactive) so sessions survive.
 */
export function TerminalArea({ cwd, active, height, loadingLabel = 'Loading project…' }: TerminalAreaProps) {
  const [termTabs, setTermTabs] = useState<TermTab[]>([]);
  const [activeTermId, setActiveTermId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; termId: string } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const wasActive = useRef(false);

  const addTerminal = useCallback(() => {
    const t = newTermTab();
    setTermTabs((prev) => [...prev, t]);
    setActiveTermId(t.id);
  }, []);

  // Showing the tab with no terminals starts one (closing the last while it shows leaves it empty)
  useEffect(() => {
    if (active && !wasActive.current && termTabs.length === 0) addTerminal();
    wasActive.current = active;
  }, [active, termTabs.length, addTerminal]);

  const closeTerminal = useCallback((id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setTermTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      setActiveTermId((cur) => {
        if (cur !== id) return cur;
        if (next.length === 0) return null;
        const idx = prev.findIndex((t) => t.id === id);
        return next[Math.min(idx, next.length - 1)].id;
      });
      return next;
    });
  }, []);

  const startRename = useCallback((id: string, currentLabel: string) => {
    setRenamingId(id);
    setRenameValue(currentLabel);
    setCtxMenu(null);
    setTimeout(() => renameInputRef.current?.select(), 30);
  }, []);

  const commitRename = useCallback(() => {
    if (!renamingId) return;
    const val = renameValue.trim();
    if (val) setTermTabs((prev) => prev.map((t) => (t.id === renamingId ? { ...t, label: val } : t)));
    setRenamingId(null);
  }, [renamingId, renameValue]);

  // Close the context menu on an outside click
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    return () => { window.removeEventListener('click', close); window.removeEventListener('contextmenu', close); };
  }, [ctxMenu]);

  return (
    <>
      <div style={{ height: active ? height : 0 }} className="overflow-hidden flex flex-row" aria-hidden={!active}>
        {/* Terminal canvases — all mounted, only one visible */}
        <div className="flex-1 overflow-hidden relative">
          {termTabs.map((t) => (
            <div
              key={t.id}
              className="absolute inset-0"
              style={{ display: activeTermId === t.id ? 'flex' : 'none', flexDirection: 'column' }}
            >
              {cwd ? (
                <SingleTerminal instanceId={t.id} projectPath={cwd} />
              ) : (
                <div className="flex-1 flex items-center justify-center text-xs text-gray-600">{loadingLabel}</div>
              )}
            </div>
          ))}
          {termTabs.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-600">No terminals open</div>
          )}
        </div>

        {/* Terminal tab strip (right side, VSCode style) */}
        <div className="w-44 shrink-0 border-l border-gray-800 flex flex-col bg-surface-panel overflow-hidden">
          <div className="flex items-center justify-between px-2 py-1 border-b border-gray-800 shrink-0">
            <span className="text-[10px] text-gray-600 uppercase tracking-wide font-medium">Terminals</span>
            <button
              onClick={addTerminal}
              title="New terminal"
              className="p-0.5 rounded text-gray-500 hover:text-gray-200 hover:bg-gray-700 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {termTabs.map((t) => (
              <div
                key={t.id}
                onClick={() => setActiveTermId(t.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu({ x: e.clientX, y: e.clientY, termId: t.id });
                }}
                onDoubleClick={() => startRename(t.id, t.label)}
                className={`group flex items-center gap-1 px-2 py-1.5 cursor-pointer select-none transition-colors
                  ${activeTermId === t.id ? 'bg-brand-900/40 text-brand-300' : 'text-gray-500 hover:bg-gray-800 hover:text-gray-300'}`}
              >
                {renamingId === t.id ? (
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename();
                      if (e.key === 'Escape') setRenamingId(null);
                      e.stopPropagation();
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="flex-1 min-w-0 bg-gray-800 border border-brand-600 rounded px-1 text-xs text-gray-100 outline-none"
                    autoFocus
                  />
                ) : (
                  <span className="flex-1 min-w-0 text-xs truncate">{t.label}</span>
                )}
                <button
                  onClick={(e) => closeTerminal(t.id, e)}
                  className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-gray-600 hover:text-gray-100"
                  title="Close terminal"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {ctxMenu && (
        <div
          className="fixed z-50 bg-gray-900 border border-gray-700 rounded shadow-xl py-1 min-w-[140px]"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700 transition-colors"
            onClick={() => {
              const t = termTabs.find((tab) => tab.id === ctxMenu.termId);
              if (t) startRename(t.id, t.label);
            }}
          >
            Rename
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-gray-700 transition-colors"
            onClick={() => { closeTerminal(ctxMenu.termId); setCtxMenu(null); }}
          >
            Close terminal
          </button>
        </div>
      )}
    </>
  );
}
