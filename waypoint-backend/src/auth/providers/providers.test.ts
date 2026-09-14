import { describe, it, expect } from 'vitest';
import { githubProvider } from './github.js';
import { googleProvider } from './google.js';
import type { FetchLike } from './types.js';

// AT9 (ROAD-144): the exchange logic with recorded provider shapes. No
// network — each test hands the provider a fetch that answers from a map.
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: string) => {
    calls.push(input);
    const hit = Object.entries(routes).find(([k]) => input.startsWith(k));
    if (!hit) return new Response('not found', { status: 404 });
    const { status = 200, body } = hit[1];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as FetchLike & { calls: string[] };
  f.calls = calls;
  return f;
}

const ARGS = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'http://localhost:14000/auth/x/callback', code: 'the-code' };

describe('github provider', () => {
  it('builds an authorize URL with the registered redirect and state', () => {
    const u = new URL(githubProvider.authorizeUrl({ clientId: 'cid', redirectUri: ARGS.redirectUri, state: 's3cret' }));
    expect(u.origin + u.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('redirect_uri')).toBe(ARGS.redirectUri);
    expect(u.searchParams.get('state')).toBe('s3cret');
    expect(u.searchParams.get('scope')).toContain('user:email');
  });

  it('prefers the primary verified email over the profile email', async () => {
    const f = fakeFetch({
      'https://github.com/login/oauth/access_token': { body: { access_token: 'tok' } },
      'https://api.github.com/user/emails': {
        body: [
          { email: 'old@example.test', primary: false, verified: true },
          { email: 'me@example.test', primary: true, verified: true },
        ],
      },
      'https://api.github.com/user': { body: { id: 42, login: 'amaan', name: 'Amaan N', email: null, avatar_url: 'https://a/b.png' } },
    });
    const id = await githubProvider.exchange(ARGS, f);
    expect(id).toEqual({
      provider: 'github',
      providerId: '42',
      email: 'me@example.test',
      emailVerified: true,
      fullName: 'Amaan N',
      avatarUrl: 'https://a/b.png',
    });
  });

  it('falls back to the login as the name and reports unverified when only the profile email exists', async () => {
    const f = fakeFetch({
      'https://github.com/login/oauth/access_token': { body: { access_token: 'tok' } },
      'https://api.github.com/user/emails': { status: 403, body: {} },
      'https://api.github.com/user': { body: { id: 7, login: 'jordan', name: '  ', email: 'j@example.test', avatar_url: null } },
    });
    const id = await githubProvider.exchange(ARGS, f);
    expect(id).toMatchObject({ providerId: '7', email: 'j@example.test', emailVerified: false, fullName: 'jordan' });
  });

  it('fails clearly when the code exchange is rejected', async () => {
    const f = fakeFetch({
      'https://github.com/login/oauth/access_token': { body: { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' } },
    });
    await expect(githubProvider.exchange(ARGS, f)).rejects.toMatchObject({ name: 'ProviderExchangeError', message: /incorrect or expired/ });
  });

  it('refuses an account with no email at all', async () => {
    const f = fakeFetch({
      'https://github.com/login/oauth/access_token': { body: { access_token: 'tok' } },
      'https://api.github.com/user/emails': { body: [] },
      'https://api.github.com/user': { body: { id: 1, login: 'x', name: null, email: null, avatar_url: null } },
    });
    await expect(githubProvider.exchange(ARGS, f)).rejects.toThrow(/no email/);
  });
});

describe('google provider', () => {
  it('sends the code exchange as a form body and reads sub/email_verified', async () => {
    let tokenInit: RequestInit | undefined;
    const f = (async (input: string, init?: RequestInit) => {
      if (input.startsWith('https://oauth2.googleapis.com/token')) {
        tokenInit = init;
        return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
      }
      return new Response(JSON.stringify({ sub: '110', email: 'Me@Example.test', email_verified: true, name: 'Me', picture: 'p' }), { status: 200 });
    }) as FetchLike;
    const id = await googleProvider.exchange(ARGS, f);
    expect(String(tokenInit?.body)).toContain('grant_type=authorization_code');
    expect(String(tokenInit?.body)).toContain('code=the-code');
    expect(id).toMatchObject({ provider: 'google', providerId: '110', email: 'Me@Example.test', emailVerified: true, fullName: 'Me', avatarUrl: 'p' });
  });

  it('treats a missing email_verified as unverified', async () => {
    const f = (async (input: string) =>
      input.includes('/token')
        ? new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })
        : new Response(JSON.stringify({ sub: '1', email: 'a@b.test' }), { status: 200 })) as FetchLike;
    expect((await googleProvider.exchange(ARGS, f)).emailVerified).toBe(false);
  });
});
