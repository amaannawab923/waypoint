import type { JiraAttachment } from '@/types/jira';

/**
 * The scheme main serves Jira attachment bytes on
 * (main/jira/jiraMediaProtocol.ts). The renderer names an attachment ID and
 * nothing else: no Jira URL and no credential is ever handed to it, which
 * is the same rule jiraMap.ts keeps by stripping Jira's own content URLs
 * off the wire type.
 */
export function jiraMediaUrl(attachmentId: string): string {
  return `waypoint-jira-attachment://attachment/${encodeURIComponent(attachmentId)}`;
}

/** Types the viewer can actually show, as opposed to only download. */
export type JiraMediaKind = 'image' | 'video' | 'audio' | 'other';

export function mediaKindOf(
  a: Pick<JiraAttachment, 'mimeType'>,
): JiraMediaKind {
  const type = a.mimeType.toLowerCase();
  // SVG is deliberately NOT previewable. It is an image type that can carry
  // script, and these bytes come from whoever attached them to the issue.
  if (type === 'image/svg+xml') return 'other';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return 'other';
}

/** Whether this attachment can be opened in the viewer at all. */
export function isViewable(a: JiraAttachment): boolean {
  return a.id !== null && mediaKindOf(a) !== 'other';
}

/**
 * `image · 435 B` — the line Jira's own viewer shows under the filename.
 * The kind word, not the raw mime type: "image" is what the person needs,
 * `image/png` is what the file is.
 */
export function mediaSubtitle(a: JiraAttachment): string {
  const kind = mediaKindOf(a);
  const word = kind === 'other' ? 'file' : kind;
  return `${word} · ${a.sizeLabel}`;
}

/** Zoom stops, in the order the +/- buttons step through. */
export const ZOOM_STOPS = [
  0.1, 0.25, 0.33, 0.5, 0.67, 1, 1.5, 2, 3, 4, 5,
] as const;

export function nextZoom(current: number, direction: 1 | -1): number {
  const stops = ZOOM_STOPS;
  if (direction === 1) {
    return stops.find((s) => s > current + 0.001) ?? stops[stops.length - 1];
  }
  const below = stops.filter((s) => s < current - 0.001);
  return below.length ? below[below.length - 1] : stops[0];
}

/**
 * The scale at which an image of `natural` size fits inside `viewport`,
 * never enlarging past 1.
 *
 * This is what makes a 3840x2160 capture open readable instead of
 * overflowing — Jira shows exactly this as its starting zoom (41% for that
 * file in a 1474px-wide window), and a viewer that opened everything at
 * 100% would be the single most obvious difference from it.
 */
export function fitScale(
  natural: { width: number; height: number },
  viewport: { width: number; height: number },
): number {
  if (!natural.width || !natural.height) return 1;
  return Math.min(
    1,
    viewport.width / natural.width,
    viewport.height / natural.height,
  );
}
