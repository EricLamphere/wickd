/**
 * The sticky "new version" bar under the header (plan 32). Shows in the official desktop app
 * only, until the user updates, skips that version, or chooses Later (back next launch).
 */
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronDown, ChevronRight, Download, Loader2, X } from 'lucide-react';
import { alertError } from '../../lib/dialogs';
import { openExternal } from '../../lib/openExternal';
import { useAppUpdate } from '../../lib/updates/useAppUpdate';
import { useUpdateInstall, type InstallState } from '../../lib/updates/useUpdateInstall';

/** The site's Download button target: the latest signed dmg. */
export const MANUAL_DOWNLOAD_URL = 'https://github.com/EricLamphere/wickd/releases/latest/download/wickd_aarch64.dmg';

const BUTTON = 'px-2 py-0.5 rounded text-xs transition-colors';

function progressLabel({ phase, percent }: InstallState): string {
  if (phase === 'installing') return 'Installing…';
  if (phase === 'relaunching') return 'Restarting…';
  return percent === null ? 'Downloading…' : `Downloading… ${percent}%`;
}

function Progress({ state }: { state: InstallState }) {
  return (
    <div className="flex items-center gap-2 ml-auto">
      <Loader2 className="w-3.5 h-3.5 animate-spin text-brand-300" />
      <span className="text-gray-300 tabular-nums">{progressLabel(state)}</span>
      {state.phase === 'downloading' && state.percent !== null && (
        <div className="w-32 h-1.5 bg-gray-800 rounded overflow-hidden">
          <div className="h-full bg-brand-500 transition-all" style={{ width: `${state.percent}%` }} />
        </div>
      )}
    </div>
  );
}

function InstallError({ error, onDismiss }: { error: string; onDismiss: () => void }) {
  const [details, setDetails] = useState(false);
  return (
    <div className="flex flex-col gap-1 px-4 py-2 bg-red-950/40 border-b border-red-900/60 text-xs">
      <div className="flex items-center gap-3">
        <span className="text-red-300">Couldn't install the update automatically.</span>
        <button onClick={() => openExternal(MANUAL_DOWNLOAD_URL)} className={`${BUTTON} bg-red-900/60 hover:bg-red-800/60 text-red-100`}>
          Download it from the website
        </button>
        <button onClick={() => setDetails((d) => !d)} className="text-red-400 hover:text-red-300">
          {details ? 'Hide details' : 'Details'}
        </button>
        <button onClick={onDismiss} className="ml-auto text-red-400 hover:text-red-300" aria-label="Dismiss">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {details && <pre className="text-red-300/80 whitespace-pre-wrap font-mono">{error}</pre>}
    </div>
  );
}

export function UpdateBar() {
  const { update, visible, later, skip } = useAppUpdate();
  const { state, install, reset } = useUpdateInstall(update);
  const [notesOpen, setNotesOpen] = useState(false);

  if (state.phase === 'error' && state.error) return <InstallError error={state.error} onDismiss={reset} />;
  if (!update || (!visible && state.phase === 'idle')) return null;

  const busy = state.phase !== 'idle';
  const onSkip = () => skip().catch(alertError);

  return (
    <div className="shrink-0 border-b border-brand-900/60 bg-brand-950/40 text-xs">
      <div className="flex items-center gap-3 px-4 py-1.5">
        <Download className="w-3.5 h-3.5 text-brand-300 shrink-0" />
        <span className="text-gray-200">
          wickd <span className="font-semibold">{update.version}</span> is available
          <span className="text-gray-500"> (you have {update.currentVersion})</span>
        </span>
        {update.notes && (
          <button onClick={() => setNotesOpen((o) => !o)} className="flex items-center gap-0.5 text-brand-300 hover:text-brand-200">
            {notesOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            What's new
          </button>
        )}
        {busy ? <Progress state={state} /> : (
          <div className="flex items-center gap-1.5 ml-auto">
            <button onClick={install} className={`${BUTTON} bg-brand-600 hover:bg-brand-500 text-white`}>Update &amp; restart</button>
            <button onClick={later} className={`${BUTTON} text-gray-400 hover:text-gray-200 hover:bg-gray-800`}>Later</button>
            <button onClick={onSkip} className={`${BUTTON} text-gray-500 hover:text-gray-300 hover:bg-gray-800`}>Skip this version</button>
          </div>
        )}
      </div>
      {notesOpen && update.notes && (
        <div className="px-10 pb-3 max-h-60 overflow-auto prose-readme">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{update.notes}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
