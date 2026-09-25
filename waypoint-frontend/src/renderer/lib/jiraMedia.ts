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
  // Parameters off first: `image/svg+xml; charset=utf-8` is an ordinary
  // thing for a site to send, and comparing the whole header let it
  // straight past the SVG check into `image`.
  const type = a.mimeType.toLowerCase().split(';')[0].trim();
  // SVG is deliberately NOT previewable, as defence in depth rather than
  // because it would execute: an SVG loaded through <img> runs in
  // Chromium's restricted mode, no script and no external fetches, and
  // every consumer here is an <img>. The real decoder surface is that
  // <img>/<video> are handed bytes chosen by whoever attached them —
  // inherent to previewing media at all, and not reduced by this check.
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

/** The attrs an ADF `media`/`mediaInline` node carries that help identify it. */
export interface JiraMediaNodeAttrs {
  /** Jira's media-services UUID — NOT the attachment id. */
  id?: unknown;
  /** Jira puts the original filename here. */
  alt?: unknown;
  /** Jira's own per-node id, stable within one document. */
  localId?: unknown;
  width?: unknown;
  height?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Jira's media ids are UUIDs; anything else in that field is not one. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which attachment each inline media node refers to, in document order.
 *
 * ADF gives a media node a media-services UUID, and the REST API exposes no
 * way to turn that into an attachment id — the two id spaces simply do not
 * meet in the public API (verified against a live site, 2026-09-25). So the
 * match is made on what they DO share:
 *
 *  1. The UUID appearing inside the filename. When two attachments collide
 *     on a name, Jira renames the later one by appending its own media
 *     UUID — `Screenshot.png` and
 *     `Screenshot (5907207c-5908-4f5a-8468-2ddeb3803481).png`. That is an
 *     exact, unambiguous link, so it is tried first.
 *  2. `alt` against the filename. Jira fills `alt` with the original
 *     filename, which covers every ordinary case.
 *
 * An attachment is claimed by at most one node, so two nodes sharing an
 * `alt` resolve to two different files rather than both to the first.
 * A node that matches nothing returns null and keeps the old placeholder:
 * showing the wrong image would be worse than showing none.
 */
export function matchMediaToAttachments(
  nodes: readonly JiraMediaNodeAttrs[],
  attachments: readonly JiraAttachment[],
): (JiraAttachment | null)[] {
  const claimed = new Set<JiraAttachment>();

  /**
   * Jira's collision rename, and only that: `Screenshot (uuid).png`.
   *
   * Both halves matter. The id is REQUIRED to be UUID-shaped because it
   * comes out of the issue body — anyone who can edit a description or
   * post a comment picks it — and an unshaped value like `.` or `png`
   * made `includes` true for nearly every attachment on the issue,
   * resolving to whichever came first. And the parenthesised form is
   * required rather than a bare substring so a filename that merely
   * contains the text cannot claim it. This runs before the name match,
   * so leaving it loose meant the attacker-controlled field beat the
   * reliable one.
   */
  const byRename = (uuid: string) => {
    if (!UUID.test(uuid)) return undefined;
    const marker = `(${uuid})`;
    return attachments.find(
      (a) => !claimed.has(a) && a.fileName.includes(marker),
    );
  };
  const byName = (name: string) =>
    name
      ? attachments.find((a) => !claimed.has(a) && a.fileName === name)
      : undefined;

  return nodes.map((node) => {
    const match = byRename(str(node.id)) ?? byName(str(node.alt));
    if (!match) return null;
    claimed.add(match);
    return match;
  });
}

/** Every `media`/`mediaInline` node's attrs in an ADF doc, in document order. */
export function collectMediaNodes(adf: unknown): JiraMediaNodeAttrs[] {
  const out: JiraMediaNodeAttrs[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as {
      type?: unknown;
      attrs?: unknown;
      content?: unknown;
    };
    if (record.type === 'media' || record.type === 'mediaInline') {
      out.push((record.attrs as JiraMediaNodeAttrs) ?? {});
    }
    if (record.content) walk(record.content);
  };
  walk(adf);
  return out;
}

/**
 * A stable key for one media node — what the renderer looks its attachment
 * up by. `localId` is Jira's own per-node id and is present on anything the
 * Jira editor produced; `id` (the media UUID) is the fallback.
 */
export function mediaNodeKey(attrs: JiraMediaNodeAttrs): string {
  return str(attrs.localId) || str(attrs.id);
}

/** Node key -> the attachment it refers to, for a whole document. */
export function resolveDocumentMedia(
  adf: unknown,
  attachments: readonly JiraAttachment[],
): Map<string, JiraAttachment> {
  const nodes = collectMediaNodes(adf);
  const matched = matchMediaToAttachments(nodes, attachments);
  const out = new Map<string, JiraAttachment>();
  nodes.forEach((node, i) => {
    const match = matched[i];
    const key = mediaNodeKey(node);
    if (match && key) out.set(key, match);
  });
  return out;
}
