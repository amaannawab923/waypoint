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
/**
 * Above this, an attachment is never held whole: it is served as ranges
 * straight from Jira.
 *
 * Screenshots sit far below it and keep the cached path, which is what
 * makes a strip of thumbnails cheap. A screen recording sits far above it,
 * and buffering one was the reason a 79 MB clip took over twelve seconds
 * to show its first frame (measured on ENG-114): every seek, and the
 * initial load, was backed by a full download.
 */
const STREAM_ABOVE_BYTES = 8 * 1024 * 1024;

/**
 * The most bytes answered for one ranged request.
 *
 * A media element opens with an open-ended `bytes=0-`, which means "the
 * rest of the file". Answering that literally is the full download again,
 * so it is capped: a 206 may return fewer bytes than asked for, and the
 * player simply asks for the next span. Two seconds of 1080p is around
 * this size, so playback starts on the first chunk.
 */
const RANGE_CHUNK_BYTES = 2 * 1024 * 1024;

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

export function jiraThumbnailUrl(attachmentId: string): string {
  return `${JIRA_MEDIA_SCHEME}://thumbnail/${encodeURIComponent(attachmentId)}`;
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
  return parseMediaUrl(url)?.id ?? null;
}

/** What a media URL names: the attachment itself, or Jira's poster for it. */
export type JiraMediaVariant = 'attachment' | 'thumbnail';

/**
 * The variant and id out of a media URL, or null when the URL is not one
 * this should answer.
 *
 * The HOST carries the variant — `//attachment/<id>` against
 * `//thumbnail/<id>` — and is now checked rather than ignored, so a URL
 * naming neither is refused instead of being treated as a full download.
 */
