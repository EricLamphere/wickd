import type { AiProposalDto, AiProposalFileDto, ManualReviewItem, ProposalFileOp } from '../../../../lib/aiApi';

/** Files from before file operations existed say `modify` with no original text: a new file. */
export function fileOp(f: AiProposalFileDto): ProposalFileOp {
  return f.op === 'modify' && f.original_text === null ? 'create' : f.op;
}

export const OP_BADGES: Record<ProposalFileOp, { label: string; className: string } | null> = {
  modify: null,
  create: { label: 'new file', className: 'bg-emerald-950/60 border-emerald-800/50 text-emerald-400' },
  delete: { label: 'deleted', className: 'bg-red-950/60 border-red-800/50 text-red-400' },
  rename: { label: 'renamed', className: 'bg-sky-950/60 border-sky-800/50 text-sky-400' },
};

/** `models/a.sql`, or `models/a.sql → models/b.sql` for a rename. */
export function fileTitle(f: AiProposalFileDto): string {
  return f.op === 'rename' && f.new_path ? `${f.path} → ${f.new_path}` : f.path;
}

/** Both sides of the diff: a new file diffs against nothing, a deleted one against nothing. */
export function diffTexts(f: AiProposalFileDto): { original: string; modified: string } {
  const op = fileOp(f);
  return {
    original: op === 'create' ? '' : f.original_text ?? '',
    modified: op === 'delete' ? '' : f.proposed_text,
  };
}

export function languageFor(path: string): string {
  if (path.endsWith('.sql')) return 'sql';
  if (path.endsWith('.yml') || path.endsWith('.yaml')) return 'yaml';
  if (path.endsWith('.py')) return 'python';
  if (path.endsWith('.md')) return 'markdown';
  return 'plaintext';
}

/** Show the file list even for one file when it isn't a plain edit (the op badge matters). */
export function showsFileList(p: AiProposalDto): boolean {
  return p.files.length > 1 || p.files.some((f) => fileOp(f) !== 'modify') || (p.result.manual?.length ?? 0) > 0;
}

/** The proposal file a manual-review item points into (matched on either side of a rename). */
export function fileForItem(files: AiProposalFileDto[], item: ManualReviewItem): AiProposalFileDto | undefined {
  return files.find((f) => f.path === item.path || f.new_path === item.path);
}

/** "4 files · 2 to check by hand" */
export function refactorCounts(p: AiProposalDto): string {
  const files = p.files.length;
  const manual = p.result.manual?.length ?? 0;
  const parts = [`${files} file${files === 1 ? '' : 's'}`];
  if (manual > 0) parts.push(`${manual} to check by hand`);
  return parts.join(' · ');
}
