/** Browsers refuse (or silently blank) canvases past these limits; WebKit's are the tightest. */
export const MAX_CANVAS_SIDE = 16384;
export const MAX_CANVAS_AREA = 16_777_216;
export const PREFERRED_SCALE = 2;

/** Render scale for a PNG: 2× when it fits, shrunk so the canvas stays inside the limits. */
export function pngScale(width: number, height: number): number {
  if (width <= 0 || height <= 0) return PREFERRED_SCALE;
  return Math.min(
    PREFERRED_SCALE,
    MAX_CANVAS_SIDE / width,
    MAX_CANVAS_SIDE / height,
    Math.sqrt(MAX_CANVAS_AREA / (width * height)),
  );
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The DAG image could not be rendered.'));
    img.src = src;
  });
}

/** Rasterises a standalone SVG document; resolves to base64 PNG data (no data: prefix). */
export async function svgToPngBase64(svg: string, width: number, height: number): Promise<{ base64: string; scale: number }> {
  const scale = pngScale(width, height);
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(width * scale));
  canvas.height = Math.max(1, Math.floor(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot render PNG images.');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/png');
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || dataUrl.length - comma < 16) throw new Error('The DAG is too large to render as a PNG. Try SVG instead.');
  return { base64: dataUrl.slice(comma + 1), scale };
}
