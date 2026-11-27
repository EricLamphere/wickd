import { describe, expect, it } from 'vitest';
import { drawsNodes, finishedStatus, foldWarning, initStepOperation, isWarningLine, NO_WARNING } from './operationRun';

describe('operationRun', () => {
  it('draws nodes only for commands that run them', () => {
    expect(['run', 'build', 'test', 'seed'].every(drawsNodes)).toBe(true);
    expect(['compile', 'docs generate', 'debug', 'source', 'deps'].some(drawsNodes)).toBe(false);
  });

  it('spots dbt warnings', () => {
    expect(isWarningLine('12:00:01  [WARNING]: Configuration paths exist which do not apply')).toBe(true);
    expect(isWarningLine('12:00:01  [WARN] something')).toBe(true);
    expect(isWarningLine('Done. PASS=1 WARN=2 ERROR=0 SKIP=0 TOTAL=3')).toBe(true);
    expect(isWarningLine('Done. PASS=1 WARN=0 ERROR=0 SKIP=0 TOTAL=1')).toBe(false);
    expect(isWarningLine('12:00:01  Found 3 models, warn_if config ok')).toBe(false);
  });

  it('settles warnings by the end-of-run summary when dbt prints one', () => {
    const fold = (lines: string[]) => lines.reduce(foldWarning, NO_WARNING).warned;
    const stray = '12:00:01  [WARNING]: stage refresh skipped for raw.events';
    expect(fold([stray])).toBe(true);
    expect(fold([stray, 'Done. PASS=2 WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=2'])).toBe(false);
    expect(fold(['Done. PASS=1 WARN=2 ERROR=0 SKIP=0 TOTAL=3'])).toBe(true);
    expect(fold(['Done. PASS=2 WARN=0 ERROR=0 SKIP=0 TOTAL=2', stray])).toBe(false); // summary is final
    expect(fold(['12:00:01  Found 3 models'])).toBe(false);
  });

  it("doesn't warn on dbt's deprecation and unused-config notices without a summary", () => {
    // run-operation, compile, deps…: no PASS/WARN summary to overrule these
    const fold = (lines: string[]) => lines.reduce(foldWarning, NO_WARNING).warned;
    expect(fold(['12:00:01  [WARNING]: Configuration paths exist in your dbt_project.yml file which do not apply to any resources.'])).toBe(false);
    expect(fold(['12:00:01  [WARNING]: Deprecated functionality'])).toBe(false);
    expect(fold(['\x1b[0m12:00:01  [\x1b[33mWARNING\x1b[0m][PropertyMovedToConfigDeprecation]: Deprecated functionality'])).toBe(false);
    expect(fold(['12:00:01  [WARNING][MissingArgumentsPropertyInGenericTestDeprecation]: Found top-level arguments'])).toBe(false);
    expect(fold(['12:00:01  [WARNING]: Summary of encountered deprecations:'])).toBe(false);
    expect(fold(['12:00:01  [WARNING]: Deprecated functionality', '12:00:02  [WARNING]: stage refresh skipped'])).toBe(true);
  });

  it('ends red on failure, yellow on warnings, else green', () => {
    expect(finishedStatus(2, false)).toBe('error');
    expect(finishedStatus(1, true)).toBe('error');
    expect(finishedStatus(0, true)).toBe('warn');
    expect(finishedStatus(0, false)).toBe('success');
    expect(finishedStatus(null, false)).toBe('success');
  });

  it('names the dbt init steps that need a project node', () => {
    expect(initStepOperation('base: dbt deps')).toBe('deps');
    expect(initStepOperation('base: dbt compile')).toBe('compile');
    expect(initStepOperation('base: dbt docs generate')).toBeNull(); // announced with docs_generating
    expect(initStepOperation('base: pip install')).toBeNull();
    expect(initStepOperation('seed_users.sh')).toBeNull();
  });
});
