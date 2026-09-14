import { ProviderExchangeError, type OAuthProvider } from './types.js';

// AT9 (ROAD-144). GitHub's OAuth App flow — the same three calls emdash and
// every CLI tool make: authorize → exchange the code → read the profile,
// plus /user/emails because the profile's `email` is null for anyone with
// a private email, which is most developers.

const AUTHORIZE = 'https://github.com/login/oauth/authorize';
const TOKEN = 'https://github.com/login/oauth/access_token';
const API = 'https://api.github.com';

type TokenResponse = { access_token?: string; error?: string; error_description?: string };
type UserResponse = { id: number; login: string; name: string | null; email: string | null; avatar_url: string | null };
type EmailResponse = Array<{ email: string; primary: boolean; verified: boolean }>;

export const githubProvider: OAuthProvider = {
  name: 'github',

  authorizeUrl({ clientId, redirectUri, state }) {
    const u = new URL(AUTHORIZE);
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('scope', 'read:user user:email');
    u.searchParams.set('state', state);
    return u.toString();
  },

  async exchange({ clientId, clientSecret, redirectUri, code }, fetch) {
    const tokenRes = await fetch(TOKEN, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, code }),
    });
    const token = (await tokenRes.json()) as TokenResponse;
    if (!tokenRes.ok || !token.access_token) {
      throw new ProviderExchangeError('github', token.error_description ?? token.error ?? `token exchange failed (${tokenRes.status})`);
    }
    const headers = { Authorization: `Bearer ${token.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'waypoint' };

    const userRes = await fetch(`${API}/user`, { headers });
    if (!userRes.ok) throw new ProviderExchangeError('github', `user lookup failed (${userRes.status})`);
    const user = (await userRes.json()) as UserResponse;

    // Prefer the primary+verified address; fall back to any verified one,
    // then to the profile's public email. No email at all is a hard stop —
    // email is the one thing every users row must have.
    let email = user.email;
    let emailVerified = false;
    const emailsRes = await fetch(`${API}/user/emails`, { headers });
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as EmailResponse;
      const pick = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
      if (pick) {
        email = pick.email;
        emailVerified = true;
      }
    }
    if (!email) throw new ProviderExchangeError('github', 'no email address on the GitHub account');

    return {
      provider: 'github',
      providerId: String(user.id),
      email,
      emailVerified,
      fullName: user.name?.trim() || user.login,
      avatarUrl: user.avatar_url ?? null,
    };
  },
};
