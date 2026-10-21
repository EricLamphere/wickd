import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Trash2 } from 'lucide-react';
import { api } from '../lib/api';

export const GLOBAL_ENV_QUERY_KEY = ['global-env'] as const;

/** Explains which env var source wins when a key is set in more than one place. */
export function EnvPrecedenceNote({ className = '' }: { className?: string }) {
  return (
    <p className={`text-xs text-gray-500 ${className}`}>
      When a variable is set in more than one place, the highest priority wins:{' '}
      <span className="text-gray-300">project variables</span> ›{' '}
      <span className="text-gray-300">active profile</span> ›{' '}
      <span className="text-gray-300">global variables</span>.
    </p>
  );
}

/** Editable list of global (default) env vars — Global Settings → Profiles. */
export function GlobalEnvVarsSection() {
  const qc = useQueryClient();
  const { data: envVars = [], isLoading } = useQuery({
    queryKey: GLOBAL_ENV_QUERY_KEY,
    queryFn: () => api.globalEnv.list(),
  });

  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [saving, setSaving] = useState(false);
  const newKeyRef = useRef<HTMLInputElement>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const refresh = () => qc.invalidateQueries({ queryKey: GLOBAL_ENV_QUERY_KEY });

  const handleAdd = async () => {
    const key = newKey.trim();
    if (!key) return;
    setSaving(true);
    try {
      await api.globalEnv.set(key, newValue);
      setNewKey('');
      setNewValue('');
      refresh();
      newKeyRef.current?.focus();
    } catch (e) {
      alert(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleEditSave = async (key: string) => {
    try {
      await api.globalEnv.set(key, editValue);
      setEditingKey(null);
      refresh();
    } catch (e) {
      alert(String(e));
    }
  };

  const handleDelete = async (key: string) => {
    if (!confirm(`Delete '${key}'?`)) return;
    try {
      await api.globalEnv.delete(key);
      refresh();
    } catch (e) {
      alert(String(e));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Global Environment Variables</h3>
        <p className="text-xs text-gray-500">
          Defaults applied to every project, and to the pip install in global setup.
        </p>
        <EnvPrecedenceNote className="mt-1" />
      </div>

      <div className="flex flex-col gap-1.5">
        {isLoading && <p className="text-xs text-gray-600">Loading…</p>}
        {!isLoading && envVars.length === 0 && (
          <p className="text-xs text-gray-600 italic">No global environment variables.</p>
        )}
        {envVars.map((v) => (
          <div key={v.key} className="flex items-center gap-2 px-3 py-2 bg-surface-elevated rounded border border-gray-800 text-xs">
            <span className="font-mono text-brand-300 w-48 shrink-0 truncate">{v.key}</span>
            <span className="text-gray-600">=</span>
            {editingKey === v.key ? (
              <>
                <input
                  autoFocus
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleEditSave(v.key);
                    if (e.key === 'Escape') { e.stopPropagation(); setEditingKey(null); }
                  }}
                  className="flex-1 bg-surface-panel border border-brand-500 rounded px-2 py-0.5 text-gray-100 font-mono focus:outline-none"
                />
                <button onClick={() => handleEditSave(v.key)} className="text-brand-400 hover:text-brand-300 p-1">
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => setEditingKey(null)} className="text-gray-600 hover:text-gray-400 p-1">✕</button>
              </>
            ) : (
              <>
                <span
                  className="flex-1 font-mono text-gray-300 truncate cursor-pointer hover:text-gray-100"
                  onClick={() => { setEditingKey(v.key); setEditValue(v.value); }}
                >
                  {v.value || <span className="text-gray-600 italic">empty</span>}
                </span>
                <button onClick={() => handleDelete(v.key)} className="text-gray-600 hover:text-red-400 p-1 shrink-0">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <input
          ref={newKeyRef}
          placeholder="KEY"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
          className="w-48 bg-surface-elevated border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-100 font-mono focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
        <span className="text-gray-600 text-xs">=</span>
        <input
          placeholder="value"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
          className="flex-1 bg-surface-elevated border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-100 font-mono focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
        <button
          onClick={handleAdd}
          disabled={saving || !newKey.trim()}
          className="px-3 py-1.5 text-xs rounded bg-surface-elevated hover:bg-gray-700 text-gray-300 border border-gray-700 disabled:opacity-40 transition-colors shrink-0"
        >
          Add
        </button>
      </div>
    </div>
  );
}
