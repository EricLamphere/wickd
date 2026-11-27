// Where the caret sits inside a textarea (px from its top-left, below the caret's line), for a
// suggestions menu at the caret. A hidden mirror div with the textarea's text and styles up to the
// caret, then a marker span: the span's offset is the caret's.
const COPIED = [
  'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant', 'fontWeight',
  'fontStretch', 'fontSize', 'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent',
  'letterSpacing', 'wordSpacing', 'tabSize',
] as const;

export function caretCoords(el: HTMLTextAreaElement, position: number): { left: number; top: number } {
  const style = getComputedStyle(el);
  const mirror = document.createElement('div');
  for (const prop of COPIED) mirror.style[prop] = style[prop];
  Object.assign(mirror.style, {
    position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', wordWrap: 'break-word', overflow: 'hidden',
  });
  mirror.textContent = el.value.slice(0, position);
  const marker = document.createElement('span');
  marker.textContent = el.value.slice(position) || '.';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4 || 16;
  const coords = { left: marker.offsetLeft - el.scrollLeft, top: marker.offsetTop - el.scrollTop + lineHeight };
  document.body.removeChild(mirror);
  return coords;
}
