import { describe, it, expect } from 'vitest';
import {
  JIRA_CREDENTIAL_HEADER,
  normalizeSite,
  parseJiraCredentialHeader,
} from './credentialHeader.js';

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

const CREDENTIAL = {
  site: 'yourteam.atlassian.net',
  email: 'me@example.com',
  apiToken: 'jira-token',
};

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
    // of the test is that what gets USED is the host requests would really go
    // to, so no stored or displayed value can lie about it.
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

describe('parseJiraCredentialHeader', () => {
  it('reads back exactly what the desktop app encodes', () => {
    expect(parseJiraCredentialHeader(encode(CREDENTIAL))).toEqual(CREDENTIAL);
  });

  it('normalizes the site rather than trusting it', () => {
    // The header is not a trusted channel just because the desktop app is the
    // only intended sender: this endpoint is reachable by anything on
    // localhost, so the SSRF control has to run on the way in.
    expect(
      parseJiraCredentialHeader(encode({ ...CREDENTIAL, site: 'https://YourTeam.Atlassian.NET/x' })),
    ).toEqual(CREDENTIAL);
  });

  it('rejects a site that would retarget the token, rather than sending it there', () => {
    for (const site of [
      'good.atlassian.net@evil.com',
      'http://127.0.0.1:14000',
      'localhost',
      'file:///etc/passwd',
    ]) {
      expect(parseJiraCredentialHeader(encode({ ...CREDENTIAL, site }))).toBeNull();
    }
  });

  it('keeps only the three fields it needs, never anything else the header carried', () => {
    const parsed = parseJiraCredentialHeader(
      encode({ ...CREDENTIAL, accountId: 'acc-1', extra: { nested: true } }),
    );
    expect(parsed).toEqual(CREDENTIAL);
    expect(Object.keys(parsed ?? {}).sort()).toEqual(['apiToken', 'email', 'site']);
  });

  // Every one of these is the SAME outcome as no header at all — "Jira is not
  // connected" — which is a state the read tools already handle, so there is
  // nothing here that needs to become an error.
  it('treats an absent header as not connected', () => {
    expect(parseJiraCredentialHeader(undefined)).toBeNull();
    expect(parseJiraCredentialHeader('')).toBeNull();
  });

  it('treats malformed encodings as not connected instead of throwing', () => {
    expect(parseJiraCredentialHeader('not base64 at all!!')).toBeNull();
    expect(parseJiraCredentialHeader(Buffer.from('not json').toString('base64'))).toBeNull();
    expect(parseJiraCredentialHeader(encode('a string, not an object'))).toBeNull();
    expect(parseJiraCredentialHeader(encode(null))).toBeNull();
    expect(parseJiraCredentialHeader(encode([CREDENTIAL]))).toBeNull();
  });

  it('treats a partial credential as not connected — half a credential authenticates nothing', () => {
    expect(parseJiraCredentialHeader(encode({ site: CREDENTIAL.site }))).toBeNull();
    expect(parseJiraCredentialHeader(encode({ ...CREDENTIAL, apiToken: '' }))).toBeNull();
    expect(parseJiraCredentialHeader(encode({ ...CREDENTIAL, email: 42 }))).toBeNull();
  });

  it('refuses to decode an oversized header before allocating it', () => {
    const oversized = encode({ ...CREDENTIAL, apiToken: 'x'.repeat(8192) });
    expect(oversized.length).toBeGreaterThan(4096);
    expect(parseJiraCredentialHeader(oversized)).toBeNull();
  });

  it('names the header the desktop app actually sends', () => {
    // The two projects share no package, so this constant and
    // sessionPolicy.ts's are kept in step by nothing but this assertion and
    // mcp.routes.test.ts's end-to-end one.
    expect(JIRA_CREDENTIAL_HEADER).toBe('x-waypoint-jira-credential');
  });
});
