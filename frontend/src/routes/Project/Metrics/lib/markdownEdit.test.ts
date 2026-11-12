import { describe, expect, it } from 'vitest';
import { continueList, indentLines, insertLink, toggleLineFormat, toggleWrap } from './markdownEdit';

describe('toggleWrap', () => {
  it('wraps the selection and keeps it selected', () => {
    expect(toggleWrap('a big deal', 2, 5, '**')).toEqual({ text: 'a **big** deal', start: 4, end: 7 });
  });
  it('unwraps when the markers surround the selection', () => {
    expect(toggleWrap('a **big** deal', 4, 7, '**')).toEqual({ text: 'a big deal', start: 2, end: 5 });
  });
  it('unwraps when the markers are inside the selection', () => {
    expect(toggleWrap('a **big** deal', 2, 9, '**')).toEqual({ text: 'a big deal', start: 2, end: 5 });
  });
  it('puts the caret between new markers with no selection', () => {
    expect(toggleWrap('ab', 1, 1, '_')).toEqual({ text: 'a__b', start: 2, end: 2 });
  });
});

describe('insertLink', () => {
  it('makes the selection the label and selects the url', () => {
    const r = insertLink('see docs', 4, 8);
    expect(r.text).toBe('see [docs](url)');
    expect(r.text.slice(r.start, r.end)).toBe('url');
  });
});

describe('indentLines', () => {
  it('indents a single line, moving the caret with it', () => {
    expect(indentLines('- a\n- b', 6, 6, false)).toEqual({ text: '- a\n  - b', start: 8, end: 8 });
  });
  it('outdents every selected line', () => {
    expect(indentLines('  - a\n  - b', 0, 11, true)).toEqual({ text: '- a\n- b', start: 0, end: 7 });
  });
  it('leaves an unindented line alone on outdent', () => {
    expect(indentLines('- a', 1, 1, true).text).toBe('- a');
  });
});

describe('toggleLineFormat', () => {
  it('turns lines into a bulleted list, keeping blank lines', () => {
    expect(toggleLineFormat('a\n\nb', 0, 4, 'bullet').text).toBe('- a\n\n- b');
  });
  it('numbers lines in order', () => {
    expect(toggleLineFormat('a\nb\nc', 0, 5, 'number').text).toBe('1. a\n2. b\n3. c');
  });
  it('toggles a list off when every line has it', () => {
    expect(toggleLineFormat('- a\n- b', 0, 7, 'bullet').text).toBe('a\nb');
  });
  it('swaps one list type for another, keeping indentation', () => {
    expect(toggleLineFormat('- a\n  - b', 0, 9, 'number').text).toBe('1. a\n  2. b');
  });
  it('replaces a heading level', () => {
    expect(toggleLineFormat('## Title', 3, 3, 'h1')).toEqual({ text: '# Title', start: 2, end: 2 });
  });
  it('removes the same heading level', () => {
    expect(toggleLineFormat('## Title', 5, 5, 'h2').text).toBe('Title');
  });
  it('adds a task checkbox', () => {
    expect(toggleLineFormat('do it', 0, 0, 'task').text).toBe('- [ ] do it');
  });
});

describe('continueList', () => {
  it('starts the next bullet at the same indent', () => {
    expect(continueList('  - a', 5, 5)).toEqual({ text: '  - a\n  - ', start: 10, end: 10 });
  });
  it('counts numbers up', () => {
    expect(continueList('3. a', 4, 4)?.text).toBe('3. a\n4. ');
  });
  it('starts tasks unchecked', () => {
    expect(continueList('- [x] a', 7, 7)?.text).toBe('- [x] a\n- [ ] ');
  });
  it('ends the list on an empty item', () => {
    expect(continueList('- a\n- ', 6, 6)).toEqual({ text: '- a\n', start: 4, end: 4 });
  });
  it('splits an item at the caret', () => {
    expect(continueList('- ab', 3, 3)?.text).toBe('- a\n- b');
  });
  it('ignores lines that are not list items, and selections', () => {
    expect(continueList('plain', 5, 5)).toBeNull();
    expect(continueList('- a', 0, 3)).toBeNull();
  });
});
