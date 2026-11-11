import { useEffect, useId, useState } from 'react';
import { useTheme } from '../../../../lib/useTheme';

type Mermaid = typeof import('mermaid').default;
type AmdWindow = Window & { define?: unknown };

let mermaidPromise: Promise<Mermaid> | null = null;
let amdSwaps = 0;
let savedDefine: unknown;

type Define = ((...args: unknown[]) => unknown) & { amd?: unknown };

/**
 * Monaco's AMD loader leaves a global `define`, and mermaid's bundled UMD dependencies register
 * with it instead of exporting ("Can only have one anonymous define call per script file").
 * - While mermaid's modules evaluate (`hide`), `define` is removed: fastdom checks only
 *   `typeof define`. This window is the module import only, kept short because a Monaco module
 *   loading meanwhile would find no `define`.
 * - While rendering (mermaid lazy-loads each diagram type), `define` is a forwarder without
 *   `.amd`, which UMD wrappers that check `define.amd` skip and Monaco can still call.
 * Overlapping calls (several diagrams) restore the saved `define` when the last one ends.
 */
async function withAmdSwapped<T>(mode: 'hide' | 'forward', fn: () => Promise<T>): Promise<T> {
  const win = window as AmdWindow;
  if (amdSwaps++ === 0) savedDefine = win.define;
  if (typeof savedDefine === 'function') {
    const original = savedDefine as Define;
    win.define = mode === 'hide'
      ? undefined
      : function forwardDefine(this: unknown, ...args: unknown[]) { return original.apply(this, args); };
  }
  try {
    return await fn();
  } finally {
    if (--amdSwaps === 0) win.define = savedDefine;
  }
}

function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= withAmdSwapped('hide', () => import('mermaid'))
    .then((m) => m.default)
    .catch((err: unknown) => { mermaidPromise = null; throw err; });
  return mermaidPromise;
}

type State = { kind: 'loading' } | { kind: 'ready'; svg: string } | { kind: 'error'; message: string };

/**
 * A ```mermaid block. mermaid is large, so it is imported only when a page contains one.
 * `securityLevel: 'strict'` makes mermaid sanitize labels and disables click handlers, so the
 * SVG it returns is safe to inject.
 */
export function MermaidDiagram({ code }: { code: string }) {
  const theme = useTheme();
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    loadMermaid()
      .then((mermaid) => withAmdSwapped('forward', async () => {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: theme === 'light' ? 'default' : 'dark' });
        return (await mermaid.render(id, code)).svg;
      }))
      .then((svg) => { if (!cancelled) setState({ kind: 'ready', svg }); })
      .catch((err: unknown) => {
        // mermaid leaves its error element behind on a failed render
        document.getElementById(`d${id}`)?.remove();
        if (!cancelled) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
  }, [code, id, theme]);

  if (state.kind === 'ready') {
    return <div className="my-4 flex justify-center overflow-x-auto" dangerouslySetInnerHTML={{ __html: state.svg }} />;
  }
  return (
    <div className="my-4">
      {state.kind === 'error' && (
        <p className="mb-1 text-xs text-red-400">Couldn't draw this diagram: {state.message}</p>
      )}
      <pre className={state.kind === 'loading' ? 'opacity-60' : ''}><code>{code}</code></pre>
    </div>
  );
}
