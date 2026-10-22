import type { ColumnDrift, ModelDriftResult } from '../../../../lib/api';

export interface DriftGroups {
  drifted: ModelDriftResult[];
  notBuilt: ModelDriftResult[];
  errors: ModelDriftResult[];
  inSync: ModelDriftResult[];
}

export function categorize(results: readonly ModelDriftResult[]): DriftGroups {
  return {
    drifted: results.filter((r) => r.has_drift),
    notBuilt: results.filter((r) => r.not_built),
    errors: results.filter((r) => r.error != null && !r.not_built),
    inSync: results.filter((r) => !r.has_drift && r.error == null),
  };
}

export const isWarehouseOnly = (c: ColumnDrift) => !c.in_manifest && c.in_warehouse;
export const isManifestOnly = (c: ColumnDrift) => c.in_manifest && !c.in_warehouse;
export const isDrifted = (c: ColumnDrift) => !c.in_manifest || !c.in_warehouse || c.type_mismatch;

/** One-line description of a model's drift, shown when its row is collapsed. */
export function columnSummary(result: ModelDriftResult): string {
  const warehouseOnly = result.columns.filter(isWarehouseOnly).length;
  const manifestOnly = result.columns.filter(isManifestOnly).length;
  const mismatched = result.columns.filter((c) => c.type_mismatch).length;
  return [
    warehouseOnly ? `${warehouseOnly} warehouse-only` : '',
    manifestOnly ? `${manifestOnly} manifest-only` : '',
    mismatched ? `${mismatched} type mismatch${mismatched !== 1 ? 'es' : ''}` : '',
  ].filter(Boolean).join(' · ');
}

export function matchesSearch(result: ModelDriftResult, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || result.name.toLowerCase().includes(q);
}

/** "9 skipped (7 view, 2 ephemeral)", or null when nothing was skipped. */
export function skippedLabel(skipped: Record<string, number>): string | null {
  const entries = Object.entries(skipped).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((n, [, c]) => n + c, 0);
  if (total === 0) return null;
  return `${total} skipped (${entries.map(([kind, c]) => `${c} ${kind}`).join(', ')})`;
}
