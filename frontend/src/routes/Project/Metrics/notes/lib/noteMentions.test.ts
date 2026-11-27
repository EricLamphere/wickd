import { describe, expect, it } from 'vitest';
import {
  applyCompletion, backlinks, linkifyMentions, notesMentioning, parseMentionHref, rankByQuery, tokenAt,
} from './noteMentions';

describe('tokenAt', () => {
  it('finds note:, model: and commit: words', () => {
    expect(tokenAt('see note:eu-ro', 14)).toEqual({ kind: 'note', query: 'eu-ro', from: 4, to: 14 });
    expect(tokenAt('caused by model:fct', 19)).toEqual({ kind: 'model', query: 'fct', from: 10, to: 19 });
    expect(tokenAt('(commit:3f', 10)).toEqual({ kind: 'commit', query: '3f', from: 1, to: 10 });
    expect(tokenAt('model:', 6)?.query).toBe('');
  });
  it('needs the mention to start a word', () => {
    expect(tokenAt('email@model:x', 13)).toBeNull();
    expect(tokenAt('plain words', 11)).toBeNull();
    expect(tokenAt('[[old', 5)).toBeNull();
  });
});

describe('applyCompletion', () => {
  it('writes the mention and moves the caret after it', () => {
    const text = 'see note:eu after';
    expect(applyCompletion(text, tokenAt(text, 11)!, 'eu-rollback')).toEqual({ text: 'see note:eu-rollback after', caret: 20 });
  });
  it('completes models and commits', () => {
    expect(applyCompletion('by model:fc', tokenAt('by model:fc', 11)!, 'fct_orders').text).toBe('by model:fct_orders');
    expect(applyCompletion('commit:3', tokenAt('commit:3', 8)!, '3f2a9c1').text).toBe('commit:3f2a9c1');
  });
});

describe('rankByQuery', () => {
  it('puts prefix matches first', () => {
    const items = ['orders_daily', 'fct_orders', 'stg_orders', 'customers'];
    expect(rankByQuery(items, 'ord', (s) => [s])).toEqual(['orders_daily', 'fct_orders', 'stg_orders']);
    expect(rankByQuery(items, '', (s) => [s], 2)).toEqual(['orders_daily', 'fct_orders']);
  });
});

describe('linkifyMentions', () => {
  it('links show only the name, leaving code alone', () => {
    const body = 'By model:fct_orders. See note:eu-rollback, [[other|the other one]], [[old]] and commit:3F2A9C1aa.\n`model:code`\n```\nmodel:fenced\n```\n';
    const out = linkifyMentions(body, (slug) => (slug === 'eu-rollback' ? 'EU [rollback]' : null));
    expect(out).toContain('By [fct_orders](wickd-model:fct_orders).');
    expect(out).toContain('See [EU rollback](wickd-note:eu-rollback),');
    expect(out).toContain('[the other one](wickd-note:other)');
    expect(out).toContain('[old](wickd-note:old)');
    expect(out).toContain('[3f2a9c1](wickd-commit:3f2a9c1aa)');
    expect(out).toContain('`model:code`');
    expect(out).toContain('model:fenced\n');
  });
  it('parses the links back', () => {
    expect(parseMentionHref('wickd-model:fct_orders')).toEqual({ kind: 'model', value: 'fct_orders' });
    expect(parseMentionHref('https://x.y')).toBeNull();
  });
});

describe('backlinks and model notes', () => {
  const notes = [
    { slug: 'a', links: ['b'], models: ['jaffle.fct_orders'] },
    { slug: 'b', links: ['b'], models: [] },
    { slug: 'c', links: [], models: ['FCT_ORDERS'] },
  ];
  it('lists notes linking to one (not itself)', () => expect(backlinks(notes, 'b').map((n) => n.slug)).toEqual(['a']));
  it('lists notes mentioning a model', () => expect(notesMentioning(notes, 'fct_orders').map((n) => n.slug)).toEqual(['a', 'c']));
});
