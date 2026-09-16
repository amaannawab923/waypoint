import { describe, it, expect } from 'vitest';
import { validateRedirectUri, validateClientState, publicBaseUrl, corsOriginsForBackend } from './redirect.js';

// AT9 (ROAD-144): the redirect check is the whole reason a raw token may
// ride on a redirect. redirect.ts is db-free by design — see its header.
describe('validateRedirectUri', () => {
  it('accepts a loopback callback on any port', () => {
    expect(validateRedirectUri('http://127.0.0.1:53127/callback')).toBe('http://127.0.0.1:53127/callback');
    expect(validateRedirectUri('http://127.0.0.1:1/callback')).toBe('http://127.0.0.1:1/callback');
  });

  it.each([
    ['https://127.0.0.1:1/callback', 'https loopback is not what the desktop serves'],
    ['http://localhost:1/callback', 'a name, not the loopback literal (RFC 8252 §8.3)'],
    ['http://[::1]:1/callback', 'IPv6 loopback — the desktop binds v4'],
    ['http://evil.example/callback', 'a real host'],
    ['http://127.0.0.1.evil.example/callback', 'a lookalike host'],
    ['http://127.0.0.1:1/other', 'wrong path'],
    ['http://127.0.0.1:1/callback?x=1', 'a query'],
    ['http://127.0.0.1:1/callback#f', 'a fragment'],
    ['http://u:p@127.0.0.1:1/callback', 'credentials'],
    ['/callback', 'relative'],
    ['', 'empty'],
  ])('rejects %s (%s)', (uri) => {
    expect(() => validateRedirectUri(uri)).toThrow();
  });
});

describe('validateClientState', () => {
  it('requires 8–256 chars', () => {
    expect(validateClientState('abcdefgh')).toBe('abcdefgh');
    expect(() => validateClientState('short')).toThrow();
    expect(() => validateClientState('x'.repeat(257))).toThrow();
    expect(() => validateClientState(undefined)).toThrow();
  });
});

describe('publicBaseUrl', () => {
  it('prefers PUBLIC_BASE_URL, trimmed of trailing slashes, else localhost on PORT', () => {
    expect(publicBaseUrl({ PUBLIC_BASE_URL: 'https://accounts.waypoint.sh/' })).toBe('https://accounts.waypoint.sh');
    expect(publicBaseUrl({ PORT: '14011' })).toBe('http://localhost:14011');
    expect(publicBaseUrl({})).toBe('http://localhost:14000');
  });
});

// AT13 (ROAD-148) rounds 3–4 review: what app.ts's CORS allowlist
// actually needs from publicBaseUrl() is an Origin (scheme+host+port, no
// path, no default port) plus, for loopback specifically, every sibling
// spelling — a desktop pointed at this backend via 127.0.0.1 and one
// pointed via localhost are the same backend to an operator, but
// different Origins to a browser.
describe('corsOriginsForBackend', () => {
  it('returns all three loopback spellings, same port, for any one of them', () => {
    expect(corsOriginsForBackend('http://localhost:14000')).toEqual(['http://localhost:14000', 'http://127.0.0.1:14000', 'http://[::1]:14000']);
    expect(corsOriginsForBackend('http://127.0.0.1:14000')).toEqual(['http://127.0.0.1:14000', 'http://localhost:14000', 'http://[::1]:14000']);
    expect(corsOriginsForBackend('http://[::1]:14000')).toEqual(['http://[::1]:14000', 'http://localhost:14000', 'http://127.0.0.1:14000']);
  });

  it('handles a bare loopback address with no port — the shape the compose docs actually use', () => {
    expect(corsOriginsForBackend('http://127.0.0.1')).toEqual(['http://127.0.0.1', 'http://localhost', 'http://[::1]']);
  });

  it('reduces a base URL to a bare Origin — no path, no default port, lowercased host', () => {
    expect(corsOriginsForBackend('https://Waypoint.example.com/some/path/prefix')).toEqual(['https://waypoint.example.com']);
    expect(corsOriginsForBackend('https://waypoint.example.com:443')).toEqual(['https://waypoint.example.com']);
    expect(corsOriginsForBackend('http://waypoint.example.com:80')).toEqual(['http://waypoint.example.com']);
    // A trailing slash combined with a non-default port — publicBaseUrl()
    // itself always strips a trailing slash before this function ever
    // sees it, but this function is independently exported and tested,
    // so its own "no path" contract gets its own direct case.
    expect(corsOriginsForBackend('http://localhost:14000/')).toEqual(['http://localhost:14000', 'http://127.0.0.1:14000', 'http://[::1]:14000']);
  });

  it('does not add a loopback sibling for a real, non-loopback host', () => {
    expect(corsOriginsForBackend('https://waypoint.example.com')).toEqual(['https://waypoint.example.com']);
  });

  it('falls back to the raw string, rather than throwing, for an unparseable value', () => {
    expect(corsOriginsForBackend('not a url')).toEqual(['not a url']);
  });

  // Round-4 review, the real finding: a schemeless value like
  // "localhost:14000" is NOT unparseable — the part before the first
  // colon becomes the URL's scheme, and WHATWG's `.origin` for any
  // non-http(s) scheme is the literal string "null". That string is
  // also the real Origin header value a browser sends for an opaque
  // origin (a sandboxed iframe, a data: document) — trusting it blindly
  // would allowlist exactly the request class this check exists to
  // block. Every one of these must fall back to the inert raw-string
  // form, the same as a genuinely unparseable value, not to "null".
  it.each([
    ['localhost:14000', 'missing scheme — "localhost:" becomes the protocol, not the host'],
    ['waypoint.example.com:8443', 'same shape with a real-looking hostname'],
    ['app://waypoint', 'a real, non-http(s) scheme'],
    ['file:///srv/waypoint', 'a file: URL'],
  ])('never allowlists the opaque-origin string "null" for %s (%s)', (value) => {
    const result = corsOriginsForBackend(value);
    expect(result).not.toContain('null');
    expect(result).toEqual([value]);
  });
});
