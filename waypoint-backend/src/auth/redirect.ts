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
  const loopback = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
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
