import { describe, expect, it, vi } from 'vitest';
import { createRestoreQueue, pickTab, urlTabKey } from './stickyTab';

describe('pickTab', () => {
  const tabs = ['explore', 'monitors'] as const;
  it('prefers the URL, then the remembered tab, then the fallback', () => {
    expect(pickTab(tabs, 'explore', 'monitors', 'explore')).toBe('monitors');
    expect(pickTab(tabs, 'explore', null, 'monitors')).toBe('monitors');
    expect(pickTab(tabs, 'explore', null, null)).toBe('explore');
  });
  it('skips values the page no longer offers', () => {
    expect(pickTab(tabs, 'explore', 'gone', 'monitors')).toBe('monitors');
    expect(pickTab(tabs, 'explore', null, 'gone')).toBe('explore');
  });
});

describe('urlTabKey', () => {
  it('is per page path (incl. project) and param', () => {
    expect(urlTabKey('/projects/2/metrics/', 'tab')).toBe('url-tab:/projects/2/metrics:tab');
    expect(urlTabKey('/projects/3/metrics', 'tab')).not.toBe(urlTabKey('/projects/2/metrics', 'tab'));
  });
});

describe('createRestoreQueue', () => {
  it('merges restores from the same tick into one write', async () => {
    const flush = vi.fn();
    const restore = createRestoreQueue(flush);
    restore('tab', 'test-gaps');
    restore('gaps', 'ignored');
    restore('tab', 'overview');
    expect(flush).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith([['tab', 'overview'], ['gaps', 'ignored']]);
    restore('file', 'readme');
    await Promise.resolve();
    expect(flush).toHaveBeenLastCalledWith([['file', 'readme']]);
  });
});
