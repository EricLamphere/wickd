/** "5m ago" / "3d ago" style label for an ISO timestamp. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const secs = Math.floor((now - new Date(iso).getTime()) / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 14) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}
