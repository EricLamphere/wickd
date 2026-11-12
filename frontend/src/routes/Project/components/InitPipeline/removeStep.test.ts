import { describe, expect, it } from 'vitest';
import { bareStepName, ownsScript, removeStepMessage } from './removeStep';

describe('removeStep helpers', () => {
  it('strips the custom: prefix', () => {
    expect(bareStepName('custom: seed')).toBe('seed');
  });

  it('owns scripts in the init dir', () => {
    expect(ownsScript({ name: 'custom: seed', script_path: '/p/wickd/init/seed.sh' }, '/p/', 'wickd/init')).toBe(true);
    expect(ownsScript({ name: 'custom: seed', script_path: '/p/scripts/seed.sh' }, '/p', 'scripts/')).toBe(true);
    expect(ownsScript({ name: 'custom: seed', script_path: null }, '/p', '')).toBe(true);
  });

  it("doesn't own linked scripts", () => {
    expect(ownsScript({ name: 'custom: shared', script_path: '/elsewhere/shared.sh' }, '/p', 'wickd/init')).toBe(false);
  });

  it('words the confirm for each case', () => {
    const step = { name: 'custom: x', script_path: '/o/x.sh' };
    expect(removeStepMessage(step, true)).toContain('stays in the init folder');
    expect(removeStepMessage(step, false)).toContain("/o/x.sh) isn't deleted");
  });
});
