import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Ban, CheckCircle2, Eye, Info, Loader2, RotateCcw, X } from 'lucide-react';
import {
  aiApi, type AiProposalDto, type AiProposalProgress, type AiSuggestedTest,
} from '../../../../lib/aiApi';
import { parsePartialDocs, type PartialDocs } from '../../../../lib/partialDocs';
import { describeTest, parsePartialTests, type PartialTest } from '../../../../lib/partialTests';
import { ProposalReviewModal } from './ProposalReviewModal';
import { proposalItems, selectedKeys } from './proposalItems';
import { RefactorOutcome } from './RefactorOutcome';
import { InlineCode } from './InlineCode';

interface ActionEntryProps {
  projectId: number;
  proposal: AiProposalDto;
  /** Live progress while the proposal is generating. */
  progress: AiProposalProgress | undefined;
}

const PHASE_COPY: Record<string, Record<string, string>> = {
  document: {
    columns: 'Reading columns from the warehouse…',
    writing: 'Writing descriptions…',
  },
  tests: {
    columns: 'Reading columns from the warehouse…',
    sampling: 'Sampling the data…',
    writing: 'Choosing tests…',
    checking: 'Running the tests against the warehouse…',
  },
};

/** Per-kind wording: [in progress, ready, failed]. */
const COPY: Record<string, [string, string, string]> = {
  document: ['Documenting', 'Docs for', 'Couldn’t document'],
  tests: ['Adding tests to', 'Tests for', 'Couldn’t add tests to'],
  refactor: ['Preparing the refactor of', 'The refactor of', 'Couldn’t refactor'],
};

const SKIPPED = 'line-through opacity-60';

function TestList({ tests, live, skipped }: {
  tests: (PartialTest | AiSuggestedTest)[];
  live?: boolean;
  /** item keys left out when the proposal was accepted */
  skipped?: Set<string>;
}) {
  if (tests.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 mt-1">
      {tests.map((t, i) => {
        const failures = 'failures' in t ? t.failures : undefined;
        const left = 'key' in t && !!t.key && !!skipped?.has(t.key);
        return (
          <li key={`${t.column}-${t.test}-${i}`} className={`text-gray-400 ${left ? SKIPPED : ''}`} title={left ? 'Not applied' : undefined}>
            <code className="text-brand-300">{t.column}</code> {describeTest(t)}
            {failures === 0 && <span className="ml-1 text-emerald-400">✓ passes</span>}
            {typeof failures === 'number' && failures > 0 && (
              <span className="ml-1 text-amber-400">✗ {failures} failing row{failures === 1 ? '' : 's'}</span>
            )}
            {t.reason && <span className="block text-gray-500">{t.reason}</span>}
          </li>
        );
      })}
      {live && <li><span className="inline-block w-1.5 h-3 align-middle bg-brand-400 animate-pulse" /></li>}
    </ul>
  );
}

function Result({ projectId, p }: { projectId: number; p: AiProposalDto }) {
  if (p.kind === 'refactor') return <RefactorOutcome projectId={projectId} proposal={p} />;
  // once applied, items the user unticked are shown struck through
  const keep = selectedKeys(p);
  const skipped = p.status === 'applied'
    ? new Set(proposalItems(p).map((i) => i.key).filter((k) => !keep.has(k)))
    : undefined;
  return p.kind === 'tests'
    ? <TestList tests={p.result.tests ?? []} skipped={skipped} />
    : <Docs docs={resultDocs(p)} skipped={skipped} />;
}

function nodeName(p: AiProposalDto) {
  return <code>{p.unique_id?.split('.').pop() ?? 'project'}</code>;
}

