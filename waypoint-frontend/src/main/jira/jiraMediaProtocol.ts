import { protocol } from 'electron';
import { readStoredJiraCredential } from './jiraAuth';
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

/**
 * Cache key. The SITE is part of it, not just the attachment id.
 *
 * Jira Cloud attachment ids are small per-site integers, so `10001` on one
 * site and `10001` on another are different files with the same id. Keyed
 * by id alone, connecting a second account would have been served the
 * first one's bytes out of memory with no credential check. Keying by site
 * makes that impossible rather than relying on every disconnect path
 * remembering to clear (jiraIpc.ts's disconnect handler clears too, so the
 * bytes do not simply sit there either).
 */
function cacheKey(site: string, id: string): string {
  return `${site}\u0000${id}`;
}

function remember(key: string, bytes: Buffer, mimeType: string): void {
  if (bytes.byteLength > CACHE_LIMIT_BYTES) return; // never evict everything for one file
  const existing = cache.get(key);
  // Decrement on replace: without this, two concurrent misses for the same
  // key both add their size and `cachedBytes` drifts above what the map
  // actually holds, evicting entries that are still wanted.
  if (existing) cachedBytes -= existing.bytes.byteLength;
  cache.delete(key);
  cache.set(key, { bytes, mimeType });
  cachedBytes += bytes.byteLength;
  for (const [other, entry] of cache) {
    if (cachedBytes <= CACHE_LIMIT_BYTES) break;
    if (other === key) continue;
    cache.delete(other);
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
  /** The site the stored credential is for; null when disconnected. */
  site: () => string | null;
}

export interface JiraMediaReply {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

const TEXT = (s: string) => new TextEncoder().encode(s);

/**
 * Errors carry the same discipline as the success path. The bodies are
 * fixed ASCII, so nothing here is exploitable — but a response from this
 * handler should never be the one that forgot.
 */
const ERROR_HEADERS: Record<string, string> = {
  'Content-Type': 'text/plain; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'X-Content-Type-Options': 'nosniff',
};

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
  if (!id)
    return { status: 404, headers: ERROR_HEADERS, body: TEXT('Not found') };

  const site = deps.site();
  // No credential means nothing to serve and nothing to key a cache entry
  // by — refuse rather than fall back to an unkeyed lookup.
  if (!site)
    return { status: 502, headers: ERROR_HEADERS, body: TEXT('Unavailable') };

  const key = cacheKey(site, id);
  let entry = cache.get(key);
  if (!entry) {
    const result = await deps.download(id);
    if (!result.ok) {
      // Deliberately bare: a Jira failure reason can name the site or the
      // account, and this response is readable by page script.
      return { status: 502, headers: ERROR_HEADERS, body: TEXT('Unavailable') };
    }
    const meta = await deps.meta(id);
    entry = {
      bytes: result.value.bytes,
      // A metadata read that fails is not worth failing the whole request
      // over — an octet-stream still downloads, it just will not preview.
      mimeType: meta.ok ? meta.value.mimeType : 'application/octet-stream',
    };
    remember(key, entry.bytes, entry.mimeType);
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
        site: () => readStoredJiraCredential()?.site ?? null,
      },
    );
    // The view itself, not `.buffer`: handing over the backing buffer
    // discards byteOffset/byteLength, so the day any producer here returns
    // a subarray instead of an exact-size copy it would silently serve the
    // wrong bytes. The DOM lib in this project types BodyInit without
    // Uint8Array; the runtime accepts it.
    return new Response(reply.body as unknown as BodyInit, {
      status: reply.status,
      headers: reply.headers,
    });
  });
}
