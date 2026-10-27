import { AlertTriangle, FileText } from 'lucide-react';
import type { AiProposalFileDto, ManualReviewItem } from '../../../../lib/aiApi';
import { OP_BADGES, fileForItem, fileOp, fileTitle } from './proposalFiles';

interface ProposalFileListProps {
  files: AiProposalFileDto[];
  activeId: number | undefined;
  onSelect: (id: number) => void;
  /** Edits the refactor didn't make; click one to open its file at that line. */
  manual: ManualReviewItem[];
  onReveal: (item: ManualReviewItem) => void;
}

export const FILE_STATUS_STYLES: Record<AiProposalFileDto['status'], string> = {
  pending: 'text-gray-400',
  accepted: 'text-emerald-400',
  rejected: 'text-gray-600 line-through',
  undone: 'text-gray-600 line-through',
};

export function OpBadge({ file }: { file: AiProposalFileDto }) {
  const badge = OP_BADGES[fileOp(file)];
  if (!badge) return null;
  return (
    <span className={`shrink-0 px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wide ${badge.className}`}>
      {badge.label}
    </span>
  );
}

/** The proposal's files (with New / Deleted / Renamed badges) and what needs manual review. */
export function ProposalFileList({ files, activeId, onSelect, manual, onReveal }: ProposalFileListProps) {
  return (
    <div className="flex flex-col w-64 shrink-0 border-r border-gray-800 overflow-auto">
      <div className="px-3 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-gray-500">
        Files ({files.length})
      </div>
      {files.map((f) => (
        <button
          key={f.id}
          onClick={() => onSelect(f.id)}
          title={fileTitle(f)}
          className={`flex items-center gap-1.5 w-full px-3 py-1.5 text-left text-xs font-mono ${
            f.id === activeId ? 'bg-surface-elevated' : 'hover:bg-surface-elevated/60'
          } ${FILE_STATUS_STYLES[f.status]}`}
        >
          <FileText size={12} className="shrink-0" />
          <span className="truncate flex-1">{f.op === 'rename' && f.new_path ? f.new_path : f.path}</span>
          <OpBadge file={f} />
        </button>
      ))}
      {manual.length > 0 && (
        <>
          <div className="flex items-center gap-1.5 px-3 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-amber-400">
            <AlertTriangle size={11} /> Needs manual review ({manual.length})
          </div>
          <p className="px-3 pb-1 text-[11px] text-gray-500">
            wickd didn&rsquo;t change these because it couldn&rsquo;t be sure. Check each one after applying.
          </p>
          {manual.map((item) => {
            const inProposal = fileForItem(files, item) !== undefined;
            return (
              <button
                key={`${item.path}:${item.line}:${item.reason}`}
                onClick={() => onReveal(item)}
                disabled={!inProposal}
                title={inProposal ? 'Show this line' : 'This file isn’t changed by the refactor'}
                className="flex flex-col items-start gap-0.5 w-full px-3 py-1.5 text-left text-xs enabled:hover:bg-surface-elevated/60 disabled:cursor-default"
              >
                <span className="font-mono text-gray-400 break-all">{item.path}:{item.line}</span>
                {item.text && <code className="text-gray-500 break-all">{item.text}</code>}
                <span className="text-gray-300 break-words">{item.reason}</span>
              </button>
            );
          })}
        </>
      )}
    </div>
  );
}
