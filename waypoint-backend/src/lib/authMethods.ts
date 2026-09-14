// AT8 (ROAD-143). Which sign-in methods this instance can actually offer,
// computed from what the operator configured — never from a setting in
// the database, because a method with no credentials behind it isn't a
// choice, it's a broken button. A self-hoster sets any subset of these in
// docker-compose.yml (spec §8); cloud sets all three with our own keys.
// AT9 (sign-in) reads the same function so the wizard, the sign-in card,
// and the OAuth exchange can never disagree about what exists.
//
// Read from an explicit env object rather than process.env directly so
// tests can pass a fixture and so the boundary is obvious: this is the
// only place these variable names are spelled.

export type AuthMethod = 'github' | 'google' | 'email';

export const AUTH_METHOD_ENV = {
  github: ['GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_SECRET'],
  google: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
  // SMTP_PORT/SMTP_USER/SMTP_PASS are optional (a local relay needs none
  // of them); host and a from-address are the minimum that can send.
  email: ['SMTP_HOST', 'SMTP_FROM'],
} as const satisfies Record<AuthMethod, readonly string[]>;

const ORDER: readonly AuthMethod[] = ['github', 'google', 'email'];

function isSet(env: NodeJS.ProcessEnv, key: string): boolean {
  // `||`-style: an empty string in .env is "unset", same reading app.ts
  // gives CORS_ORIGIN.
  return typeof env[key] === 'string' && env[key]!.trim() !== '';
}

export function configuredAuthMethods(env: NodeJS.ProcessEnv = process.env): AuthMethod[] {
  return ORDER.filter((method) => AUTH_METHOD_ENV[method].every((key) => isSet(env, key)));
}
