import { describe, expect, it } from 'vitest';
import {
  bodyFromDraft, commandTarget, draftFromInvocation, draftProblem, emptyDraft, outcomeView, suggestName,
} from './scheduleDraft';

describe('suggestName', () => {
  it('uses the subcommand and selector', () => {
    expect(suggestName('build -s tag:nightly --full-refresh')).toBe('build tag:nightly');
    expect(suggestName('dbt run --select=orders+')).toBe('run orders+');
    expect(suggestName('source freshness')).toBe('source freshness');
    expect(suggestName('build')).toBe('build');
    expect(suggestName('')).toBe('');
  });
});

describe('drafts', () => {
  it('starts from a command, stripping dbt', () => {
    const d = emptyDraft('dbt build -s tag:nightly');
    expect(d.command).toBe('build -s tag:nightly');
    expect(d.name).toBe('build tag:nightly');
    expect(d.busy_wait_minutes).toBe(30);
    expect(d.catch_up).toBe(false);
  });

  it('validates', () => {
    expect(draftProblem(emptyDraft('build'))).toBeNull();
    expect(draftProblem({ ...emptyDraft('build'), name: ' ' })).toMatch(/name/);
    expect(draftProblem(emptyDraft(''))).toMatch(/name|command/);
    expect(draftProblem({ ...emptyDraft('build'), busy_wait_minutes: 721 })).toMatch(/0–720/);
    expect(draftProblem({ ...emptyDraft('build'), busy_wait_minutes: 1.5 })).toMatch(/0–720/);
  });

  it('builds the API body: cron wins, empty target is null', () => {
    const body = bodyFromDraft({ ...emptyDraft('dbt build'), interval_hours: 6, cron: '0 9 * * *', target: ' ' });
    expect(body).toMatchObject({ command: 'build', interval_hours: null, cron: '0 9 * * *', target: null });
    expect(bodyFromDraft({ ...emptyDraft('build'), interval_hours: 6, cron: null })).toMatchObject({ interval_hours: 6, cron: null });
  });
});

describe('commandTarget', () => {
  it('finds --target and -t', () => {
    expect(commandTarget('build --target prod')).toBe('prod');
    expect(commandTarget('build --target=prod -s x')).toBe('prod');
    expect(commandTarget('build -t prod')).toBe('prod');
    expect(commandTarget('build -s tag:t')).toBeNull();
  });
});

describe('draftFromInvocation', () => {
  it('moves the injected target to the picker', () => {
    const d = draftFromInvocation({ cli_command: 'dbt build --select orders+ --target dev', command: 'build', selector: 'orders+', target: 'dev' });
    expect(d.command).toBe('build --select orders+');
    expect(d.target).toBe('dev');
  });

  it('falls back to command + selector', () => {
    const d = draftFromInvocation({ cli_command: null, command: 'run', selector: 'a', target: null });
    expect(d.command).toBe('run --select a');
    expect(d.target).toBe('');
  });
});

describe('outcomeView', () => {
  it('labels outcomes', () => {
    expect(outcomeView(null)).toEqual({ label: 'never run', tone: 'muted' });
    expect(outcomeView('error').tone).toBe('fail');
    expect(outcomeView('skipped_busy').label).toBe('skipped (busy)');
    expect(outcomeView('missed').tone).toBe('muted');
  });
});
