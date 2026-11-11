import { memo, useMemo, type MouseEvent, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import { docsPagesApi } from '../../../../lib/docsPagesApi';
import { parseInlineRef, resolveImage, resolveLink, type LinkContext, type LinkTarget } from '../../lib/docsPageLinks';
import { fenceLanguage } from '../../../../lib/codeLanguage';
import { CodeBlock } from './CodeBlock';
import { MermaidDiagram } from './MermaidDiagram';

export interface MarkdownPageProps {
  projectId: number;
  text: string;
  ctx: LinkContext;
  onLink: (target: LinkTarget) => void;
}

interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

function hastText(node: HastNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
}

/** A fenced block's source and language (null when the fence names none). */
function fencedCode(pre: HastNode | undefined): { code: string; language: string | null } | null {
  const code = pre?.children?.find((c) => c.tagName === 'code');
  if (!code) return null;
  const classes = code.properties?.className;
  return { code: hastText(code), language: fenceLanguage(Array.isArray(classes) ? classes.join(' ') : undefined) };
}

/** react-markdown drops links with unknown protocols; `ref:` / `source:` are wickd's node links. */
function urlTransform(url: string): string {
  return /^(ref|source):/i.test(url) ? url : defaultUrlTransform(url);
}

function UnresolvedRef({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="underline decoration-dotted decoration-gray-500 underline-offset-2 cursor-help" title={`${label}: not in the manifest`}>
      {children}
    </span>
  );
}

/**
 * GitHub-flavored Markdown with wickd's links: relative pages stay in the Docs page, `ref:` /
 * `source:` links (and inline `ref('x')` code) open node docs, local images go through the
 * docs asset route. Raw HTML stays off (react-markdown's default).
 */
export const MarkdownPage = memo(function MarkdownPage({ projectId, text, ctx, onLink }: MarkdownPageProps) {
  const components = useMemo<Components>(() => {
    const click = (target: LinkTarget) => (e: MouseEvent) => {
      e.preventDefault();
      onLink(target);
    };
    return {
      a: ({ href, children }) => {
        const target = resolveLink(href, ctx);
        if (target.kind === 'unresolved_node') return <UnresolvedRef label={target.label}>{children}</UnresolvedRef>;
        if (target.kind === 'none') return <span className="text-gray-400">{children}</span>;
        return <a href={href} onClick={click(target)} title={target.kind === 'external' ? href : undefined}>{children}</a>;
      },
      img: ({ src, alt, title }) => {
        const image = resolveImage(typeof src === 'string' ? src : undefined, ctx);
        if (!image) return <span className="text-gray-500 italic">{alt}</span>;
        const url = image.local ? docsPagesApi.assetUrl(projectId, image.local.path, image.local.root) : image.src;
        return <img src={url} alt={alt ?? ''} title={title} loading="lazy" className="max-w-full inline-block" />;
      },
      pre: ({ node, children }) => {
        const fenced = fencedCode(node as HastNode | undefined);
        if (!fenced) return <pre>{children}</pre>;
        if (fenced.language === 'mermaid') return <MermaidDiagram code={fenced.code} />;
        return <CodeBlock code={fenced.code} language={fenced.language} />;
      },
      code: ({ className, children }) => {
        const content = String(children ?? '');
        const ref = !className && !content.includes('\n') ? parseInlineRef(content) : null;
        if (!ref) return <code className={className}>{children}</code>;
        const target = resolveLink(`${ref.kind}:${ref.name}`, ctx);
        if (target.kind !== 'node') return <UnresolvedRef label={`${ref.kind}:${ref.name}`}><code>{children}</code></UnresolvedRef>;
        return <a href={`#${target.uid}`} onClick={click(target)}><code>{children}</code></a>;
      },
      table: ({ children }) => <div className="overflow-x-auto"><table>{children}</table></div>,
    };
  }, [ctx, onLink, projectId]);

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug]} components={components} urlTransform={urlTransform}>
      {text}
    </ReactMarkdown>
  );
});
