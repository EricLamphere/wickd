import { describe, expect, it } from 'vitest';
import { nudgeAfterEvent } from './buildNudge';

const started = { type: 'run_started', data: { command: 'build' } };
const finished = (rc: number, command = 'build') => ({ type: 'run_finished', data: { command, return_code: rc } });

describe('nudgeAfterEvent', () => {
  it('follows a build from queued to built', () => {
    expect(nudgeAfterEvent('queued', started)).toBe('building');
    expect(nudgeAfterEvent('building', finished(0))).toBe('built');
  });
  it('drops the nudge when the build fails or dbt is missing', () => {
    expect(nudgeAfterEvent('building', finished(1))).toBeNull();
    expect(nudgeAfterEvent('queued', { type: 'run_error', data: {} })).toBeNull();
  });
  it('ignores a run that finished before ours started, and other commands', () => {
    expect(nudgeAfterEvent('queued', finished(0))).toBe('queued');
    expect(nudgeAfterEvent('queued', { type: 'run_started', data: { command: 'run' } })).toBe('queued');
    expect(nudgeAfterEvent('building', finished(0, 'test'))).toBe('building');
  });
  it('leaves a settled nudge alone', () => {
    expect(nudgeAfterEvent('built', started)).toBe('built');
    expect(nudgeAfterEvent(null, started)).toBeNull();
  });
});
