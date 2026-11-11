import { openUrl } from '@tauri-apps/plugin-opener';

/** Open a URL in the system browser. openUrl only exists inside the Tauri shell; from source
 * (`task start`) in a regular browser it falls back to a new tab. */
export function openExternal(url: string): void {
  openUrl(url).catch(() => window.open(url, '_blank', 'noopener,noreferrer'));
}
