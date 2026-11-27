import { describe, expect, it } from 'vitest';
import { canGoBack, canGoForward, currentNote, dropNote, goBack, goForward, pushNote, startHistory } from './noteHistory';

describe('noteHistory', () => {
  it('steps back and forward through followed links', () => {
    let h = pushNote(pushNote(startHistory('a'), 'b'), 'c');
    expect(currentNote(h)).toBe('c');
    h = goBack(h);
    expect([currentNote(h), canGoBack(h), canGoForward(h)]).toEqual(['b', true, true]);
    h = goBack(h);
    expect([currentNote(h), canGoBack(h)]).toEqual(['a', false]);
    expect(goBack(h)).toBe(h);
    expect(currentNote(goForward(goForward(h)))).toBe('c');
  });
  it('drops what was ahead when following a new link, and ignores the same note', () => {
    let h = goBack(pushNote(pushNote(startHistory('a'), 'b'), 'c'));
    h = pushNote(h, 'd');
    expect(h.stack).toEqual(['a', 'b', 'd']);
    expect(canGoForward(h)).toBe(false);
    expect(pushNote(h, 'd')).toBe(h);
  });
  it('forgets a deleted note', () => {
    const h = pushNote(pushNote(startHistory('a'), 'b'), 'a');
    expect(dropNote(h, 'b')).toEqual({ stack: ['a'], index: 0 });
    expect(dropNote(startHistory('a'), 'a')).toBeNull();
    expect(dropNote(pushNote(startHistory('a'), 'b'), 'b')).toEqual({ stack: ['a'], index: 0 });
  });
});
