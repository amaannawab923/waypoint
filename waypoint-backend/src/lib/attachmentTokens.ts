import { createHmac, timingSafeEqual } from 'node:crypto';
import { deriveKey } from './secretBox.js';

/**
 * Short-lived signatures that let an attachment's bytes be fetched by a
 * plain browser request.
 *
 * Why this has to exist. An attachment is rendered with `<img src>`, and an
 * `<img>` cannot carry an Authorization header or the
 * X-Waypoint-Workspace-Id that resolveMember reads. In local mode that was
 * invisible — requests carry no identity at all and every read resolves
 * against the single local workspace — but the moment an instance is
 * hosted, every image in every comment would 404, because the only
 * authorization the byte routes had was one no image tag can satisfy.
 *
 * So the server mints a signature per attachment when it hands out the
 * attachment's metadata (a request that IS authenticated, through the
 * normal API path) and embeds it in the URL. The URL then stands on its
 * own for as long as the signature is valid.
 *
 * The tradeoff, stated plainly rather than buried: anyone holding the URL
 * can read that one file until the signature expires, without signing in.
 * That is the same bargain every presigned-URL scheme makes, and it is
 * scoped as tightly as it can be — one attachment id, one expiry, no other
 * capability. It replaces a situation where the image simply did not load,
 * not one where something stricter was working.
 */
const TOKEN_LABEL = 'attachment-url/v1';

/** 24 hours. Long enough that a ticket left open all day still renders its
 *  images, short enough that a URL pasted somewhere it should not be stops
 *  working on its own. Tokens are reminted every time the comments are
 *  fetched, so the practical lifetime of a URL in a live page is a page
 *  load, not a day. */
export const ATTACHMENT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function sign(id: string, expiresAt: number): string {
  return createHmac('sha256', deriveKey(TOKEN_LABEL))
    // The separator matters: without it, (id "a", exp 1123) and (id "a1",
    // exp 123) would sign identical bytes. A character that cannot appear
    // in either field keeps the concatenation unambiguous.
    .update(`${id}\n${expiresAt}`)
    .digest('base64url');
}

/** `<expiryEpochMs>.<signature>` — opaque to the client, which only ever
 *  echoes it back in the query string. */
export function mintAttachmentToken(
  id: string,
  now: number = Date.now(),
): string {
  const expiresAt = now + ATTACHMENT_TOKEN_TTL_MS;
  return `${expiresAt}.${sign(id, expiresAt)}`;
}

/**
 * True only for a signature this server produced, for this exact
 * attachment, that has not expired.
 *
 * Order matters: the signature is checked before the expiry is trusted,
 * because the expiry arrives inside the token and is therefore attacker-
 * supplied until the HMAC says otherwise. Checking "is it still valid?"
 * first would be reading a number the client chose.
 */
export function verifyAttachmentToken(
  id: string,
  token: unknown,
  now: number = Date.now(),
): boolean {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const expiresAt = Number(token.slice(0, dot));
  if (!Number.isSafeInteger(expiresAt)) return false;

  const presented = Buffer.from(token.slice(dot + 1), 'utf8');
  const expected = Buffer.from(sign(id, expiresAt), 'utf8');
  // Length check first: timingSafeEqual throws on a length mismatch, and a
  // differing length is not secret anyway.
  if (presented.length !== expected.length) return false;
  if (!timingSafeEqual(presented, expected)) return false;

  return expiresAt > now;
}
