import { ProviderExchangeError, type OAuthProvider } from './types.js';

// AT9 (ROAD-144). Google's OAuth 2.0 / OpenID Connect flow: authorize →
// exchange the code → read the userinfo claims. `sub` is the stable id;
// `email_verified` is Google's own word on the address.

const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

type TokenResponse = { access_token?: string; error?: string; error_description?: string };
type UserInfo = { sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string };

export const googleProvider: OAuthProvider = {
  name: 'google',

  authorizeUrl({ clientId, redirectUri, state }) {
    const u = new URL(AUTHORIZE);
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'openid email profile');
    u.searchParams.set('state', state);
    return u.toString();
  },

  async exchange({ clientId, clientSecret, redirectUri, code }, fetch) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code,
    });
    const tokenRes = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
    const token = (await tokenRes.json()) as TokenResponse;
    if (!tokenRes.ok || !token.access_token) {
      throw new ProviderExchangeError('google', token.error_description ?? token.error ?? `token exchange failed (${tokenRes.status})`);
    }
    const infoRes = await fetch(USERINFO, { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!infoRes.ok) throw new ProviderExchangeError('google', `userinfo failed (${infoRes.status})`);
    const info = (await infoRes.json()) as UserInfo;
    if (!info.email) throw new ProviderExchangeError('google', 'no email address in the Google profile');

    return {
      provider: 'google',
      providerId: info.sub,
      email: info.email,
      emailVerified: info.email_verified === true,
      fullName: info.name?.trim() || info.email,
      avatarUrl: info.picture ?? null,
    };
  },
};
