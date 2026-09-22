/**
 * Durations in a person's units (customer feedback round 1, Fix 6): the
 * Review health strip said `825s`, My Jira said `synced 277m ago`. One
 * helper, so no screen prints a raw second or minute count again.
 *
 *   45     → "45s"
 *   825    → "14 min"
 *   3600   → "1h"
 *   16620  → "4h 37min"
 */
export function humanizeDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}min`;
}

/** `humanizeDuration` of the time since `iso`, with "ago"; "just now" under a second. */
export function humanizeAgo(iso: string, now: number = Date.now()): string {
  const secs = (now - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(secs)) return 'just now';
  if (secs < 1) return 'just now';
  return `${humanizeDuration(secs)} ago`;
}
