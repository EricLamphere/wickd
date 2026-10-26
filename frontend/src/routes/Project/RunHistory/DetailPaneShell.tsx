import type { ReactNode } from 'react';
import type { ResizablePane } from './useResizablePane';

/** Drag handle + collapse toggle strip, then the pane's content at its current width. */
export function DetailPaneShell({ pane, children }: { pane: ResizablePane; children: ReactNode }) {
  return (
    <div className="shrink-0 bg-surface-panel border-l border-gray-700 flex flex-row">
      {/* Drag handle + toggle strip */}
      <div
        className="flex flex-col items-center justify-between py-2 border-r border-gray-800 select-none cursor-col-resize bg-surface-panel"
        style={{ width: 20 }}
        onMouseDown={pane.onHandleMouseDown}
      >
        <div className="flex flex-col gap-0.5 items-center opacity-40 mt-2">
          <div className="w-px h-4 bg-gray-500" />
          <div className="w-px h-4 bg-gray-500" />
          <div className="w-px h-4 bg-gray-500" />
        </div>
        <button
          onClick={pane.toggle}
          className="p-0.5 rounded text-gray-500 hover:text-gray-300 transition-colors mb-2"
          title={pane.open ? 'Collapse panel' : 'Expand panel'}
        >
          {pane.open
            ? <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
            : <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
          }
        </button>
      </div>

      {/* Panel content */}
      <div
        style={{ width: pane.open ? pane.width : 0 }}
        className="overflow-hidden flex flex-col transition-none"
      >
        <div style={{ width: pane.width }} className="flex flex-col h-full">
          {children}
        </div>
      </div>
    </div>
  );
}
