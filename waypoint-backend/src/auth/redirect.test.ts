import { describe, it, expect } from 'vitest';
import { validateRedirectUri, validateClientState, publicBaseUrl } from './redirect.js';

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
