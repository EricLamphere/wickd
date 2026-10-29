// Text: a heading or a note. A small subset of Markdown: #/##/### headings, - bullets and
// **bold**; everything is shown as text (no HTML, no links), so a file can't inject markup.
import { Fragment } from 'react';

function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') && part.length > 4
    ? <strong key={i} className="font-semibold text-gray-100">{part.slice(2, -2)}</strong>
    : <Fragment key={i}>{part}</Fragment>));
}

export function TextWidget({ body }: { body: string }) {
  const lines = body.split('\n');
  if (!body.trim()) return <p className="text-xs text-gray-500">Write a heading or a note in the widget's settings.</p>;
  return (
    <div className="flex flex-col gap-1 h-full overflow-auto text-xs text-gray-300">
      {lines.map((line, i) => {
        const t = line.trimEnd();
        if (t.startsWith('### ')) return <h4 key={i} className="text-sm font-semibold text-gray-100">{inline(t.slice(4))}</h4>;
        if (t.startsWith('## ')) return <h3 key={i} className="text-base font-semibold text-gray-100">{inline(t.slice(3))}</h3>;
        if (t.startsWith('# ')) return <h2 key={i} className="text-lg font-semibold text-gray-100">{inline(t.slice(2))}</h2>;
        if (t.startsWith('- ')) return <p key={i} className="flex gap-1.5 pl-1"><span className="text-gray-500">•</span><span>{inline(t.slice(2))}</span></p>;
        return t ? <p key={i}>{inline(t)}</p> : <div key={i} className="h-1" />;
      })}
    </div>
  );
}
