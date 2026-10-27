/** Text with `backticked` names rendered as code (refactor titles and descriptions). */
export function InlineCode({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part))}
    </>
  );
}
