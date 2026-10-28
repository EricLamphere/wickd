import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { api } from '../../../../lib/api';
import { semanticApi, type DbtChangeVerified, type SemanticStatusDto } from '../../../../lib/semanticApi';
import { GlobalSetupOutput } from '../../../../components/globalSetup/GlobalSetupOutput';
import { useGlobalSetupRun } from '../../../../components/globalSetup/useGlobalSetupRun';
import { defaultChoice, dialogTitle, otherVersionError, versionOptions } from './compatDialog';
import { ChangePreview } from './ChangePreview';
import { useSetMetricflowMode } from './useSemantic';

interface Props {
  projectId: number;
  status: SemanticStatusDto;
  /** Also install the `mf` CLI (dbt-metricflow) into the dbt venv. */
  wantCli?: boolean;
  onClose: () => void;
}

interface Install {
  version: string;
  wantCli: boolean;
  updatePins: boolean;
  replaceRanges: boolean;
  /** dbt-core before this install, for Revert */
  previous: string | null;
}

const OTHER = '__other__';

/**
 * "MetricFlow can't run with dbt-core X": pick a compatible dbt-core or continue without.
 * Nothing installs without the primary click; Escape = Continue without MetricFlow.
 */
export function MetricFlowCompatDialog({ projectId, status, wantCli = false, onClose }: Props) {
  const [install, setInstall] = useState<Install | null>(null);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" role="dialog" aria-modal="true">
      <div className="flex flex-col w-[92vw] max-w-xl bg-surface-panel rounded-xl shadow-2xl border border-gray-700 overflow-hidden" style={{ maxHeight: '82vh' }}>
        {install
          ? <InstallStep key={`${install.version}:${install.previous}`} projectId={projectId} install={install} onRevert={setInstall} onClose={onClose} />
          : <ChooseStep projectId={projectId} status={status} wantCli={wantCli} onInstall={setInstall} onClose={onClose} />}
      </div>
    </div>
  );
}

