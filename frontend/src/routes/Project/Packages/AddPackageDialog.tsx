import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ExternalLink, Loader2, Search, X } from 'lucide-react';
import { packagesApi, type HubPackageDto } from '../../../lib/packagesApi';
import { openExternal } from '../../../lib/openExternal';
import { rangeText } from './packagesView';

const SEARCH_DEBOUNCE_MS = 200;
const HOUR_MS = 3_600_000;

interface AddPackageDialogProps {
  installed: ReadonlySet<string>; // hub names already in the packages file
  onAdd: (fullName: string, version: string) => void;
  onClose: () => void;
}

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Browse dbt Hub: search by name, pick a version (compatibility with the installed dbt-core shown), read the README. */
export function AddPackageDialog({ installed, onAdd, onClose }: AddPackageDialogProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const q = useDebounced(query, SEARCH_DEBOUNCE_MS);
  const search = useQuery({ queryKey: ['hub-search', q], queryFn: () => packagesApi.hubSearch(q), staleTime: HOUR_MS });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onMouseDown={onClose}>
      <div
        className="flex flex-col w-[60rem] max-w-[95vw] h-[80vh] bg-surface-panel border border-gray-700 rounded-lg shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 shrink-0">
          <h2 className="text-sm font-semibold text-gray-100">Add a package from dbt Hub</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300" title="Close"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex flex-1 min-h-0">
          <div className="flex flex-col w-72 border-r border-gray-800 shrink-0">
            <label className="flex items-center gap-2 px-3 py-2 border-b border-gray-800">
              <Search className="w-3.5 h-3.5 text-gray-500" />
              <input
                autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search packages…"
                className="flex-1 bg-transparent text-xs text-gray-200 placeholder-gray-600 outline-none"
              />
            </label>
            <div className="flex-1 overflow-y-auto py-1">
              {search.isLoading && <p className="px-3 py-2 text-xs text-gray-600">Searching…</p>}
              {search.data && !search.data.reachable && (
                <p className="px-3 py-2 text-xs text-amber-400">dbt Hub can't be reached. Check your connection.</p>
              )}
              {search.data?.reachable && search.data.results.length === 0 && (
                <p className="px-3 py-2 text-xs text-gray-600">No packages match</p>
              )}
              {search.data?.results.map((name) => (
                <button
                  key={name} type="button" onClick={() => setSelected(name)}
                  className={`flex items-center justify-between w-full px-3 py-1 text-left text-xs font-mono truncate
                    ${selected === name ? 'bg-brand-900/50 text-brand-300' : 'text-gray-300 hover:bg-surface-elevated'}`}
                >
                  <span className="truncate">{name}</span>
                  {installed.has(name) && <span className="ml-2 text-[10px] text-gray-500 font-sans">added</span>}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 min-w-0">
            {selected
              ? <PackageDetail key={selected} fullName={selected} added={installed.has(selected)} onAdd={onAdd} />
              : <p className="p-6 text-xs text-gray-600">Pick a package to see its versions and README.</p>}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PackageDetail({ fullName, added, onAdd }: { fullName: string; added: boolean; onAdd: (n: string, v: string) => void }) {
  const pkg = useQuery({ queryKey: ['hub-package', fullName], queryFn: () => packagesApi.hubPackage(fullName), staleTime: HOUR_MS });
  const [version, setVersion] = useState<string | null>(null);
  const chosen = version ?? pkg.data?.latest_compatible ?? pkg.data?.latest ?? null;
  if (pkg.isLoading) return <p className="p-6 text-xs text-gray-600 flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" />Loading…</p>;
  if (pkg.error || !pkg.data) return <p className="p-6 text-xs text-red-400">Couldn't load {fullName} from dbt Hub.</p>;
  return (
    <div className="flex flex-col h-full">
      <DetailHeader pkg={pkg.data} version={chosen} onVersion={setVersion} added={added} onAdd={() => chosen && onAdd(fullName, chosen)} />
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {chosen && <Readme fullName={fullName} version={chosen} />}
      </div>
    </div>
  );
}

interface DetailHeaderProps {
  pkg: HubPackageDto;
  version: string | null;
  onVersion: (v: string) => void;
  added: boolean;
  onAdd: () => void;
}

function DetailHeader({ pkg, version, onVersion, added, onAdd }: DetailHeaderProps) {
  const current = pkg.versions.find((v) => v.version === version);
  return (
    <div className="flex flex-col gap-2 px-5 py-3 border-b border-gray-800">
      <div className="flex items-center gap-2">
        <span className="flex-1 font-mono text-sm text-gray-100 truncate">{pkg.full_name}</span>
        {pkg.repo_url && (
          <button type="button" onClick={() => openExternal(pkg.repo_url!)} className="text-gray-500 hover:text-gray-300" title={pkg.repo_url}>
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {pkg.description && <p className="text-xs text-gray-400">{pkg.description}</p>}
      <div className="flex items-center gap-2">
        <select
          value={version ?? ''} onChange={(e) => onVersion(e.target.value)}
          className="px-2 py-1 text-xs font-mono bg-surface-elevated border border-gray-700 rounded text-gray-200"
        >
          {pkg.versions.map((v) => (
            <option key={v.version} value={v.version}>
              {v.version}{v.compatible === false ? ' (incompatible)' : ''}{v.version === pkg.latest_compatible ? ' (newest compatible)' : ''}
            </option>
          ))}
        </select>
        {current && (
          <span className={`text-[11px] ${current.compatible === false ? 'text-red-400' : 'text-gray-500'}`}>
            require-dbt-version {rangeText(current.require_dbt_version)}
            {current.compatible === false && pkg.dbt_version ? `: doesn't support dbt ${pkg.dbt_version}` : ''}
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button" onClick={onAdd} disabled={added || !version}
          className="px-3 py-1.5 text-xs rounded bg-brand-600 hover:bg-brand-500 text-white font-medium disabled:opacity-40"
          title={added ? 'Already in the packages file' : undefined}
        >
          {added ? 'Added' : 'Add package'}
        </button>
      </div>
    </div>
  );
}

function Readme({ fullName, version }: { fullName: string; version: string }) {
  const readme = useQuery({
    queryKey: ['hub-readme', fullName, version], queryFn: () => packagesApi.hubReadme(fullName, version), staleTime: HOUR_MS,
  });
  if (readme.isLoading) return <p className="text-xs text-gray-600">Loading README…</p>;
  if (!readme.data?.text) return <p className="text-xs text-gray-600">No README for this version.</p>;
  return (
    <div className="prose-readme text-sm">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} onClick={(e) => { e.preventDefault(); if (href?.startsWith('http')) openExternal(href); }}>{children}</a>
          ),
          img: ({ src, alt }) => (typeof src === 'string' && src.startsWith('https://') ? <img src={src} alt={alt ?? ''} /> : null),
        }}
      >
        {readme.data.text}
      </ReactMarkdown>
    </div>
  );
}
