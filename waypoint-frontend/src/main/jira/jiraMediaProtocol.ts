import { protocol } from 'electron';
import * as client from './jiraClient';

/**
 * Serves one Jira attachment's bytes to the renderer, so an <img> or a
 * <video> can point straight at it.
 *
 * Why a protocol rather than an IPC call that hands back bytes:
 *
 *  - The credential stays in main. jiraMap.ts deliberately strips Jira's
 *    own `content`/`self`/`thumbnail` URLs from the wire type so no string
 *    from a response body can ever aim an authenticated request; this
 *    keeps that true. The renderer names an ATTACHMENT ID, never a URL,
 *    and the host is built in jiraClient.ts from the stored site as it
 *    always was.
 *  - It respects jiraFiles.ts's rule that no filesystem path crosses IPC:
 *    nothing is written to disk at all.
 *  - <video> needs HTTP range requests to seek. An IPC call returning one
 *    big Buffer cannot do that, and would hold two copies of a large file
 *    in memory besides. This answers ranges.
 *
 * The scheme is registered as privileged in main.ts (before app ready) so
 * the renderer's CSP treats it as a normal, secure media source.
 */
export const JIRA_MEDIA_SCHEME = 'waypoint-jira-attachment';

/** Same shape jiraIpc.ts's `readAttachmentId` allows, for the same reason. */
const ATTACHMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/;

/**
 * Bytes already fetched, newest last.
 *
 * A viewer showing one image asks for it once for the thumbnail and again
 * at full size, and stepping back and forth through an issue's attachments
 * would otherwise re-download each one every time. Bounded by total bytes
 * rather than entry count: one 4K capture is worth more than a hundred
 * icons, and an issue can carry either.
 */
const CACHE_LIMIT_BYTES = 128 * 1024 * 1024;
const cache = new Map<string, { bytes: Buffer; mimeType: string }>();
let cachedBytes = 0;

function remember(id: string, bytes: Buffer, mimeType: string): void {
  if (bytes.byteLength > CACHE_LIMIT_BYTES) return; // never evict everything for one file
  cache.delete(id);
  cache.set(id, { bytes, mimeType });
  cachedBytes += bytes.byteLength;
  for (const [key, entry] of cache) {
    if (cachedBytes <= CACHE_LIMIT_BYTES) break;
    if (key === id) continue;
    cache.delete(key);
    cachedBytes -= entry.bytes.byteLength;
  }
}

/** Test seam, and what a disconnect should call so a new account cannot read
 *  the previous one's attachments out of memory. */
export function clearJiraMediaCache(): void {
  cache.clear();
  cachedBytes = 0;
}

export function jiraMediaUrl(attachmentId: string): string {
  return `${JIRA_MEDIA_SCHEME}://attachment/${encodeURIComponent(attachmentId)}`;
}

/** `bytes=0-1023` → the slice it names, or null when absent/unsatisfiable. */
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;
  // A suffix range (`bytes=-500`) means the LAST 500 bytes.
  let start = rawStart === '' ? size - Number(rawEnd) : Number(rawStart);
  let end = rawStart === '' || rawEnd === '' ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  start = Math.max(0, start);
  end = Math.min(size - 1, end);
  if (start > end) return null;
  return { start, end };
}

/**
 * The id out of a `waypoint-jira-attachment://attachment/<id>` URL, or null
 * when the URL is not one this should answer.
 *
 * Nothing here touches a filesystem, so `..` is not a traversal risk — the
 * id is only ever handed to Jira as an attachment id. The shape check is
 * the same one jiraIpc.ts's `readAttachmentId` applies, so a URL the
 * renderer could not have been given does not become a request.
 */
export function attachmentIdFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${JIRA_MEDIA_SCHEME}:`) return null;
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length !== 1) return null;
  const id = decodeURIComponent(segments[0]);
  return ATTACHMENT_ID.test(id) ? id : null;
}

export interface JiraMediaDeps {
  download: (
    id: string,
  ) => Promise<{ ok: true; value: { bytes: Buffer } } | { ok: false }>;
  /** The attachment's own mimeType, read from Jira — never from the renderer. */
  meta: (
    id: string,
  ) => Promise<{ ok: true; value: { mimeType: string } } | { ok: false }>;
}

export interface JiraMediaReply {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

const TEXT = (s: string) => new TextEncoder().encode(s);

/**
 * The whole handler, as data in and data out.
 *
 * Deliberately not written against `Request`/`Response`: those are the
 * protocol layer's shape, not this logic's, and keeping them at the edge
 * is what lets the range, caching and refusal behaviour be tested without
 * a browser environment.
 */
export async function serveJiraMedia(
  request: { url: string; range?: string | null },
  deps: JiraMediaDeps,
): Promise<JiraMediaReply> {
  const id = attachmentIdFromUrl(request.url);
  if (!id) return { status: 404, headers: {}, body: TEXT('Not found') };

  let entry = cache.get(id);
  if (!entry) {
    const result = await deps.download(id);
    if (!result.ok) {
      // Deliberately bare: a Jira failure reason can name the site or the
      // account, and this response is readable by page script.
      return { status: 502, headers: {}, body: TEXT('Unavailable') };
    }
    const meta = await deps.meta(id);
    entry = {
      bytes: result.value.bytes,
      // A metadata read that fails is not worth failing the whole request
      // over — an octet-stream still downloads, it just will not preview.
      mimeType: meta.ok ? meta.value.mimeType : 'application/octet-stream',
    };
    remember(id, entry.bytes, entry.mimeType);
  }

  const size = entry.bytes.byteLength;
  const headers: Record<string, string> = {
    'Content-Type': entry.mimeType,
    // Seeking in <video> needs the browser to know ranges are available.
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
  };

  const range = parseRange(request.range ?? null, size);
  if (range) {
    const slice = entry.bytes.subarray(range.start, range.end + 1);
    return {
      status: 206,
      headers: {
        ...headers,
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Content-Length': String(slice.byteLength),
      },
      body: new Uint8Array(slice),
    };
  }

  return {
    status: 200,
    headers: { ...headers, 'Content-Length': String(size) },
    body: new Uint8Array(entry.bytes),
  };
}

export function registerJiraMediaProtocol(): void {
  protocol.handle(JIRA_MEDIA_SCHEME, async (request) => {
    const reply = await serveJiraMedia(
      { url: request.url, range: request.headers.get('range') },
      {
        download: (id) => client.downloadAttachment(id),
        meta: (id) => client.getAttachmentMeta(id),
      },
    );
    // `reply.body` is a Uint8Array; the DOM lib in this project types
    // BodyInit without it, so the buffer is handed over explicitly.
    return new Response(reply.body.buffer as ArrayBuffer, {
      status: reply.status,
      headers: reply.headers,
    });
  });
}
