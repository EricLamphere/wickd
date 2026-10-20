import { useTheme } from '../lib/useTheme';

/**
 * The wickd mark: the app icon's flame without the tile, in the variant that reads on the
 * current theme. Files live in frontend/public/ (derived from src-tauri/icons/icon.svg).
 * Size it by height; the mark is about half as wide as it is tall.
 */
export function WickdIcon({ className = 'h-6 w-auto' }: { className?: string }) {
  const theme = useTheme();
  const src = theme === 'light' ? '/wickd-mark-light.svg' : '/wickd-mark.svg';
  return <img src={src} alt="" aria-hidden className={className} draggable={false} />;
}
