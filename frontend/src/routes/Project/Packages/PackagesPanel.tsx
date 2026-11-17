import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowUpCircle, Play, Plus } from 'lucide-react';
import { RichTable } from '../../../components/RichTable';
import { alertDialog, confirmDialog } from '../../../lib/dialogs';
import { aiApi, type AiProposalDto } from '../../../lib/aiApi';
import { packagesApi, packagesErrorMessage, type PackageChange, type PackageRowDto } from '../../../lib/packagesApi';
import { ProposalReviewModal } from '../components/Wicky/ProposalReviewModal';
import { AddPackageDialog } from './AddPackageDialog';
import { DepsBanner } from './DepsBanner';
import { PackageDetails, PackageRowActions, packageColumns } from './packageCells';
import { upgradeAllChanges } from './packagesView';
import { useDepsRun, usePackages } from './usePackages';

const BUTTON = 'flex items-center gap-1.5 px-2.5 py-1 text-xs rounded border border-gray-700 text-gray-300 hover:bg-gray-700 disabled:opacity-40';

/**
 * Project home → Packages: packages.yml / dependencies.yml vs package-lock.yml vs dbt_packages,
 * with the latest Hub release and dbt-core compatibility. Edits are proposals (reviewed as a
 * diff); once one is accepted, Run dbt deps installs and the lock file's changes are shown.
 */
export function PackagesPanel({ projectId }: { projectId: number }) {
  const { data, isLoading, error } = usePackages(projectId);
  const deps = useDepsRun(projectId, data?.lock);
  const [review, setReview] = useState<AiProposalDto | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  // set once a proposal is accepted: packages.yml changed, dbt deps hasn't run yet
  const [pending, setPending] = useState<{ upgrade: boolean } | null>(null);

  const rows = useMemo(() => data?.rows ?? [], [data?.rows]);
  const columns = useMemo(() => packageColumns(data?.dbt_version ?? null), [data?.dbt_version]);
  const upgrades = useMemo(() => upgradeAllChanges(rows), [rows]);
  const hubNames = useMemo(() => new Set(rows.filter((r) => r.source === 'hub').map((r) => r.key)), [rows]);
  const incompatible = rows.filter((r) => r.compatible === false).length;

  const propose = async (changes: PackageChange[]) => {
    setBusy(true);
    try {
      const proposal = await packagesApi.propose(projectId, changes);
      if (proposal.status === 'ready') setReview(proposal);
      else await alertDialog(proposal.error_message ?? 'Nothing to change', { title: 'Packages' });
    } catch (err) {
      await alertDialog(packagesErrorMessage(err), { title: "Couldn't edit the packages file" });
    } finally {
      setBusy(false);
    }
  };

  const closeReview = async () => {
    const shown = review;
    setReview(null);
    if (!shown) return;
    const latest = await aiApi.proposal(projectId, shown.id).catch(() => shown);
    if (latest.status === 'applied') {
      const summary = latest.result.summary as { versions_changed?: boolean } | undefined;
      setPending({ upgrade: !!summary?.versions_changed });
    }
  };

  const runDeps = async (upgrade: boolean) => {
    setPending(null);
    try {
      await deps.start(upgrade);
    } catch (err) {
      await alertDialog(packagesErrorMessage(err), { title: "Couldn't start dbt deps" });
    }
  };

  const remove = async (row: PackageRowDto) => {
    if (!await confirmDialog(`Remove ${row.name} from ${data?.file ?? 'packages.yml'}?`, { confirmLabel: 'Review removal', danger: true })) return;
    await propose([{ op: 'remove', key: row.key }]);
  };

  if (isLoading) return <p className="px-6 py-5 text-xs text-gray-600">Loading packages…</p>;
  if (error || !data) return <p className="px-6 py-5 text-xs text-red-400">Couldn't load packages: {packagesErrorMessage(error)}</p>;

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500">
          {data.file ? <span className="font-mono text-gray-300">{data.file}</span> : 'No packages file yet'}
          {data.dbt_version ? <> · dbt-core <span className="font-mono text-gray-300">{data.dbt_version}</span></> : ' · dbt-core not installed'}
          {data.file && !data.lock_present ? ' · no package-lock.yml' : ''}
        </span>
        <span className="flex-1" />
        <button type="button" className={BUTTON} onClick={() => setAdding(true)} disabled={busy}>
          <Plus className="w-3.5 h-3.5" />Add package
        </button>
        <button type="button" className={BUTTON} disabled={busy || upgrades.length === 0} onClick={() => propose(upgrades)}
          title={upgrades.length ? `Upgrade ${upgrades.length} package${upgrades.length === 1 ? '' : 's'} to the newest release this dbt-core supports` : 'Everything is on the newest compatible release'}>
          <ArrowUpCircle className="w-3.5 h-3.5" />Upgrade all compatible{upgrades.length ? ` (${upgrades.length})` : ''}
        </button>
        <button type="button" className={BUTTON} disabled={!data.file || deps.state.phase === 'running'} onClick={() => runDeps(false)}>
          <Play className="w-3.5 h-3.5" />Run dbt deps
        </button>
      </div>

      {pending && (
        <div className="flex items-center gap-3 px-3 py-2 text-xs bg-brand-900/30 border border-brand-800/60 rounded-lg">
          <span className="flex-1 text-brand-200">{data.file ?? 'packages.yml'} updated. Run dbt deps to install{pending.upgrade ? ' and update the lock file' : ''}.</span>
          <button type="button" onClick={() => runDeps(pending.upgrade)} className="px-2.5 py-1 rounded bg-brand-600 hover:bg-brand-500 text-white">
            Run dbt deps{pending.upgrade ? ' --upgrade' : ''}
          </button>
        </div>
      )}
      <DepsBanner state={deps.state} onDismiss={deps.dismiss} />
      {incompatible > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-red-400">
          <AlertTriangle className="w-3.5 h-3.5" />
          {incompatible === 1 ? "1 package doesn't" : `${incompatible} packages don't`} support dbt {data.dbt_version}: upgrade {incompatible === 1 ? 'it' : 'them'} or pick another dbt-core
        </p>
      )}
      {data.hub_unreachable && <p className="text-xs text-amber-400">dbt Hub couldn't be reached: latest versions are unknown.</p>}
      {data.errors.map((e) => <p key={e} className="text-xs text-red-400">{e}</p>)}

      <RichTable
        ariaLabel="Packages"
        actionsWidth="w-16"
        rows={rows}
        columns={columns}
        rowKey={(r) => r.key}
        renderExpanded={(r) => <PackageDetails row={r} />}
        rowActions={(r) => <PackageRowActions row={r} busy={busy}
          onUpgrade={(row) => propose([{ op: 'set_version', key: row.key, version: row.upgrade_to }])} onRemove={remove} />}
        empty={<p className="px-4 py-6 text-xs text-gray-600">No packages yet. Add one from dbt Hub.</p>}
      />

      {adding && (
        <AddPackageDialog
          installed={hubNames}
          onClose={() => setAdding(false)}
          onAdd={(name, version) => { setAdding(false); void propose([{ op: 'add', key: name, version }]); }}
        />
      )}
      {review && <ProposalReviewModal projectId={projectId} proposal={review} onClose={closeReview} />}
    </div>
  );
}
