import { describe, expect, it } from 'vitest';
import { NO_EXTRAS, type NotePrefill } from './metricNotes';
import { NOTE_TEMPLATES, applyTemplate, withoutTemplate } from './noteTemplates';

const form = (over: Partial<NotePrefill> = {}): NotePrefill => ({
  ...NO_EXTRAS, tags: [], title: '', start: '2026-11-03', end: '2026-11-03', metrics: [], dimension: null, value: null, body: '', ...over,
});
const t = (id: string) => NOTE_TEMPLATES.find((x) => x.id === id)!;
const incident = t('incident');
const release = t('release');

describe('applyTemplate', () => {
  it('fills an empty form and sets the type', () => {
    const out = applyTemplate(form(), incident);
    expect(out.title).toBe('Incident: ');
    expect(out.tags).toEqual(['incident']);
    expect([out.type, out.status]).toEqual(['incident', 'open']);
    expect(out.body).toContain('**What happened:**');
  });
  it('keeps what was written and adds tags once', () => {
    const out = applyTemplate(form({ title: 'EU outage', tags: ['Incident', 'eu'], body: 'Down.\n\n' }), incident);
    expect(out.title).toBe('EU outage');
    expect(out.tags).toEqual(['Incident', 'eu']);
    expect(out.body.startsWith('Down.\n\n**What happened:**')).toBe(true);
  });
  it('a release or backfill is not an incident', () => {
    expect([applyTemplate(form(), release).type, applyTemplate(form(), release).status]).toEqual(['release', null]);
    expect(applyTemplate(form(), t('backfill')).type).toBe('note');
  });
});

describe('switching templates', () => {
  it('replaces an untouched template instead of piling them up', () => {
    const first = applyTemplate(form(), incident);
    const second = applyTemplate(first, release, incident);
    expect(second.title).toBe('Release: ');
    expect(second.body).toBe(release.body);
    expect(second.tags).toEqual(['release']);
    expect([second.type, second.status]).toEqual(['release', null]);
    const third = applyTemplate(second, t('backfill'), release);
    expect(third.tags).toEqual(['backfill']);
    expect(third.type).toBe('note');
    expect(third.body).toBe(t('backfill').body);
  });
  it('keeps what you changed', () => {
    const first = applyTemplate(form(), incident);
    const edited = { ...first, title: 'Incident: EU checkout', body: first.body.replace('**Impact:** ', '**Impact:** all EU cards') };
    const second = applyTemplate(edited, release, incident);
    expect(second.title).toBe('Incident: EU checkout');
    expect(second.body.startsWith(edited.body.replace(/\s+$/, ''))).toBe(true);
    expect(second.body.endsWith(release.body)).toBe(true);
  });
  it('takes out an outline appended after your own text', () => {
    const first = applyTemplate(form({ body: 'Down for an hour.' }), incident);
    expect(applyTemplate(first, release, incident).body).toBe(`Down for an hour.\n\n${release.body}`);
  });
  it('leaves a type you changed by hand', () => {
    const first = { ...applyTemplate(form(), incident), status: 'resolved' as const };
    expect(withoutTemplate(first, incident).type).toBe('incident');
  });
});
