// The Execution DAG's view of a dbt command without DAG nodes (compile, docs generate, debug,
// source freshness, deps, run-operation…): one node for the project, colored by how it's going.
// Commands that run nodes (run/build/test/seed) draw those nodes instead. Pure; tested in
// operationRun.test.ts.

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
