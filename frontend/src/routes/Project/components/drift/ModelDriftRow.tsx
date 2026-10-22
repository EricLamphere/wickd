import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, FilePlus2, FileText, Hammer, Loader2, RefreshCw } from 'lucide-react';
import { api, type ColumnDrift, type DriftSnapshot, type ModelDriftResult } from '../../../../lib/api';
import { useProjectEvents } from '../../../../lib/sse';
import { describeDocumentResult, documentErrorMessage } from '../../lib/documentModel';
import { OPEN_IN_FILES_HOVER_CLS, OPEN_IN_FILES_TITLE, type useOpenInFiles } from '../../lib/openInFiles';
import { errorMessage } from '../health/useHealth';
import { columnSummary, isDrifted, isManifestOnly, isWarehouseOnly } from './driftView';

const ACTION_CLS =
  'flex items-center gap-1.5 px-2 py-1 text-[10px] rounded border border-gray-700 bg-surface-elevated text-gray-300 hover:border-brand-600 hover:text-brand-300 transition-colors disabled:opacity-40';

function columnDriftLabel(col: ColumnDrift): string {
  if (col.type_mismatch) return 'type mismatch';
  if (isManifestOnly(col)) return 'manifest only';
  if (isWarehouseOnly(col)) return 'warehouse only';
  return 'in sync';
}

function columnDriftColor(col: ColumnDrift): string {
  if (col.type_mismatch) return 'text-amber-400';
  if (isManifestOnly(col)) return 'text-red-400';
  if (isWarehouseOnly(col)) return 'text-blue-400';
  return 'text-emerald-400';
}

/** The type to show beside a column: the warehouse's when it has the column,
 *  else the type declared in YAML (if any). Informational only — not compared. */
function columnType(col: ColumnDrift): { type: string; title: string } {
  if (col.in_warehouse) return { type: col.warehouse_type, title: 'Type in the warehouse' };
  return { type: col.manifest_type, title: 'Type declared in schema YAML' };
}

interface ModelDriftRowProps {
  projectId: number;
  snapshotId: number;
  result: ModelDriftResult;
  defaultOpen: boolean;
  /** A scan is running: re-checking would 409 */
  scanRunning: boolean;
  fileNav: ReturnType<typeof useOpenInFiles>;
}

