import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import type { GraphDto } from '../../../../lib/api';
import { WickyContent } from './WickyContent';
import type { ChatRequest } from './AiChat';
import { OPEN_WICKY_EVENT, type OpenWickyDetail } from '../../lib/wickyEvents';

interface WickyPaneProps {
  projectId: number;
  graph: GraphDto | null;
  /** Node selected on the current page (SelectedNodeContext); null → project-level context. */
  selectedNodeId: string | null;
}

const MIN_WIDTH = 280;
const DEFAULT_WIDTH = 360;
const MAX_WIDTH = 900;
const COLLAPSE_THRESHOLD = 120;
const OPEN_KEY = 'wickd:wicky-open';
const WIDTH_KEY = 'wickd:wicky-width';

function readStored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStored(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

function storedWidth(): number {
  const n = parseInt(readStored(WIDTH_KEY) ?? '', 10);
  return Number.isFinite(n) && n >= MIN_WIDTH && n <= MAX_WIDTH ? n : DEFAULT_WIDTH;
}

/**
 * Wicky, the AI assistant, as a right-hand panel on every project page. Open
 * state and width persist; ⌘I toggles it. Follows the page's selected node.
 */
export function WickyPane({ projectId, graph, selectedNodeId }: WickyPaneProps) {
  const [open, setOpen] = useState(() => readStored(OPEN_KEY) === 'true');
  const [width, setWidth] = useState(storedWidth);
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  const [request, setRequest] = useState<ChatRequest | null>(null);

  const model = selectedNodeId ? graph?.nodes.find((n) => n.unique_id === selectedNodeId) ?? null : null;

  useEffect(() => writeStored(OPEN_KEY, String(open)), [open]);

  // Closing drops a request that never reached the chat (e.g. Wicky not set up yet)
  useEffect(() => { if (!open) setRequest(null); }, [open]);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const { question = '', chatMode } = (e as CustomEvent<OpenWickyDetail>).detail ?? {};
      setOpen(true);
      setRequest({ nonce: Date.now(), text: question, mode: 'ask', chatMode });
    };
    window.addEventListener(OPEN_WICKY_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_WICKY_EVENT, onOpen);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!drag.current) return;
      setWidth(Math.min(MAX_WIDTH, Math.max(0, drag.current.startW + drag.current.startX - e.clientX)));
    };
    const onUp = () => {
      if (!drag.current) return;
      drag.current = null;
      setWidth((w) => {
        if (w < COLLAPSE_THRESHOLD) {
          setOpen(false);
          return storedWidth();
        }
        const clamped = Math.max(MIN_WIDTH, w);
        writeStored(WIDTH_KEY, String(clamped));
        return clamped;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  return (
    <div className="flex flex-row shrink-0 bg-surface-panel border-l border-gray-700">
      <div
        className="flex flex-col items-center justify-between w-5 py-2 border-r border-gray-800 bg-surface-panel select-none cursor-col-resize"
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          if (!open) { setOpen(true); setWidth(0); }
          drag.current = { startX: e.clientX, startW: open ? width : 0 };
          e.preventDefault();
        }}
      >
        {open ? <span /> : (
          <button
            onClick={() => setOpen(true)}
            className="flex flex-col items-center gap-2 p-0.5 rounded text-brand-300 hover:text-brand-200"
            title="Ask Wicky (⌘I)"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span className="text-[10px] font-medium tracking-wide [writing-mode:vertical-rl]">Wicky</span>
          </button>
        )}
        <button
          onClick={() => setOpen((v) => !v)}
          className="p-0.5 rounded text-gray-500 hover:text-gray-300"
          title={open ? 'Collapse Wicky' : 'Expand Wicky'}
        >
          {open ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronLeft className="w-3.5 h-3.5" />}
        </button>
      </div>

      <div style={{ width: open ? width : 0 }} className="overflow-hidden flex flex-col" aria-hidden={!open}>
        {open && (
          <div style={{ width }} className="flex flex-col h-full">
            <div className="flex items-center gap-1.5 px-3 py-2 border-b border-gray-800 shrink-0">
              <Sparkles className="w-3.5 h-3.5 text-brand-300" />
              <span className="text-xs font-semibold text-gray-200">Wicky</span>
              <span className="ml-auto text-[10px] text-gray-600 truncate">
                {model ? model.name : 'Project'}
              </span>
            </div>
            <div className="flex-1 min-h-0">
              <WickyContent
                projectId={projectId}
                model={model}
                graph={graph}
                request={request}
                onRequestTaken={() => setRequest(null)}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
