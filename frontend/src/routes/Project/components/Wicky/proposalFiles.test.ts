import { describe, expect, it } from 'vitest';
import type { AiProposalDto, AiProposalFileDto } from '../../../../lib/aiApi';
import { diffTexts, fileForItem, fileOp, fileTitle, refactorCounts, showsFileList } from './proposalFiles';

const file = (over: Partial<AiProposalFileDto> = {}): AiProposalFileDto => ({
  id: 1, path: 'models/a.sql', original_text: 'old', proposed_text: 'new',
  status: 'pending', op: 'modify', new_path: null, ...over,
});

const proposal = (files: AiProposalFileDto[], manual = 0): AiProposalDto => ({
  id: 1, kind: 'refactor', unique_id: null, title: '', status: 'ready', error_message: null, created_at: '',
  result: {
    description: null, columns: {}, tests: [], selected: null, accepted: [],
    manual: Array.from({ length: manual }, (_, i) => ({ path: 'dbt_project.yml', line: i + 1, text: '', reason: '' })),
  },
  files,
});

describe('proposal files', () => {
  it('treats a legacy modify without original text as a new file', () => {
    expect(fileOp(file({ original_text: null }))).toBe('create');
    expect(fileOp(file())).toBe('modify');
  });

  it('titles renames with both paths', () => {
    expect(fileTitle(file({ op: 'rename', new_path: 'models/b.sql' }))).toBe('models/a.sql → models/b.sql');
    expect(fileTitle(file())).toBe('models/a.sql');
  });

  it('diffs creates and deletes against nothing', () => {
    expect(diffTexts(file({ op: 'create', original_text: null }))).toEqual({ original: '', modified: 'new' });
    expect(diffTexts(file({ op: 'delete' }))).toEqual({ original: 'old', modified: '' });
  });

  it('shows the file list for one file only when it is not a plain edit', () => {
    expect(showsFileList(proposal([file()]))).toBe(false);
    expect(showsFileList(proposal([file({ op: 'rename', new_path: 'b.sql' })]))).toBe(true);
    expect(showsFileList(proposal([file()], 1))).toBe(true);
  });

  it('finds the file a manual item points into, either side of a rename', () => {
    const files = [file({ op: 'rename', new_path: 'models/b.sql' })];
    expect(fileForItem(files, { path: 'models/b.sql', line: 1, text: '', reason: '' })).toBe(files[0]);
    expect(fileForItem(files, { path: 'dbt_project.yml', line: 1, text: '', reason: '' })).toBeUndefined();
  });

  it('counts files and manual items', () => {
    expect(refactorCounts(proposal([file()], 0))).toBe('1 file');
    expect(refactorCounts(proposal([file(), file({ id: 2 })], 2))).toBe('2 files · 2 to check by hand');
  });
});