export default function ModelDriftRow({ projectId, snapshotId, result, defaultOpen, scanRunning, fileNav }: ModelDriftRowProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(defaultOpen);
  // Columns documented from this row; the snapshot only catches up on the next check
  const [documented, setDocumented] = useState<ReadonlySet<string>>(new Set());
  // Set after starting a build: re-check this model once the run finishes
  const [awaitingBuild, setAwaitingBuild] = useState(false);
  const canOpen = fileNav.canOpen(result.unique_id);

  const recheck = useMutation({
    mutationFn: () => api.drift.recheck(projectId, snapshotId, result.unique_id),
    onSuccess: (snap) => {
      qc.setQueryData<DriftSnapshot | null>(['drift-latest', projectId], snap);
      setDocumented(new Set());
    },
  });

  const build = useMutation({
    mutationFn: () => api.runs.build(projectId, result.unique_id, 'only'),
    onSuccess: () => setAwaitingBuild(true),
  });

  useProjectEvents(projectId, useCallback((event) => {
    if (event.type === 'run_finished' && awaitingBuild) {
      setAwaitingBuild(false);
      recheck.mutate();
    }
  }, [awaitingBuild, recheck]));

  const driftCols = result.columns.filter(isDrifted);
  const undocumentedCols = driftCols
    .filter((c) => isWarehouseOnly(c) && !documented.has(c.name))
    .map((c) => c.name);
  const hasWarehouseOnly = driftCols.some(isWarehouseOnly);
  const hasManifestOnly = driftCols.some(isManifestOnly);

  const busy = recheck.isPending || build.isPending || awaitingBuild;
  const summary = result.not_built
    ? 'not built'
    : result.error ? 'error' : columnSummary(result) || 'in sync';
  const summaryColor = result.not_built ? 'text-gray-400' : result.error ? 'text-red-400' : result.has_drift ? 'text-amber-400' : 'text-emerald-400';

  return (
    <div className="border border-gray-800/60 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 pr-2 bg-surface-elevated/30 hover:bg-surface-elevated/60 transition-colors">
        <button
          type="button"
          onClick={(e) => {
            if (fileNav.handleClick(e, result.unique_id)) return;
            setOpen((o) => !o);
          }}
          className="flex-1 min-w-0 flex items-center gap-2 pl-3 py-2 text-left"
        >
          {open ? <ChevronDown className="w-3.5 h-3.5 text-gray-600 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-600 shrink-0" />}
          <span className="flex-1 min-w-0 truncate">
            <span title={canOpen ? OPEN_IN_FILES_TITLE : undefined} className={`text-xs font-mono text-gray-300 ${canOpen ? OPEN_IN_FILES_HOVER_CLS : ''}`}>
              {result.name}
            </span>
          </span>
          <span className={`text-[10px] shrink-0 ${summaryColor}`}>{summary}</span>
        </button>
        <button
          type="button"
          onClick={() => recheck.mutate()}
          disabled={busy || scanRunning}
          title="Re-check this model"
          className="p-1 rounded text-gray-500 hover:text-brand-300 hover:bg-surface-elevated disabled:opacity-40 transition-colors"
        >
          <RefreshCw className={`w-3 h-3 ${recheck.isPending ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {open && (
        <div className="px-3 pb-2 pt-1 flex flex-col gap-0.5">
          {result.not_built ? (
            <p className="text-[10px] text-gray-500">This model has no table in the warehouse yet — build it to check its columns.</p>
          ) : result.error ? (
            <p className="text-[10px] text-red-400 font-mono break-all">{result.error}</p>
          ) : (
            driftCols.map((col) => <ColumnRow key={col.name} col={col} documented={documented.has(col.name)} />)
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1.5">
            {(result.not_built || hasManifestOnly) && (
              <button
                type="button"
                onClick={() => build.mutate()}
                disabled={busy}
                title={result.not_built ? 'dbt build this model, then re-check it' : 'Rebuild the table from its SQL (dbt build), then re-check it — fixes columns the table is missing'}
                className={ACTION_CLS}
              >
                {build.isPending || awaitingBuild ? <Loader2 className="w-3 h-3 animate-spin" /> : <Hammer className="w-3 h-3" />}
                {awaitingBuild ? 'Building…' : 'Build model'}
              </button>
            )}
            {hasManifestOnly && result.yaml_path && (
              <button
                type="button"
                onClick={() => navigate(`/projects/${projectId}/files?path=${encodeURIComponent(result.yaml_path!)}`)}
                title={`Open ${result.yaml_path} — remove columns that no longer exist`}
                className={ACTION_CLS}
              >
                <FileText className="w-3 h-3" />
                Open YAML
              </button>
            )}
            {hasWarehouseOnly && (
              <DocumentColumnsButton
                projectId={projectId}
                uniqueId={result.unique_id}
                columns={undocumentedCols}
                onDocumented={(cols) => setDocumented((prev) => new Set([...prev, ...cols]))}
              />
            )}
            {(recheck.error || build.error) && (
              <span className="text-[10px] text-red-400 break-all">{errorMessage(recheck.error ?? build.error)}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ColumnRow({ col, documented }: { col: ColumnDrift; documented: boolean }) {
  const { type, title } = columnType(col);
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="text-[10px] font-mono text-gray-400 flex-1 truncate">{col.name}</span>
      {type && (
        <span title={title} className="max-w-[40%] shrink-0 truncate text-[10px] font-mono text-gray-600">{type}</span>
      )}
      {documented ? (
        <span className="text-[10px] shrink-0 text-emerald-400">documented</span>
      ) : (
        <span className={`text-[10px] shrink-0 ${columnDriftColor(col)}`}>{columnDriftLabel(col)}</span>
      )}
    </div>
  );
}

interface DocumentColumnsButtonProps {
  projectId: number;
  uniqueId: string;
  columns: string[];
  onDocumented: (columns: string[]) => void;
}

/** Adds the model's warehouse-only columns to its schema YAML. */
function DocumentColumnsButton({ projectId, uniqueId, columns, onDocumented }: DocumentColumnsButtonProps) {
  const mutation = useMutation({
    mutationFn: () => api.models.document(projectId, uniqueId, columns),
    onSuccess: () => onDocumented(columns),
  });

  return (
    <>
      {columns.length > 0 && (
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
          title="Add these columns to the model's schema YAML"
          className={ACTION_CLS}
        >
          {mutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <FilePlus2 className="w-3 h-3" />}
          Document {columns.length} warehouse-only column{columns.length !== 1 ? 's' : ''}
        </button>
      )}
      {mutation.isSuccess && (
        <span className="text-[10px] text-emerald-400 truncate">{describeDocumentResult(mutation.data)}</span>
      )}
      {mutation.isError && (
        <span className="text-[10px] text-red-400 break-all">{documentErrorMessage(mutation.error)}</span>
      )}
    </>
  );
}
