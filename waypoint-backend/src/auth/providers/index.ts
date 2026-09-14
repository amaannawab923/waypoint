import { githubProvider } from './github.js';
import { googleProvider } from './google.js';
import type { OAuthProvider } from './types.js';

export const oauthProviders: Record<'github' | 'google', OAuthProvider> = {
  github: githubProvider,
  google: googleProvider,
};

export function oauthCredentials(
  provider: 'github' | 'google',
  env: NodeJS.ProcessEnv = process.env,
): { clientId: string; clientSecret: string } | null {
  const [idKey, secretKey] =
    provider === 'github'
      ? ['GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_SECRET']
      : ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'];
  const clientId = env[idKey]?.trim();
  const clientSecret = env[secretKey]?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
