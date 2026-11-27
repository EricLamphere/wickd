// Which selected DAG nodes get a Failed Rows view: tests that errored or warned. Pure; tested in
// failedTests.test.ts.
import type { ModelNode } from '../../../../lib/api';

type TestLike = Pick<ModelNode, 'unique_id' | 'resource_type' | 'status'>;

export function isFailedTest(node: TestLike): boolean {
  return node.resource_type === 'test' && (node.status === 'error' || node.status === 'warn');
}

/**
 * The failed tests among a multi-selection (more than one node), in selection order, deduped;
 * empty for a single selection, which keeps the single-node Failed Rows tab.
 */
export function failedTestsInSelection<T extends TestLike>(selected: readonly T[]): T[] {
  if (selected.length < 2) return [];
  const byId = new Map<string, T>();
  for (const n of selected) if (isFailedTest(n) && !byId.has(n.unique_id)) byId.set(n.unique_id, n);
  return [...byId.values()];
}

/** The test whose rows to show: the picked one while it's still listed, else the first. */
export function pickFailedTest(tests: readonly TestLike[], picked: string | null): string | null {
  if (picked !== null && tests.some((t) => t.unique_id === picked)) return picked;
  return tests[0]?.unique_id ?? null;
}
