import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { api, type SettingsDto } from '../lib/api';
import { PythonInterpreterRow } from './PythonInterpreterRow';
import { OPEN_SETUP_EVENT } from './setup/SetupGate';
import { alertError } from '../lib/dialogs';

type SettingKey = keyof SettingsDto & string;

interface SettingRow {
  key: SettingKey;
  label: string;
  hint?: string;
  example?: string;
  /** Shown instead of the value, not editable */
  locked?: string;
}

interface SettingSection {
  id: string;
  title: string;
  description: string;
  rows: SettingRow[];
  /** Extra rows rendered after the plain ones (e.g. the Python interpreter picker) */
  extra?: (settings: SettingsDto) => ReactNode;
}

function buildSections(settings: SettingsDto | undefined): SettingSection[] {
  // A global requirements file decides dbt-core, so the version setting doesn't apply
  const versionLocked = settings?.global_requirements_path ? 'Set by your requirements file' : undefined;
  return [
    {
      id: 'dbt',
      title: 'dbt',
      description: 'Where your projects live and how dbt is installed.',
      rows: [
        { key: 'dbt_projects_path', label: 'WICKD_DBT_PROJECTS_PATH', hint: 'several folders: separate with commas (new projects will be created in the first)', example: '/home/user/dbt-projects, /home/user/work/dbt' },
        { key: 'global_requirements_path', label: 'WICKD_GLOBAL_REQUIREMENTS_PATH', hint: 'requirements.txt installed via Run global setup', example: '/home/user/dbt-projects/requirements.txt' },
        { key: 'dbt_core_version', label: 'WICKD_DBT_CORE_VERSION', hint: 'dbt-core Run global setup installs when no requirements file is set (blank = latest)', example: '1.10.13', locked: versionLocked },
        { key: 'metricflow_mode', label: 'WICKD_METRICFLOW_MODE', hint: 'semantic layer: auto or off; projects can override', example: 'auto' },
      ],
      extra: (s) => <PythonInterpreterRow appSettings={s} />,
    },
    {
      id: 'ai',
      title: 'AI',
      description: 'The model Wicky uses (Pro).',
      rows: [
        { key: 'ai_model', label: 'WICKD_AI_MODEL', hint: 'bundled local model (Pro)', example: 'qwen3.5-4b' },
        { key: 'ai_endpoint_url', label: 'WICKD_AI_ENDPOINT_URL', hint: 'OpenAI-compatible server used instead', example: 'http://localhost:11434' },
        { key: 'ai_endpoint_model', label: 'WICKD_AI_ENDPOINT_MODEL', hint: 'model name on that server', example: 'qwen3:8b' },
      ],
    },
    {
      id: 'general',
      title: 'General',
      description: 'App behavior.',
      rows: [
        { key: 'log_level', label: 'WICKD_LOG_LEVEL', hint: 'takes effect on restart', example: 'INFO' },
      ],
    },
  ];
}

/** Query keys whose data depends on a given setting. */
function keysToInvalidate(key: SettingKey): string[][] {
  if (key.startsWith('ai_')) return [['ai-status']];
  if (key === 'metricflow_mode') return [['semantic-status'], ['health-summary']];
  // Both decide which dbt-core is expected, so the installed-version check changes
  if (key === 'global_requirements_path' || key === 'dbt_core_version') return [['dbt-core-status']];
  return [];
}

export function GlobalSettingsTab() {
  const qc = useQueryClient();
  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: () => api.settings.get(),
  });

  const [editingKey, setEditingKey] = useState<SettingKey | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async (key: SettingKey) => {
    setSaving(true);
    try {
      await api.settings.update({ [key]: editValue });
      setEditingKey(null);
      qc.invalidateQueries({ queryKey: ['app-settings'] });
      for (const queryKey of keysToInvalidate(key)) qc.invalidateQueries({ queryKey });
    } catch (e) {
      alertError(e);
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (key: SettingKey, value: string) => { setEditingKey(key); setEditValue(value); };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <p className="text-xs text-gray-500">Configuration shared across all projects.</p>
        <button
          onClick={() => window.dispatchEvent(new CustomEvent(OPEN_SETUP_EVENT))}
          className="px-3 py-1.5 text-xs rounded bg-surface-elevated hover:bg-gray-700 text-gray-300 shrink-0 transition-colors"
        >
          Run setup again
        </button>
      </div>
      {!appSettings && <p className="text-xs text-gray-600">Loading…</p>}
      {appSettings && buildSections(appSettings).map((section) => (
        <section key={section.id} className="flex flex-col gap-1.5">
          <div className="mb-1.5">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-0.5">{section.title}</h3>
            <p className="text-xs text-gray-500">{section.description}</p>
          </div>
          {section.rows.map((row) => (
            <SettingRowView
              key={row.key}
              row={row}
              value={appSettings[row.key] as string | null | undefined}
              editing={editingKey === row.key}
              editValue={editValue}
              saving={saving}
              onEditValue={setEditValue}
              onStartEdit={startEdit}
              onSave={handleSave}
              onCancel={() => setEditingKey(null)}
            />
          ))}
          {section.extra?.(appSettings)}
        </section>
      ))}
    </div>
  );
}

interface SettingRowViewProps {
  row: SettingRow;
  value: string | null | undefined;
  editing: boolean;
  editValue: string;
  saving: boolean;
  onEditValue: (v: string) => void;
  onStartEdit: (key: SettingKey, value: string) => void;
  onSave: (key: SettingKey) => void;
  onCancel: () => void;
}

function SettingRowView({ row, value, editing, editValue, saving, onEditValue, onStartEdit, onSave, onCancel }: SettingRowViewProps) {
  const { key, label, hint, example, locked } = row;
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-surface-elevated rounded border border-gray-800 text-xs">
      <div className="w-60 shrink-0">
        <span className="font-mono text-brand-300 truncate block">{label}</span>
        {hint && <span className="text-gray-600 italic">{hint}</span>}
      </div>
      <span className="text-gray-600">=</span>
      {locked ? (
        <span className="flex-1 text-gray-500 italic truncate">{locked}</span>
      ) : editing ? (
        <>
          <input
            autoFocus
            value={editValue}
            onChange={(e) => onEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSave(key);
              if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
            }}
            placeholder={example ? `e.g. ${example}` : undefined}
            className="flex-1 bg-surface-panel border border-brand-500 rounded px-2 py-0.5 text-gray-100 font-mono focus:outline-none placeholder-gray-600"
          />
          <button onClick={() => onSave(key)} disabled={saving} className="text-brand-400 hover:text-brand-300 p-1 disabled:opacity-40">
            <Check className="w-3.5 h-3.5" />
          </button>
          <button onClick={onCancel} className="text-gray-600 hover:text-gray-400 p-1">✕</button>
        </>
      ) : (
        <span
          className="flex-1 font-mono text-gray-300 truncate cursor-pointer hover:text-gray-100"
          onClick={() => onStartEdit(key, value ?? '')}
        >
          {value ?? <span className="text-gray-600 italic">{example ? `e.g. ${example}` : 'not set'}</span>}
        </span>
      )}
    </div>
  );
}
