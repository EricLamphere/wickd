import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw, XCircle } from 'lucide-react';
import { aiApi, aiErrorMessage, type AiProposalDto } from '../../../../lib/aiApi';
import { refactorCounts } from './proposalFiles';

interface RefactorOutcomeProps {
  projectId: number;
  proposal: AiProposalDto;
  /** The latest proposal after Undo (callers that hold their own copy, e.g. RefactorHost). */
  onChange?: (proposal: AiProposalDto) => void;
}

function VerifyLine({ proposal }: { proposal: AiProposalDto }) {
  const verify = proposal.result.verify;
  if (!verify) return null;
  if (verify.status === 'running') {
    return <span className="flex items-center gap-1.5 text-gray-400"><Loader2 size={12} className="animate-spin" /> Checking with dbt parse…</span>;
  }
  if (verify.status === 'ok') {
    return <span className="flex items-center gap-1.5 text-emerald-400"><CheckCircle2 size={12} /> dbt parse passed</span>;
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-red-400"><XCircle size={12} /> dbt parse failed. Fix it by hand, or undo the refactor.</span>
      {verify.output && (
        <pre className="max-h-40 overflow-auto px-2 py-1.5 rounded bg-surface-app border border-gray-800 text-[11px] text-gray-400 whitespace-pre-wrap">
          {verify.output}
        </pre>
      )}
    </div>
  );
}

/**
 * What a refactor did: file / manual counts, then (once applied) the dbt parse
 * check with Undo, the edits left for the user, and notes.
 */
export function RefactorOutcome({ projectId, proposal: p, onChange }: RefactorOutcomeProps) {
  const qc = useQueryClient();
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const manual = p.result.manual ?? [];
  const notes = p.result.notes ?? [];
  const applied = p.status === 'applied';

  const undo = async () => {
    setUndoing(true);
    setError(null);
    try {
      const updated = await aiApi.undo(projectId, p.id);
      onChange?.(updated);
      qc.invalidateQueries({ queryKey: ['ai-proposals', projectId] });
      qc.invalidateQueries({ queryKey: ['ai-conversation', projectId] });
    } catch (err) {
      setError(aiErrorMessage(err));
    } finally {
      setUndoing(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-gray-500">{refactorCounts(p)}</span>
      {applied && (
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0"><VerifyLine proposal={p} /></div>
          <button
            onClick={undo}
            disabled={undoing || p.result.verify?.status === 'running'}
            title="Restore every file this refactor changed (only while none was edited since)"
            className="flex items-center gap-1 px-2 py-1 rounded bg-surface-elevated border border-gray-700 text-gray-300 hover:bg-gray-700 disabled:opacity-40"
          >
            {undoing ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />} Undo
          </button>
        </div>
      )}
      {p.status === 'undone' && <span className="text-gray-400">Undone. Every file was restored.</span>}
      {error && <span className="text-red-400 whitespace-pre-wrap break-words">{error}</span>}
      {manual.length > 0 && (applied || p.status === 'ready') && (
        <details className="group" open={applied}>
          <summary className="flex items-center gap-1.5 cursor-pointer text-amber-400">
            <AlertTriangle size={12} /> {manual.length} to check by hand
          </summary>
          <ul className="flex flex-col gap-1 mt-1">
            {manual.map((m) => (
              <li key={`${m.path}:${m.line}:${m.reason}`} className="text-gray-400">
                <code className="text-gray-300">{m.path}:{m.line}</code> {m.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {notes.map((note) => <span key={note} className="text-gray-500">{note}</span>)}
    </div>
  );
}
