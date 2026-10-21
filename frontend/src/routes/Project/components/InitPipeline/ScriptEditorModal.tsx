import { useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { api, type InitStepDto, type ScriptTestResultDto } from '../../../../lib/api';
import { useTheme } from '../../../../lib/useTheme';
import { CapturedVarsEditor } from './CapturedVarsEditor';
import { ScriptTestOutput } from './ScriptTestOutput';

// Starting point for a new script (Monaco has no placeholder text).
const NEW_SCRIPT_TEMPLATE = '#!/usr/bin/env bash\nset -e\n\n# your setup here\n';

function sameVars(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

interface ScriptEditorProps {
  projectId: number;
  initScriptPath: string;
  existing?: InitStepDto;
  onClose: () => void;
}

export function ScriptEditorModal({ projectId, initScriptPath, existing, onClose }: ScriptEditorProps) {
  const isEdit = !!existing;
  const bareExistingName = existing?.name.replace(/^custom:\s*/, '') ?? '';

  const [name, setName] = useState(bareExistingName);
  const [content, setContent] = useState(isEdit ? '' : NEW_SCRIPT_TEMPLATE);
  const formRef = useRef<HTMLFormElement>(null);
  const monacoTheme = useTheme() === 'light' ? 'vs-light' : 'vs-dark';

  // ⌘S / Ctrl+S inside the editor saves, same as the submit button.
  const handleEditorMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => formRef.current?.requestSubmit());
    if (isEdit) editor.focus();
  };
  const initialVars = existing?.captured_vars ?? [];
  const [capturedVars, setCapturedVars] = useState<string[]>(initialVars);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ScriptTestResultDto | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingContent, setLoadingContent] = useState(isEdit);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEdit || !bareExistingName) return;
    setLoadingContent(true);
    api.init.getScriptContent(projectId, bareExistingName)
      .then((text) => { setContent(text); })
      .catch(() => { setContent(''); })
      .finally(() => setLoadingContent(false));
  }, [isEdit, projectId, bareExistingName]);

  // Runs the editor's current text (unsaved edits included) with the project's env.
  const handleTest = async () => {
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      setTestResult(await api.init.testScript(projectId, {
        content,
        captured_vars: capturedVars,
        step_name: isEdit ? bareExistingName : null,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTestError(message.startsWith('409') ? 'Init pipeline is running. Try again when it finishes.' : message);
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setError('Name is required.'); return; }
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
      setError('Name may only contain letters, digits, underscores, and hyphens.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const nameChanged = isEdit && trimmed !== bareExistingName;
      if (isEdit && !nameChanged) {
        // Save content back to wherever the script actually lives (handles linked scripts)
        await api.init.putScriptContent(projectId, trimmed, content);
        if (!sameVars(capturedVars, initialVars)) {
          await api.init.setCapturedVars(projectId, trimmed, capturedVars);
        }
      } else {
        // New script, or a rename (a new step under the new name replaces the old one)
        await api.init.createStep(projectId, trimmed, content);
        if (capturedVars.length > 0) {
          await api.init.setCapturedVars(projectId, trimmed, capturedVars);
        }
        if (nameChanged) await api.init.deleteStep(projectId, bareExistingName);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="flex flex-col bg-surface-panel border border-gray-700 rounded-lg shadow-xl w-full max-w-3xl mx-4 max-h-[85vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
          <h2 className="text-sm font-semibold text-gray-100">
            {isEdit ? `Edit: ${bareExistingName}` : 'New custom script'}
          </h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300">✕</button>
        </div>

        <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-4 p-5 overflow-auto">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-gray-400 font-medium">Script name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="setup_env"
              autoFocus={!isEdit}
              className="bg-surface-elevated border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <p className="text-[11px] text-gray-600">
              {isEdit && existing?.script_path
                ? <>Saved to <code className="font-mono text-gray-500">{existing.script_path}</code></>
                : <>Saved as <code className="font-mono text-gray-500">{initScriptPath}/{name || 'script_name'}.sh</code></>
              }
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-gray-400 font-medium">Shell script</label>
            {loadingContent ? (
              <div className="h-[320px] bg-surface-elevated rounded flex items-center justify-center text-gray-600 text-sm">
                Loading…
              </div>
            ) : (
              <div className="h-[320px] rounded border border-gray-700 overflow-hidden">
                <Editor
                  language="shell"
                  value={content}
                  onChange={(v) => setContent(v ?? '')}
                  onMount={handleEditorMount}
                  theme={monacoTheme}
                  options={{
                    fontSize: 13,
                    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
                    lineNumbers: 'on',
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    tabSize: 2,
                    automaticLayout: true,
                    bracketPairColorization: { enabled: true },
                    guides: { indentation: true },
                    renderWhitespace: 'selection',
                    padding: { top: 8 },
                  }}
                />
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <CapturedVarsEditor vars={capturedVars} onChange={setCapturedVars} />
            <p className="text-[11px] text-gray-600">
              Variables the script exports that are saved as project env vars after each successful run.
            </p>
          </div>

          <ScriptTestOutput result={testResult} running={testing} error={testError} />

          {error && (
            <p className="text-xs text-red-400 bg-red-950/40 border border-red-900 rounded px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={handleTest}
              disabled={testing || loadingContent}
              title="Run the script as written, with this project's environment variables"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-surface-elevated hover:bg-blue-950/50 text-gray-300 hover:text-blue-300 disabled:opacity-50 transition-colors"
            >
              {testing ? (
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 100 16v-4l-3 3 3 3v-4a8 8 0 01-8-8z" />
                </svg>
              ) : (
                <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
                </svg>
              )}
              {testing ? 'Testing…' : 'Test'}
            </button>
            <span className="mr-auto text-[10px] text-gray-600">⌘S to save</span>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 text-xs rounded bg-surface-elevated hover:bg-gray-700 text-gray-300 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || loadingContent}
              className="px-4 py-1.5 text-xs rounded bg-brand-600 hover:bg-brand-500 text-white font-medium transition-colors disabled:opacity-50"
            >
              {loading ? 'Saving…' : isEdit ? 'Save changes' : 'Create script'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