function ChooseStep({ projectId, status, wantCli, onInstall, onClose }: Omit<Props, 'onClose'> & {
  wantCli: boolean; onInstall: (i: Install) => void; onClose: () => void;
}) {
  const options = useMemo(() => versionOptions(status), [status]);
  const [choice, setChoice] = useState<string | null>(() => defaultChoice(options));
  const [other, setOther] = useState('');
  const [updatePins, setUpdatePins] = useState(true);
  const [replaceRanges, setReplaceRanges] = useState(false);
  const setMode = useSetMetricflowMode(projectId);

  const { data: allVersions } = useQuery({
    queryKey: ['dbt-core-versions'],
    queryFn: () => api.setup.dbtCoreVersions(),
    staleTime: Infinity,
    retry: 1,
    enabled: choice === OTHER,
  });
  const otherError = choice === OTHER ? otherVersionError(other, allVersions?.versions) : null;
  const version = choice === OTHER ? (otherError ? null : other.trim()) : choice;

  const plan = useQuery({
    queryKey: ['dbt-change-plan', projectId, version, wantCli],
    queryFn: () => semanticApi.planDbtChange(projectId, version!, wantCli),
    enabled: !!version,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const continueWithout = () => {
    if (status.reason_code && status.mode !== 'off') setMode.mutate('off');
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') continueWithout(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const pins = plan.data?.pins ?? [];
  const hasRangePins = pins.some((p) => !p.exact);
  const canInstall = !!version && plan.data?.ok === true;

  return (
    <>
      <div className="px-5 pt-5 pb-3 flex flex-col gap-2 shrink-0">
        <h2 className="text-sm font-semibold text-gray-100">{dialogTitle(status, wantCli)}</h2>
        {status.reason && status.reason_code !== 'off' && <p className="text-xs text-gray-300 leading-relaxed">{status.reason}</p>}
        <p className="flex items-start gap-1.5 text-[11px] text-amber-300/90 leading-relaxed">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          wickd uses one dbt environment for every project, so changing dbt-core affects all of them.
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-auto px-5 pb-4 flex flex-col gap-4">
        <fieldset className="flex flex-col gap-1">
          <legend className="text-[10px] uppercase tracking-wider text-gray-500 font-medium mb-1">dbt-core version</legend>
          {options.length === 0 && <p className="text-xs text-gray-500">No compatible release was found for this Python version.</p>}
          {options.map((o) => (
            <label key={o.version} className="flex items-center gap-2 text-xs text-gray-200 cursor-pointer">
              <input type="radio" name="dbt-core-version" checked={choice === o.version} onChange={() => setChoice(o.version)} />
              <span className="font-mono">{o.label}</span>
            </label>
          ))}
          <label className="flex items-center gap-2 text-xs text-gray-200 cursor-pointer">
            <input type="radio" name="dbt-core-version" checked={choice === OTHER} onChange={() => setChoice(OTHER)} />
            Other version…
          </label>
          {choice === OTHER && (
            <div className="pl-6 flex flex-col gap-1">
              <input
                autoFocus
                value={other}
                onChange={(e) => setOther(e.target.value)}
                placeholder="e.g. 1.10.23"
                className="w-40 px-2 py-1 rounded bg-surface-elevated border border-gray-700 text-xs font-mono text-gray-200 focus:outline-none focus:border-brand-500"
              />
              {other && otherError && <span className="text-[11px] text-red-400">{otherError}</span>}
            </div>
          )}
        </fieldset>

        {version && <ChangePreview plan={plan.data} loading={plan.isFetching} error={plan.error} />}

        {pins.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {pins.map((p) => (
              <p key={`${p.path}:${p.line}`} className="text-[11px] text-gray-300 leading-relaxed">
                {p.source === 'global' ? 'Your global requirements file' : "This project's requirements file"} pins{' '}
                <code className="font-mono text-gray-100">{p.text}</code>{' '}
                <span className="text-gray-500">({p.path}:{p.line})</span>
              </p>
            ))}
            <label className="flex items-center gap-2 text-xs text-gray-200 cursor-pointer">
              <input type="checkbox" checked={updatePins} onChange={(e) => setUpdatePins(e.target.checked)} />
              Update {pins.length === 1 ? 'it' : 'them'} to <code className="font-mono">=={version}</code> so the next setup doesn't reinstall the old version
            </label>
            {hasRangePins && updatePins && (
              <label className="flex items-center gap-2 pl-6 text-xs text-gray-400 cursor-pointer">
                <input type="checkbox" checked={replaceRanges} onChange={(e) => setReplaceRanges(e.target.checked)} />
                Also replace version ranges with an exact pin
              </label>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-800 shrink-0">
        <button onClick={continueWithout} className="px-3 py-1.5 text-xs rounded text-gray-400 hover:text-gray-100 transition-colors">
          {wantCli && !status.reason_code ? 'Cancel' : 'Continue without MetricFlow'}
        </button>
        <button
          disabled={!canInstall}
          onClick={() => version && onInstall({ version, wantCli, updatePins, replaceRanges, previous: plan.data?.previous_version ?? status.dbt_core })}
          className="px-3 py-1.5 text-xs rounded bg-brand-600 hover:bg-brand-500 text-white disabled:opacity-40 transition-colors"
        >
          {version ? `Install dbt-core ${version}` : 'Install'}
        </button>
      </div>
    </>
  );
}

function InstallStep({ projectId, install, onRevert, onClose }: {
  projectId: number; install: Install; onRevert: (i: Install) => void; onClose: () => void;
}) {
  const qc = useQueryClient();
  const run = useGlobalSetupRun(() => semanticApi.applyDbtChange(projectId, {
    version: install.version,
    want_cli: install.wantCli,
    update_pins: install.updatePins,
    replace_ranges: install.replaceRanges,
  }));
  const [verified, setVerified] = useState<DbtChangeVerified | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const finished = run.state === 'done' || run.state === 'error';

  useEffect(() => {
    if (run.state !== 'done') return;
    semanticApi.verifyDbtChange(projectId)
      .then(setVerified)
      .catch((e) => setVerifyError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        for (const key of ['semantic-status', 'health-summary', 'graph']) qc.invalidateQueries({ queryKey: [key, projectId] });
        qc.invalidateQueries({ queryKey: ['dbt-core-status'] });
      });
  }, [run.state, projectId, qc]);

  const installedOk = verified?.dbt_core === install.version;
  const allOk = installedOk && verified?.parse_ok && verified.status.available;
  const failed = run.state === 'error' || !!verifyError || (verified && !allOk);
  const revertTo = install.previous && install.previous !== install.version ? install.previous : null;

  return (
    <>
      <div className="px-5 pt-5 pb-3 shrink-0">
        <h2 className="text-sm font-semibold text-gray-100">Installing dbt-core {install.version}</h2>
        <p className="text-[11px] text-gray-500">{install.wantCli ? 'with the mf CLI (dbt-metricflow)' : 'and the adapters you have installed'}</p>
      </div>
      <GlobalSetupOutput run={run} className="max-h-72" />
      <div className="px-5 py-3 border-t border-gray-800 flex flex-col gap-2 shrink-0">
        {!finished && <span className="flex items-center gap-2 text-xs text-gray-400"><Loader2 className="w-3.5 h-3.5 animate-spin" />Installing…</span>}
        {run.state === 'done' && !verified && !verifyError && (
          <span className="flex items-center gap-2 text-xs text-gray-400"><Loader2 className="w-3.5 h-3.5 animate-spin" />Checking dbt and parsing the project…</span>
        )}
        {verified && (
          <ul className="flex flex-col gap-1 text-xs">
            <Check ok={installedOk} label={`dbt-core ${verified.dbt_core ?? 'not found'}`} />
            <Check ok={verified.parse_ok} label={verified.parse_ok ? 'dbt parse succeeded' : 'dbt parse failed'} />
            <Check ok={verified.status.available} label={verified.status.available ? 'MetricFlow is ready' : verified.status.reason ?? 'MetricFlow still unavailable'} />
          </ul>
        )}
        {verified && !verified.parse_ok && verified.parse_output && (
          <pre className="max-h-32 overflow-auto p-2 rounded bg-gray-950 text-[10px] font-mono text-gray-400 whitespace-pre-wrap">{verified.parse_output}</pre>
        )}
        {verifyError && <span className="text-xs text-red-400">{verifyError}</span>}
        <div className="flex items-center justify-end gap-2">
          {failed && revertTo && (
            <button
              onClick={() => onRevert({ version: revertTo, wantCli: false, updatePins: install.updatePins, replaceRanges: false, previous: install.version })}
              className="px-3 py-1.5 text-xs rounded border border-gray-700 text-gray-200 hover:border-brand-600 transition-colors"
            >
              Revert to {revertTo}
            </button>
          )}
          <button
            disabled={!finished}
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded bg-surface-elevated border border-gray-700 text-gray-200 hover:bg-gray-700 disabled:opacity-40 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-1.5 ${ok ? 'text-emerald-400' : 'text-red-400'}`}>
      {ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
      {label}
    </li>
  );
}
