import { useEffect, useState } from 'react';
import { loader } from '@monaco-editor/react';
import { resolveMonacoLanguage } from '../../../../lib/codeLanguage';
import { useTheme } from '../../../../lib/useTheme';

/**
 * A fenced code block highlighted by Monaco's own tokenizer (`monaco.editor.colorize`), so it
 * reads exactly like the app's editors. Monaco is already loaded at startup
 * (installMonacoKeyGuard). Plain text shows until the highlighted HTML is ready, or for good if
 * Monaco is unavailable or the language is unknown. colorize() escapes the source, so its HTML
 * is safe to inject.
 */
export function CodeBlock({ code, language }: { code: string; language: string | null }) {
  const theme = useTheme();
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    if (!language) return;
    loader.init()
      .then(async (monaco) => {
        const id = resolveMonacoLanguage(language, monaco.languages.getLanguages());
        if (!id) return;
        // Token colors come from the active Monaco theme's stylesheet; set the same theme every
        // editor in the app uses, so the stylesheet exists even before any editor has mounted
        monaco.editor.setTheme(theme === 'light' ? 'vs-light' : 'vs-dark');
        const colored = await monaco.editor.colorize(code.replace(/\n$/, ''), id, { tabSize: 2 });
        if (!cancelled) setHtml(colored);
      })
      .catch((err: unknown) => console.warn('code block highlighting unavailable', err));
    return () => { cancelled = true; };
  }, [code, language, theme]);

  return (
    <pre className="code-block" data-language={language ?? undefined}>
      {html !== null
        ? <code className="monaco-colorized" dangerouslySetInnerHTML={{ __html: html }} />
        : <code>{code.replace(/\n$/, '')}</code>}
    </pre>
  );
}
