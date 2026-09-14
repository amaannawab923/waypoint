import { createHash, randomBytes } from 'node:crypto';

// AT9 (ROAD-144). The one way secrets are minted and recognised here —
// session tokens, OAuth state, magic-link tokens. The raw value goes to
// exactly one party (browser, provider, or the desktop) and only its
// SHA-256 is ever stored, so a database read never yields a usable
// credential. Same discipline jiraAuth.ts applies to a different secret.

export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashSecret(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
