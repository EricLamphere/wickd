import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GitBranch, Loader2, MonitorPlay, Tag, Tags } from 'lucide-react';
import { propagationApi } from '../../../../lib/propagationApi';
import { aiErrorMessage } from '../../../../lib/aiApi';
import { DataTable } from '../../../../components/DataTable';
import { ProFeatureButton } from '../../../../components/ProFeatureButton';
import { UpgradeModal } from '../UpgradeModal';
import { ProposalReviewModal } from '../Wicky/ProposalReviewModal';
import { TAG_FLOW_COLUMNS, dagSelection, tagFlowCounts, tagFlowRows } from '../../lib/tagFlow';
import { LineageNotReadyNotice } from './LineageNotReadyNotice';
import { PROPAGATION_FEATURE, usePropagateProposal } from './usePropagation';
import { useTagFlow, useTagParam } from './useTagFlow';

const TABLE_COLUMNS = TAG_FLOW_COLUMNS.map((key) => ({ key }));

/**
 * Docs detail panel, Tags tab: every column (and exposure) that carries data
 * from a column tagged with the chosen tag — declared, inherited as-is, or
 * derived from it — with the lineage path, plus "write the inherited tags".
 */
export function TagFlowPanel({ projectId }: { projectId: number }) {
  const navigate = useNavigate();
  const [param] = useTagParam();
  const { flow, loading, locked, notReady, error } = useTagFlow(projectId, param);
  const proposal = usePropagateProposal(projectId);
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  const showInDag = () => {
    if (!flow) return;
    const { columnKeys, expanded } = dagSelection(flow);
    try {
      sessionStorage.setItem(`dag-column-sels-${projectId}`, JSON.stringify(columnKeys));
      sessionStorage.setItem(`dag-expanded-nodes-${projectId}`, JSON.stringify(expanded));
    } catch { /* storage unavailable: the DAG just opens without the selection */ }
    navigate(`/projects/${projectId}/models`);
  };

  const body = () => {
    if (loading) return <Loader2 className="w-4 h-4 animate-spin text-brand-400" />;
    if (locked) {
      return (
        <div className="flex flex-col items-start gap-3 max-w-lg">
          <p className="text-sm text-gray-400">
            Follow tagged columns (e.g. <span className="font-mono">pii</span>) through column lineage to every model,
            column and exposure their data reaches — including derived columns like <span className="font-mono">lower(email)</span>.
          </p>
          <ProFeatureButton onClick={() => setUpgradeOpen(true)}>Unlock tag flow</ProFeatureButton>
        </div>
      );
    }
    if (notReady) return <LineageNotReadyNotice projectId={projectId} reason={notReady} />;
    if (error || !flow) return <p className="text-sm text-red-400">{aiErrorMessage(error, 'Could not load tag flow')}</p>;
    if (flow.columns.length === 0) {
      return (
        <p className="text-sm text-gray-500">
          No column declares the <span className="font-mono">{flow.tag}</span> tag. Add <span className="font-mono">tags: [{flow.tag}]</span> to
          a column in its schema YAML to trace it.
        </p>
      );
    }
    const counts = tagFlowCounts(flow);
    const toWrite = counts.Inherited + counts.Derived;
    return (
      <div className="flex flex-col gap-4 min-h-0">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-gray-400">{counts.Declared} declared</span>
          <span className="text-gray-600">·</span>
          <span className="text-gray-400">{counts.Inherited} inherited</span>
          <span className="text-gray-600">·</span>
          <span className="text-amber-400" title="Computed from tagged data (e.g. a hash or lower()): still likely sensitive, but judge each one">
            {counts.Derived} derived
          </span>
          <span className="ml-auto" />
          <button
            onClick={showInDag}
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-surface-elevated border border-gray-700 text-gray-300 hover:bg-gray-700"
          >
            <GitBranch size={12} /> Show in DAG
          </button>
          <button
            onClick={() => proposal.start(() => propagationApi.propagateTags(projectId, flow.tag))}
            disabled={toWrite === 0 || proposal.building}
            title={toWrite === 0 ? 'Every column carrying this data already declares the tag.' : 'Adds the tag to each inherited and derived column’s YAML. You review every change before anything is written.'}
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40"
          >
            {proposal.building ? <Loader2 size={12} className="animate-spin" /> : <Tags size={12} />}
            Write inherited tags to YAML ({toWrite})
          </button>
        </div>
        {proposal.notice && <p className="text-xs text-gray-500">{proposal.notice}</p>}
        <DataTable columns={TABLE_COLUMNS} rows={tagFlowRows(flow)} />
        <div>
          <h3 className="flex items-center gap-1.5 mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">
            <MonitorPlay size={12} /> Exposures reached ({flow.exposures.length})
          </h3>
          {flow.exposures.length === 0 ? (
            <p className="text-xs text-gray-600">No exposure depends on a model carrying this data.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-xs">
              {flow.exposures.map((e) => (
                <li key={e.unique_id} className="text-gray-300">
                  <span className="font-mono">{e.name}</span>
                  <span className="text-gray-600"> via {e.via.map((uid) => uid.split('.').pop()).join(', ')}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full px-8 py-6 gap-4 overflow-auto">
      <div className="flex items-baseline gap-3">
        <Tag className="w-5 h-5 text-brand-400 shrink-0 self-center" />
        <h1 className="text-xl font-semibold text-gray-100">
          Where <span className="font-mono text-brand-300">{flow?.tag ?? param ?? 'tagged'}</span> data ends up
        </h1>
      </div>
      {body()}
      {proposal.reviewing && (
        <ProposalReviewModal projectId={projectId} proposal={proposal.reviewing} onClose={proposal.closeReview} />
      )}
      {(upgradeOpen || proposal.locked) && (
        <UpgradeModal feature={PROPAGATION_FEATURE} onClose={() => { setUpgradeOpen(false); proposal.clearLocked(); }} />
      )}
    </div>
  );
}