function Docs({ docs, skipped }: { docs: PartialDocs; skipped?: Set<string> }) {
  if (docs.description === null && docs.columns.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 mt-1">
      {docs.description && (
        <p className={`text-gray-300 ${skipped?.has('description') ? SKIPPED : ''}`}>{docs.description}</p>
      )}
      {docs.columns.length > 0 && (
        <ul className="flex flex-col gap-1">
          {docs.columns.map((c) => (
            <li key={c.name} className={`text-gray-400 ${skipped?.has(`col:${c.name}`) ? SKIPPED : ''}`}>
              <code className="text-brand-300">{c.name}</code> — {c.description}
              {!c.done && <span className="inline-block w-1.5 h-3 ml-0.5 align-middle bg-brand-400 animate-pulse" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function resultDocs(p: AiProposalDto): PartialDocs {
  return {
    description: p.result.description,
    columns: Object.entries(p.result.columns).map(([name, description]) => ({ name, description, done: true })),
  };
}

const OUTCOME: Partial<Record<AiProposalDto['status'], { icon: JSX.Element; text: string }>> = {
  applied: { icon: <CheckCircle2 size={12} className="text-emerald-400" />, text: 'Applied' },
  rejected: { icon: <Ban size={12} className="text-gray-500" />, text: 'Rejected' },
  dismissed: { icon: <Ban size={12} className="text-gray-500" />, text: 'Discarded' },
  undone: { icon: <RotateCcw size={12} className="text-gray-500" />, text: 'Undone' },
};

/** A quick action's result in the chat: live while generating, then kept as history. */
export function ActionEntry({ projectId, proposal: p, progress }: ActionEntryProps) {
  const qc = useQueryClient();
  const [reviewing, setReviewing] = useState(false);

  const dismiss = async () => {
    try {
      await aiApi.dismissProposal(projectId, p.id);
    } finally {
      qc.invalidateQueries({ queryKey: ['ai-proposals', projectId] });
      qc.invalidateQueries({ queryKey: ['ai-conversation', projectId] });
    }
  };

  const outcome = OUTCOME[p.status];
  const [doing, ready, failed] = COPY[p.kind] ?? COPY.document;
  const total = proposalItems(p).length;
  const kept = selectedKeys(p).size;
  const outcomeText = p.status === 'applied' && kept < total ? `Applied ${kept} of ${total}` : outcome?.text;
  // a refactor touches many files; RefactorOutcome shows how many instead
  const paths = p.kind === 'refactor' ? '' : p.files.map((f) => f.path).join(', ');

  return (
    <div className="flex flex-col gap-1 px-2.5 py-2 rounded-lg border border-gray-800 bg-surface-elevated/40 text-gray-300">
      {p.status === 'generating' && (
        <>
          <span className="flex items-center gap-2">
            <Loader2 size={12} className="animate-spin text-brand-300" /> {doing} {nodeName(p)}
          </span>
          <span className="text-gray-500">{PHASE_COPY[p.kind]?.[progress?.phase ?? ''] ?? 'Starting…'}</span>
          {progress?.text && (p.kind === 'tests'
            ? <TestList tests={parsePartialTests(progress.text)} live={progress.phase === 'writing'} />
            : <Docs docs={parsePartialDocs(progress.text)} />)}
        </>
      )}

      {(p.status === 'ready' || outcome) && (
        <>
          <div className="flex items-center gap-2">
            {p.status === 'ready'
              ? <><CheckCircle2 size={12} className="text-brand-300 shrink-0" /><span>{p.kind === 'refactor' ? <><InlineCode text={p.title} /> is ready to review.</> : <>{ready} {nodeName(p)} are ready to review.</>}</span></>
              : <>{outcome!.icon}<span>{outcomeText}{paths && <span className="text-gray-500"> · {paths}</span>}</span></>}
            {p.status === 'ready' && (
              <>
                <button
                  onClick={() => setReviewing(true)}
                  className="ml-auto flex items-center gap-1 px-2 py-1 rounded bg-brand-600 text-white hover:bg-brand-500"
                >
                  <Eye size={12} /> Review
                </button>
                <button onClick={dismiss} className="p-1 text-gray-500 hover:text-gray-300" title="Discard">
                  <X size={12} />
                </button>
              </>
            )}
          </div>
          <Result projectId={projectId} p={p} />
        </>
      )}

      {(p.status === 'error' || p.status === 'empty') && (
        <div className="flex items-start gap-2">
          {p.status === 'empty'
            ? <Info size={12} className="mt-0.5 text-gray-500 shrink-0" />
            : <X size={12} className="mt-0.5 text-red-400 shrink-0" />}
          <span className={`break-words ${p.status === 'error' ? 'text-red-400' : 'text-gray-400'}`}>
            {p.status === 'error' && <>{failed} {nodeName(p)}: </>}
            {p.error_message}
          </span>
        </div>
      )}

      {reviewing && p.status === 'ready' && (
        <ProposalReviewModal projectId={projectId} proposal={p} onClose={() => setReviewing(false)} />
      )}
    </div>
  );
}
