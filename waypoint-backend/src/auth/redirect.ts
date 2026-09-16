import { ValidationError } from '../middleware/errors.js';

// AT9 (ROAD-144). The pure half of the sign-in flow: what a redirect may
// be, what a client state may be, where this backend lives, and HTML
// escaping. Kept free of any db import so the unit tests — and the
// backend-unit CI job, which has no database — can load it.

export function publicBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.PUBLIC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  return `http://localhost:${env.PORT ?? 14000}`;
}

// AT13 (ROAD-148) round-3 review. What app.ts's CORS allowlist actually
// needs from publicBaseUrl() — an Origin, not a base URL — and both
// loopback spellings of it, not just the one this env happens to be
// configured with.
//
// An Origin header carries scheme+host+port only: no path, and the
// browser omits the port when it's the scheme's default (80/443).
// publicBaseUrl() itself has to keep returning a full base URL (a real
// deployment behind a path-routed reverse proxy legitimately sets
// PUBLIC_BASE_URL with a path prefix, and every OAuth callback URL is
// built by joining a path onto it) — so this derives the Origin
// separately via URL's own `.origin`, rather than changing what
// publicBaseUrl() itself returns.
//
// The loopback-spelling half: this backend's own default is
// `http://localhost:<PORT>`, but docker-compose.yml's own published
// address and docs/operations/self-hosted-setup.md's own walkthrough
// both use the 127.0.0.1 literal — an operator pointing their desktop's
// WAYPOINT_API_BASE_URL at "the loopback backend" via either spelling is
// describing the same backend, but a browser treats http://localhost:X
// and http://127.0.0.1:X (and http://[::1]:X) as different Origins. All
// three are trusted here specifically for loopback, since nothing about
// the actual security boundary (a real sign-in through this same
// backend) depends on which spelling reached it.
const LOOPBACK_HOSTNAME_SIBLINGS: Record<string, string[]> = {
  localhost: ['127.0.0.1', '[::1]'],
  '127.0.0.1': ['localhost', '[::1]'],
  '[::1]': ['localhost', '127.0.0.1'],
};

export function corsOriginsForBackend(publicBaseUrlValue: string): string[] {
  // Empty, not [publicBaseUrlValue], on both rejection paths below.
  // Round-5 review: an earlier version returned the raw string here,
  // reasoning that a non-origin string could never match a real Origin
  // header — true for almost every string, but not for the one that
  // matters: `new URL('null')` throws (falls into the catch below), and
  // "null" is exactly the literal Origin header value a browser sends
  // for a genuinely opaque origin (a sandboxed iframe, a data:
  // document). A misconfigured PUBLIC_BASE_URL=null (a config layer
  // rendering an unset value as the string "null" — a template
  // interpolating a JSON/YAML null, a stray env default) would have
  // allowlisted exactly that. A raw string can never legitimately equal
  // a real Origin anyway (an Origin is only ever scheme://host[:port]
  // or the literal "null"), and an unparseable/non-http(s)
  // PUBLIC_BASE_URL already breaks every OAuth callback URL built from
  // it — there's no deployment this fallback ever helped.
  let u: URL;
  try {
    u = new URL(publicBaseUrlValue);
  } catch {
    return [];
  }
  // WHATWG URL gives a "null" string for `.origin` on any non-special
  // scheme too (round-4 review, live-verified: a schemeless value like
  // "localhost:14000" parses fine — the part before the first colon just
  // becomes the scheme — and produces exactly this).
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return [];
  const origins = [u.origin];
  const siblings = LOOPBACK_HOSTNAME_SIBLINGS[u.hostname];
  if (siblings) {
    for (const sibling of siblings) origins.push(`${u.protocol}//${sibling}${u.port ? `:${u.port}` : ''}`);
  }
  return origins;
}

// The desktop's callback must be a loopback URL: that is the whole reason
// the raw token can travel on a redirect — it never leaves the machine
// the person is sitting at. Anything else is an open redirect that would
// hand a session to whoever supplied the URI.
export function validateRedirectUri(raw: string | undefined): string {
  if (!raw) throw new ValidationError('redirect_uri is required');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ValidationError('redirect_uri must be an absolute URL');
  }
  // The IP literal only, per RFC 8252 §8.3: `localhost` is a name, and a
  // name is whatever the resolver (or a hosts file) says it is. The
  // desktop (AT10) binds 127.0.0.1 and asks for exactly this.
  const loopback = u.protocol === 'http:' && u.hostname === '127.0.0.1';
  if (!loopback || u.pathname !== '/callback' || u.search || u.hash || u.username || u.password) {
    throw new ValidationError('redirect_uri must be http://127.0.0.1:<port>/callback');
  }
  return u.toString();
}

export function validateClientState(raw: string | undefined): string {
  if (!raw || raw.length < 8 || raw.length > 256) throw new ValidationError('state is required (8–256 characters)');
  return raw;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
