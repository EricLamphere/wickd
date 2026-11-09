import type { ReactNode } from 'react';
import { ProLabel } from '../../../../components/ProLabel';
import type { StateMethod } from '../../../../lib/slimApi';
import type { BuildSource, DeferMode } from '../../../../lib/slimBuild';

export interface BuildOptions {
  source: BuildSource;
  method: StateMethod;
  downstream: boolean;
  prune: boolean;
  defer: DeferMode;
}

const METHODS: { id: StateMethod; label: string; description: string }[] = [
  { id: 'state:modified', label: 'Anything modified', description: 'SQL, configs, contracts, docs and the macros a node calls. dbt counts any edit to a file, even whitespace.' },
  { id: 'state:new', label: 'New nodes only', description: "Models, seeds and snapshots that don't exist in production yet." },
  { id: 'state:modified.body', label: 'SQL changes only', description: "Nodes whose SQL (or seed file) changed. Config-only edits don't count." },
  { id: 'state:modified.configs', label: 'Config changes only', description: 'Nodes whose configs changed: materialization, schema, tags, incremental settings…' },
  { id: 'state:modified.contract', label: 'Contract changes only', description: "Nodes whose enforced contract changed: column names, types or constraints." },
];

function Step({ n, title, children, muted = false }: { n: number; title: string; children: ReactNode; muted?: boolean }) {
  return (
    <div className={`flex gap-3 ${muted ? 'opacity-50' : ''}`}>
      <span className="flex items-center justify-center w-5 h-5 mt-0.5 rounded-full bg-brand-900/60 text-[10px] font-semibold text-brand-300 shrink-0">{n}</span>
      <div className="flex flex-col gap-2 min-w-0 flex-1">
        <span className="text-xs font-semibold text-gray-200">{title}</span>
        {children}
      </div>
    </div>
  );
}

function Choice({ checked, onSelect, label, description, disabled = false, type = 'radio' }: {
  checked: boolean; onSelect: () => void; label: ReactNode; description: ReactNode; disabled?: boolean; type?: 'radio' | 'checkbox';
}) {
  return (
    <label className={`flex gap-2.5 px-2.5 py-2 rounded-md border transition-colors ${
      disabled ? 'border-gray-800 opacity-50 cursor-not-allowed'
        : checked ? 'border-brand-700 bg-brand-950/40 cursor-pointer' : 'border-gray-800 hover:border-gray-700 cursor-pointer'
    }`}>
      <input type={type} checked={checked} disabled={disabled} onChange={onSelect} className="mt-0.5 accent-brand-500 shrink-0" />
      <span className="flex flex-col gap-0.5 min-w-0">
        <span className="text-xs text-gray-200">{label}</span>
        <span className="text-[11px] leading-snug text-gray-500">{description}</span>
      </span>
    </label>
  );
}

interface BuildConfigProps {
  value: BuildOptions;
  onChange: (next: BuildOptions) => void;
  /** what the Impact view shows, in words ("your uncommitted changes", "the selected nodes", …) */
  shownLabel: string;
  /** nothing buildable in the Impact view right now */
  shownEmpty: boolean;
}

/** The build dialog's step-by-step configuration. */
export function BuildConfig({ value, onChange, shownLabel, shownEmpty }: BuildConfigProps) {
  const set = (patch: Partial<BuildOptions>) => onChange({ ...value, ...patch });
  const prod = value.source === 'prod';
  return (
    <div className="flex flex-col gap-5">
      <Step n={1} title="What to build">
        <Choice checked={value.source === 'shown'} onSelect={() => set({ source: 'shown' })} disabled={shownEmpty}
          label="What the Impact view shows"
          description={<>{shownLabel} and everything downstream, exactly as listed in the Impact tab. Instant, no production reference needed.</>} />
        <Choice checked={prod} onSelect={() => set({ source: 'prod' })}
          label="What changed compared with production"
          description={<>dbt compares your project with production's manifest (<code>STATE_SOURCE</code>). Also catches config, macro and package changes git can't map to a model, the way CI does.</>} />
      </Step>

      <Step n={2} title="Which changes count" muted={!prod}>
        {prod
          ? METHODS.map((m) => (
            <Choice key={m.id} checked={value.method === m.id} onSelect={() => set({ method: m.id })}
              label={<>{m.label} <code className="ml-1 text-[10px] text-gray-500">{m.id}</code></>} description={m.description} />
          ))
          : <span className="text-[11px] text-gray-500">Only when building what changed compared with production.</span>}
      </Step>

      <Step n={3} title="Downstream" muted={!prod}>
        {prod ? (
          <>
            <Choice type="checkbox" checked={value.downstream} onSelect={() => set({ downstream: !value.downstream, prune: !value.downstream && value.prune })}
              label="Include everything downstream (+)"
              description="Also rebuild every model that depends on a changed one, so their data reflects your change." />
            <Choice type="checkbox" checked={value.prune} onSelect={() => set({ prune: !value.prune })} disabled={!value.downstream}
              label={<ProLabel>Only what actually changed (smallest safe set)</ProLabel>}
              description="Skip downstream models that read none of the columns you changed, using column lineage. Models that filter or join on a changed column, or that can't be traced, are always kept." />
          </>
        ) : <span className="text-[11px] text-gray-500">The Impact view already includes everything downstream.</span>}
      </Step>

      <Step n={4} title="Parents you haven't built in dev">
        <Choice checked={value.defer === 'off'} onSelect={() => set({ defer: 'off' })}
          label="Read them from your dev schema"
          description="The default. Every parent must already exist in dev." />
        <Choice checked={value.defer === 'defer'} onSelect={() => set({ defer: 'defer' })}
          label="Defer to production (--defer)"
          description="Parents missing in dev are read from production instead, so you don't need the whole upstream DAG in dev." />
        <Choice checked={value.defer === 'favor'} onSelect={() => set({ defer: 'favor' })}
          label="Always read production (--defer --favor-state)"
          description="Read production even for parents that do exist in dev, e.g. when your dev copies are stale." />
      </Step>
    </div>
  );
}
