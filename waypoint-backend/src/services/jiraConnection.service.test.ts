import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { normalizeSite } = await import('./jiraConnection.service.js');

// normalizeSite is the control that decides where an authenticated request —
// one carrying the API token in an Authorization header — actually goes. Its
// failure mode is not a bad UX message, it is sending the token to a host the
// user did not name, so the rejection cases below matter more than the
// acceptance ones.
describe('normalizeSite', () => {
  it('accepts a bare Jira Cloud hostname', () => {
    expect(normalizeSite('yourteam.atlassian.net')).toBe('yourteam.atlassian.net');
  });

  it('accepts and strips a scheme, trailing slash, and surrounding whitespace', () => {
    expect(normalizeSite('  https://yourteam.atlassian.net/  ')).toBe('yourteam.atlassian.net');
    expect(normalizeSite('http://yourteam.atlassian.net')).toBe('yourteam.atlassian.net');
  });

  it('lowercases the hostname', () => {
    expect(normalizeSite('YourTeam.Atlassian.NET')).toBe('yourteam.atlassian.net');
  });

  it('keeps only the host from a value carrying a path or query', () => {
    expect(normalizeSite('https://yourteam.atlassian.net/jira/software')).toBe('yourteam.atlassian.net');
    expect(normalizeSite('yourteam.atlassian.net/x?y=1')).toBe('yourteam.atlassian.net');
  });

  it('resolves a userinfo prefix to the host actually contacted, and rejects it', () => {
    // "good.atlassian.net@evil.com" reads as the good host to a person and
    // means evil.com to a URL parser. Rejecting outright (rather than quietly
    // accepting evil.com) is what stops a value whose obvious reading is not
    // what would happen.
    expect(normalizeSite('https://good.atlassian.net@evil.com')).toBeNull();
    expect(normalizeSite('good.atlassian.net:token@evil.com')).toBeNull();
  });

  it('resolves a fragment-disguised host to the real one', () => {
    // "evil.com#good.atlassian.net" contacts evil.com. It is a syntactically
    // fine hostname, so it normalizes rather than being rejected — the point
    // of the test is that what gets STORED is the host requests would really
    // go to, so the value shown back to the user cannot lie about it.
    expect(normalizeSite('https://evil.com#good.atlassian.net')).toBe('evil.com');
  });

  it('rejects non-http schemes', () => {
    expect(normalizeSite('javascript:alert(1)')).toBeNull();
    expect(normalizeSite('file:///etc/passwd')).toBeNull();
  });

  it('rejects single-label hosts and IP literals', () => {
    // Jira Cloud sites are always dotted names. Refusing the rest keeps the
    // token off localhost and off anything on the internal network.
    expect(normalizeSite('localhost')).toBeNull();
    expect(normalizeSite('http://127.0.0.1:14000')).toBeNull();
    expect(normalizeSite('http://[::1]')).toBeNull();
  });

  it('rejects empty and whitespace-only input', () => {
    expect(normalizeSite('')).toBeNull();
    expect(normalizeSite('   ')).toBeNull();
  });
});
