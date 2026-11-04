import { useState } from 'react';
import { api, type DocsMacroDto } from '../../../lib/api';
import { buildMacroCall, wrapJinja } from '../lib/macroCall';
import { CodeBlock, CopyButton, MetaCell } from './DetailParts';

export function MacroDetail({ macro, projectId, callName }: { macro: DocsMacroDto; projectId: number; callName: string }) {
  const [copied, setCopied] = useState(false);
  const [argValues, setArgValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(macro.arguments.map((a) => [a.name, '']))
  );
  const [callText, setCallText] = useState(() =>
    buildMacroCall(callName, Object.fromEntries(macro.arguments.map((a) => [a.name, ''])))
  );
  const [compiledSql, setCompiledSql] = useState<string | null>(null);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(macro.macro_sql).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  function handleArgChange(name: string, value: string) {
    const next = { ...argValues, [name]: value };
    setArgValues(next);
    setCallText(buildMacroCall(callName, next));
  }

  /** ⌘/Ctrl+Enter in the call box or an argument input compiles, like the SQL Workspace's run. */
  function handleCompileShortcut(e: React.KeyboardEvent) {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    if (!compiling) handleCompile();
  }

  async function handleCompile() {
    setCompiling(true);
    setCompileError(null);
    setCompiledSql(null);
    try {
      const result = await api.workspace.compile(projectId, { sql: wrapJinja(callText) });
      setCompiledSql(result.compiled_sql);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setCompileError(msg);
    } finally {
      setCompiling(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-8 py-6 flex flex-col gap-6">
      <div className="flex items-baseline gap-3">
        <h1 className="text-2xl font-semibold text-gray-100 font-mono">{macro.name}</h1>
        <span className="text-sm text-gray-500">macro</span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-x-6 gap-y-3 text-xs">
        {macro.package_name && <MetaCell label="Package" value={macro.package_name} />}
        {macro.path && <MetaCell label="Path" value={macro.path} />}
      </div>
      {macro.description
        ? <p className="text-sm text-gray-300 leading-relaxed">{macro.description}</p>
        : <p className="text-sm text-gray-600 italic">No description provided.</p>}
      {macro.arguments.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-gray-200 mb-3">Arguments</h2>
          <div className="rounded-lg border border-gray-800 overflow-hidden">
            <table className="w-full text-xs text-gray-300 border-collapse">
              <thead>
                <tr className="bg-surface-elevated text-gray-500">
                  <th className="px-3 py-2 text-left font-medium border-b border-gray-800">Name</th>
                  <th className="px-3 py-2 text-left font-medium border-b border-gray-800">Type</th>
                  <th className="px-3 py-2 text-left font-medium border-b border-gray-800">Description</th>
                </tr>
              </thead>
              <tbody>
                {macro.arguments.map((arg, i) => (
                  <tr key={arg.name} className={`border-b border-gray-800/60 ${i % 2 === 0 ? '' : 'bg-surface-elevated/20'}`}>
                    <td className="px-3 py-2 font-mono text-brand-300">{arg.name}</td>
                    <td className="px-3 py-2 font-mono text-gray-500">{arg.type || '—'}</td>
                    <td className="px-3 py-2 text-gray-400">{arg.description || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {macro.macro_sql && (
        <section>
          <div className="flex items-center gap-3 mb-2">
            <h2 className="text-sm font-semibold text-gray-200">Macro SQL</h2>
            <CopyButton copied={copied} onCopy={handleCopy} />
          </div>
          <CodeBlock code={macro.macro_sql} placeholder="No SQL." />
        </section>
      )}
      <section className="flex flex-col gap-5">
        <h2 className="text-sm font-semibold text-gray-200">Try It</h2>

        {macro.arguments.length > 0 && (
          <div className="rounded-lg border border-gray-800 p-4 flex flex-col gap-3">
            <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider">Inputs</h3>
            {macro.arguments.map((arg) => (
              <div key={arg.name} className="flex flex-col gap-1">
                <label className="text-xs font-mono text-brand-300">{arg.name}{arg.type && <span className="text-gray-500 font-sans"> ({arg.type})</span>}</label>
                <input
                  type="text"
                  value={argValues[arg.name] ?? ''}
                  onChange={(e) => handleArgChange(arg.name, e.target.value)}
                  onKeyDown={handleCompileShortcut}
                  placeholder="value"
                  className="bg-surface-app border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 font-mono focus:border-brand-500 focus:outline-none"
                />
              </div>
            ))}
          </div>
        )}

        <div className="rounded-lg border border-gray-800 p-4 flex flex-col gap-3">
          <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider">Macro Call</h3>
          <div className="relative">
            <textarea
              value={callText}
              onChange={(e) => setCallText(e.target.value)}
              onKeyDown={handleCompileShortcut}
              rows={Math.max(3, callText.split('\n').length)}
              spellCheck={false}
              className="w-full bg-surface-app border border-gray-700 rounded px-3 py-2 text-xs text-gray-300 font-mono focus:border-brand-500 focus:outline-none resize-none leading-relaxed"
            />
            <button
              onClick={handleCompile}
              title="Compile (⌘Enter)"
              disabled={compiling}
              className="absolute top-2 right-2 text-xs px-2.5 py-1 rounded bg-brand-600 hover:bg-brand-500 text-white disabled:opacity-50"
            >
              {compiling ? 'Compiling…' : 'Compile'}
            </button>
          </div>
        </div>

        {(compiledSql !== null || compileError) && (
          <div className="rounded-lg border border-gray-800 p-4 flex flex-col gap-3">
            <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider">Compiled SQL</h3>
            {compileError ? (
              <pre className="text-xs text-red-400 bg-surface-app rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap">
                {compileError}
              </pre>
            ) : (
              <CodeBlock code={compiledSql!} placeholder="Empty output." />
            )}
          </div>
        )}
      </section>
    </div>
  );
}
