// The Execution DAG's view of a dbt command without DAG nodes (compile, docs generate, debug,
// source freshness, deps, run-operation…): one node for the project, colored by how it's going.
// Commands that run nodes (run/build/test/seed) draw those nodes instead. Pure; tested in
// operationRun.test.ts.

import { stripAnsi } from '../../../lib/ansi';

export type OperationStatus = 'running' | 'success' | 'error' | 'warn';

/** Commands whose log lines name the nodes they run, drawn as a DAG. */
const NODE_COMMANDS = new Set(['run', 'build', 'test', 'seed']);

export function drawsNodes(command: string): boolean {
  return NODE_COMMANDS.has(command);
}

// "[WARNING]: …" / "[WARN]" in dbt's text logs; "WARN=2" in an end-of-run summary
const WARNING = /\[WARN(?:ING)?\]|\bWARN=([1-9]\d*)\b/;

export function isWarningLine(line: string): boolean {
  return WARNING.test(line);
}

// dbt's own notices printed as warnings on any command: deprecations ("[WARNING][…Deprecation]:",
// "Deprecated functionality", "Summary of encountered deprecations") and unused config paths.
// They don't mean the command warned.
const DBT_NOTICE = /deprecat|Configuration paths exist/i;

// dbt's end-of-run summary: "Done. PASS=2 WARN=0 ERROR=0 SKIP=0 NO-OP=0 TOTAL=2"
const SUMMARY = /\bPASS=\d+\s+WARN=(\d+)\b/;

export interface WarningFold {
  warned: boolean;
  /** dbt printed its end-of-run summary, which settles `warned` */
  summarized: boolean;
}

export const NO_WARNING: WarningFold = { warned: false, summarized: false };

/**
 * Folds one log line into whether the command warned. The end-of-run summary is final: its WARN
 * count (the nodes that warned) overrules every `[WARNING]` line. Commands without a summary
 * (compile, deps, run-operation, …) warn on a warning line, except dbt's deprecation and
 * unused-config notices, which don't mean the command warned.
 */
export function foldWarning(prev: WarningFold, raw: string): WarningFold {
  if (prev.summarized) return prev;
  const line = stripAnsi(raw);
  const summary = SUMMARY.exec(line);
  if (summary) return { warned: Number(summary[1]) > 0, summarized: true };
  if (prev.warned || !isWarningLine(line) || DBT_NOTICE.test(line)) return prev;
  return { warned: true, summarized: false };
}

/**
 * The operation an init pipeline step runs, for the dbt ones that don't announce themselves
 * (docs generate does, with docs_generating); null for pip install and scripts, which aren't dbt.
 */
const INIT_STEP_OPERATIONS: Record<string, string> = {
  'base: dbt deps': 'deps',
  'base: dbt compile': 'compile',
};

export function initStepOperation(stepName: string): string | null {
  return INIT_STEP_OPERATIONS[stepName] ?? null;
}

/** How the operation ended: failed on a non-zero exit, else warned when any line warned. */
export function finishedStatus(returnCode: number | null | undefined, warned: boolean): OperationStatus {
  if (returnCode !== 0 && returnCode !== null && returnCode !== undefined) return 'error';
  return warned ? 'warn' : 'success';
}
