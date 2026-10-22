import { FileCode2, Globe, Image, Lock, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { FORMAT_LABEL, type ExportFormat, type ExportTheme, type HtmlIncludes } from '../../lib/dagExport/config';

const FORMAT_INFO: Record<ExportFormat, { icon: ReactNode; blurb: string }> = {
  html: { icon: <Globe size={16} />, blurb: 'Pan, zoom, search and trace lineage in any browser' },
  svg: { icon: <FileCode2 size={16} />, blurb: 'Vector image, sharp at any size' },
  png: { icon: <Image size={16} />, blurb: 'Image for docs, slides and chat' },
};

export function FormatPicker({ value, onChange }: { value: ExportFormat; onChange: (f: ExportFormat) => void }) {
  return (
    <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Format">
      {(Object.keys(FORMAT_INFO) as ExportFormat[]).map((f) => (
        <button
          key={f}
          type="button"
          role="radio"
          aria-checked={value === f}
          onClick={() => onChange(f)}
          className={`flex flex-col items-start gap-1 p-3 rounded border text-left transition-colors ${
            value === f
              ? 'border-brand-500 bg-brand-950/40 text-brand-200'
              : 'border-gray-700 bg-surface-elevated text-gray-300 hover:border-gray-600'
          }`}
        >
          <span className="flex items-center gap-1.5 text-xs font-medium">
            {FORMAT_INFO[f].icon}
            {FORMAT_LABEL[f]}
          </span>
          <span className="text-[11px] text-gray-500 leading-snug">{FORMAT_INFO[f].blurb}</span>
        </button>
      ))}
    </div>
  );
}

interface IncludesPickerProps {
  value: HtmlIncludes;
  onChange: (v: HtmlIncludes) => void;
  lineageReady: boolean;
  lineageLoading: boolean;
  onLoadLineage: () => void;
  shownCount: number;
  totalCount: number;
  columnLineageLocked: boolean;
  onUpgradeColumnLineage: () => void;
}

function ProTag() {
  return (
    <span className="inline-flex items-center gap-0.5 ml-1.5 px-1.5 rounded bg-brand-950/40 border border-brand-900/60 text-[10px] text-brand-300 font-medium">
      <Sparkles size={9} />
      Pro
    </span>
  );
}

function Checkbox({ checked, disabled, onChange, label, hint }: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint: ReactNode;
}) {
  return (
    <label className={`flex items-start gap-2 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-brand-500"
      />
      <span className="flex flex-col">
        <span className="text-xs text-gray-200">{label}</span>
        <span className="text-[11px] text-gray-500">{hint}</span>
      </span>
    </label>
  );
}

export function IncludesPicker(props: IncludesPickerProps) {
  const { value, onChange, lineageReady, lineageLoading, onLoadLineage, shownCount, totalCount } = props;
  const { columnLineageLocked, onUpgradeColumnLineage } = props;
  const columnHint = columnLineageLocked
    ? (
      <>
        Column-level lineage is a wickd Pro feature.{' '}
        <button type="button" onClick={onUpgradeColumnLineage} className="inline-flex items-center gap-1 text-brand-400 hover:text-brand-300">
          <Lock size={10} /> Unlock
        </button>
      </>
    )
    : lineageReady
    ? 'Click a column to trace where it comes from and where it goes'
    : (
      <>
        Column lineage isn't loaded yet.{' '}
        <button
          type="button"
          onClick={onLoadLineage}
          disabled={lineageLoading}
          className="text-brand-400 hover:text-brand-300 disabled:opacity-60"
        >
          {lineageLoading ? 'Loading…' : 'Load it now'}
        </button>
      </>
    );
  return (
    <div className="flex flex-col gap-2">
      <Checkbox
        checked={value.wholeProject}
        onChange={(v) => onChange({ ...value, wholeProject: v })}
        label="Whole project"
        hint={value.wholeProject
          ? `All ${totalCount} nodes, opening with your filters. Viewers can change the filters, like in the app.`
          : `Only the ${shownCount} nodes shown. Viewers can narrow the filters within those.`}
      />
      <Checkbox
        checked={value.modelLineage}
        onChange={(v) => onChange({ ...value, modelLineage: v })}
        label="Model lineage"
        hint="Click a node to highlight everything upstream and downstream of it"
      />
      <Checkbox
        checked={value.columnLineage && lineageReady && !columnLineageLocked}
        disabled={!lineageReady || columnLineageLocked}
        onChange={(v) => onChange({ ...value, columnLineage: v })}
        label={<>Column lineage<ProTag /></>}
        hint={columnHint}
      />
    </div>
  );
}

export function ThemePicker({ value, onChange }: { value: ExportTheme; onChange: (t: ExportTheme) => void }) {
  return (
    <div className="inline-flex rounded border border-gray-700 overflow-hidden" role="radiogroup" aria-label="Theme">
      {(['dark', 'light'] as ExportTheme[]).map((t) => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={value === t}
          onClick={() => onChange(t)}
          className={`px-3 py-1 text-xs capitalize transition-colors ${
            value === t ? 'bg-brand-600 text-white' : 'bg-surface-elevated text-gray-400 hover:text-gray-200'
          }`}
        >
          {t}
        </button>
      ))}
    </div>
  );
}