export function parseMediaUrl(
  url: string,
): { variant: JiraMediaVariant; id: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${JIRA_MEDIA_SCHEME}:`) return null;
  const variant = parsed.host;
  if (variant !== 'attachment' && variant !== 'thumbnail') return null;
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length !== 1) return null;
  const id = decodeURIComponent(segments[0]);
  return ATTACHMENT_ID.test(id) ? { variant, id } : null;
}

export interface JiraMediaDeps {
  download: (
    id: string,
  ) => Promise<
    { ok: true; value: { bytes: Buffer; site: string } } | { ok: false }
  >;
  /**
   * One byte range, fetched AS a range from Jira rather than sliced out of
   * a full download. What makes a large video usable.
   */
  downloadRange: (
    id: string,
    range: { start: number; end: number },
  ) => Promise<
    | {
        ok: true;
        value: {
          bytes: Buffer;
          site: string;
          partial: boolean;
          totalSize: number | null;
        };
      }
    | { ok: false }
  >;
  /** The attachment's own mimeType and size, read from Jira — never from the renderer. */
  meta: (
    id: string,
  ) => Promise<
    { ok: true; value: { mimeType: string; size: number } } | { ok: false }
  >;
  /**
   * Jira's own poster for the attachment — a frame from a video, or a
   * scaled-down copy of an image. A couple of kilobytes either way.
   */
  thumbnail: (
    id: string,
  ) => Promise<
    | { ok: true; value: { bytes: Buffer; site: string; mimeType: string } }
    | { ok: false }
  >;
  /**
   * The site the stored credential is for; null when disconnected.
   *
   * Used ONLY to answer a cache lookup and to refuse when disconnected.
   * What a cache entry is WRITTEN under comes back from `download`
   * instead — see the comment where `remember` is called.
   */
  site: () => string | null;
}

export interface JiraMediaReply {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  /**
   * When set, the adapter sends a STREAMED body pulled from Jira in
   * chunks instead of `body`.
   *
   * This is the plain-GET case on a large attachment, and it is the one
   * that actually matters for video: a media element's first request
   * carries no Range, and a 206 is not a legal answer to it. Buffering
   * the whole entity to answer 200 is what made a 79 MB recording take
   * over nine seconds before its first frame (measured, ENG-114).
   * Streaming lets Chromium start decoding on the first chunk while the
   * rest is still arriving, and it never holds the file in main.
   */
  stream?: { id: string; site: string; from: number; through: number };
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
  const parsed = parseMediaUrl(request.url);
  if (!parsed)
    return { status: 404, headers: ERROR_HEADERS, body: TEXT('Not found') };
  const { id, variant } = parsed;

  const site = deps.site();
  // No credential means nothing to serve and nothing to key a cache entry
  // by — refuse rather than fall back to an unkeyed lookup.
  if (!site)
    return { status: 502, headers: ERROR_HEADERS, body: TEXT('Unavailable') };

  const key = variant === 'thumbnail' ? `thumb:${id}` : id;
  const cached = cache.get(cacheKey(site, key));
  if (cached) return fromBytes(cached, request.range ?? null);

  if (variant === 'thumbnail') {
    const poster = await deps.thumbnail(id);
    if (!poster.ok || poster.value.site !== site)
      return { status: 502, headers: ERROR_HEADERS, body: TEXT('Unavailable') };
    const entry = {
      bytes: poster.value.bytes,
      mimeType: poster.value.mimeType,
    };
    remember(cacheKey(poster.value.site, key), entry.bytes, entry.mimeType);
    return fromBytes(entry, request.range ?? null);
  }

  // The size decides the strategy, so it is read before any bytes move.
  // This is the same call that supplies the Content-Type, so it costs
  // nothing extra.
  const meta = await deps.meta(id);
  const mimeType = meta.ok ? meta.value.mimeType : 'application/octet-stream';
  const size = meta.ok ? meta.value.size : 0;

  if (size > STREAM_ABOVE_BYTES) {
    return serveRanged(id, site, mimeType, size, request.range ?? null, deps);
  }

  const result = await deps.download(id);
  if (!result.ok) {
    // Deliberately bare: a Jira failure reason can name the site or the
    // account, and this response is readable by page script.
    return { status: 502, headers: ERROR_HEADERS, body: TEXT('Unavailable') };
  }
  const entry = { bytes: result.value.bytes, mimeType };
  // Filed under the site `download` AUTHENTICATED AS, not the one read at
  // the top of this function: those awaits are real network calls and the
  // connect/disconnect IPC handlers run on the same loop, so an account
  // switch mid-fetch would otherwise file the new account's bytes under
  // the old account's key.
  remember(cacheKey(result.value.site, id), entry.bytes, entry.mimeType);
  if (result.value.site !== site) {
    return { status: 502, headers: ERROR_HEADERS, body: TEXT('Unavailable') };
  }
  return fromBytes(entry, request.range ?? null);
}

/** A reply built out of bytes already held whole. */
function fromBytes(
  entry: { bytes: Buffer; mimeType: string },
  rangeHeader: string | null,
): JiraMediaReply {
  const size = entry.bytes.byteLength;
  const headers = mediaHeaders(entry.mimeType);
  const range = parseRange(rangeHeader, size);
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

/**
 * A large attachment, answered as a range straight from Jira.
 *
 * Never cached: one of these is bigger than the whole cache budget is
 * meant to hold, and the point of the exercise is not to have the file in
 * memory at all.
 */
async function serveRanged(
  id: string,
  site: string,
  mimeType: string,
  size: number,
  rangeHeader: string | null,
  deps: JiraMediaDeps,
): Promise<JiraMediaReply> {
  // A 206 is only a legal answer to a request that ASKED for a range.
  // Answering one to a plain GET misdescribes the body, and Chromium
  // rejects the media outright — which is exactly how this first went
  // wrong. A plain GET gets the whole entity, slowly and correctly; in
  // practice a media element asks with `bytes=0-` and never takes this
  // path.
  const asked = parseRange(rangeHeader, size);
  if (!asked) {
    // No Range: the entity, entire — a 206 would misdescribe the body and
    // Chromium rejects the media outright. Streamed rather than buffered,
    // so the player can start on the first chunk.
    return {
      status: 200,
      headers: { ...mediaHeaders(mimeType), 'Content-Length': String(size) },
      body: new Uint8Array(0),
      stream: { id, site, from: 0, through: size - 1 },
    };
  }
  // Capped: `bytes=0-` means "the rest of the file", and answering that
  // literally is the full download this exists to avoid. Returning fewer
  // bytes than asked for is allowed, and the player asks for the next span.
  const end = Math.min(asked.end, asked.start + RANGE_CHUNK_BYTES - 1);

  const result = await deps.downloadRange(id, { start: asked.start, end });
  if (!result.ok)
    return { status: 502, headers: ERROR_HEADERS, body: TEXT('Unavailable') };
  if (result.value.site !== site)
    return { status: 502, headers: ERROR_HEADERS, body: TEXT('Unavailable') };

  const bytes = result.value.bytes;
  const total = result.value.totalSize ?? size;
  const headers = mediaHeaders(mimeType);

  // A server that ignored the Range sent the whole entity. Saying 206 over
  // that would misdescribe the body, so it is reported as what it is.
  if (!result.value.partial) {
    return {
      status: 200,
      headers: { ...headers, 'Content-Length': String(bytes.byteLength) },
      body: new Uint8Array(bytes),
    };
  }

  const servedEnd = asked.start + bytes.byteLength - 1;
  return {
    status: 206,
    headers: {
      ...headers,
      'Content-Range': `bytes ${asked.start}-${servedEnd}/${total}`,
      'Content-Length': String(bytes.byteLength),
    },
    body: new Uint8Array(bytes),
  };
}

function mediaHeaders(mimeType: string): Record<string, string> {
  return {
    'Content-Type': mimeType,
    // Seeking in <video> needs the browser to know ranges are available.
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
  };
}

/**
 * Sequential ranged reads over one attachment, as an async iterable.
 *
 * Each pull is one `downloadRange`, so main never holds more than a chunk
 * of the file. A read that fails, or that comes back from a different
 * account than the one the response was opened for, ends the stream —
 * a truncated video is a visible failure, where continuing would splice
 * two accounts' bytes into one file.
 */
export async function* readAttachmentRanges(
  deps: JiraMediaDeps,
  plan: { id: string; site: string; from: number; through: number },
): AsyncGenerator<Uint8Array> {
  let at = plan.from;
  while (at <= plan.through) {
    const end = Math.min(plan.through, at + RANGE_CHUNK_BYTES - 1);
    const result = await deps.downloadRange(plan.id, { start: at, end });
    if (!result.ok || result.value.site !== plan.site) return;
    const bytes = result.value.bytes;
    if (bytes.byteLength === 0) return; // no progress: stop rather than spin
    yield new Uint8Array(bytes);
    at += bytes.byteLength;
  }
}

export function registerJiraMediaProtocol(): void {
  const handlerDeps: JiraMediaDeps = {
    download: (id) => client.downloadAttachment(id),
    downloadRange: (id, range) => client.downloadAttachmentRange(id, range),
    meta: (id) => client.getAttachmentMeta(id),
    thumbnail: (id) => client.downloadAttachmentThumbnail(id),
    site: () => readStoredJiraCredential()?.site ?? null,
  };
  protocol.handle(JIRA_MEDIA_SCHEME, async (request) => {
    const reply = await serveJiraMedia(
      { url: request.url, range: request.headers.get('range') },
      handlerDeps,
    );
    if (reply.stream) {
      const plan = reply.stream;
      const chunks = readAttachmentRanges(handlerDeps, plan);
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = await chunks.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel() {
          // The player seeked or the viewer closed: stop fetching.
          void chunks.return(undefined);
        },
      });
      return new Response(body as unknown as BodyInit, {
        status: reply.status,
        headers: reply.headers,
      });
    }
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
