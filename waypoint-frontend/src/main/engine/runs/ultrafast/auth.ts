import * as fs from 'fs';
import * as path from 'path';
import { app, safeStorage } from 'electron';

// The one secret this feature holds: the founder's TypeSafe API key
// (jev-ultrafast's decision model). Same shape as copilotAuth.ts's
// subscription-token store and accountAuth.ts's credential store —
// safeStorage to encrypt, a 0o600 file under app.getPath('userData'), a
// hard refusal when safeStorage.isEncryptionAvailable() is false rather
// than ever writing the key in the clear. Its own file, not folded into
// either of those: it is unrelated to a Claude subscription or a Team
// session, has its own lifecycle (typed in once from the settings page,
// cleared independently), and this app never needs to read it anywhere
// but the ultrafast MCP server's own registration.

const KEY_FILE_NAME = 'ultrafast-auth.json';

function keyFilePath(): string {
  return path.join(app.getPath('userData'), KEY_FILE_NAME);
}

export function isUltrafastSecureStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

/** The stored key, or null on any failure — no file, malformed JSON,
 *  encryption unavailable, or a blob that fails to decrypt all collapse to
 *  "not configured" rather than throwing, the same discipline
 *  accountAuth.ts's readStoredAccountCredential holds to. */
export function readStoredTypesafeApiKey(): string | null {
  try {
    const raw = fs.readFileSync(keyFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as { encrypted?: string };
    if (!parsed.encrypted) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    const decrypted = safeStorage.decryptString(
      Buffer.from(parsed.encrypted, 'base64'),
    );
    return decrypted.length > 0 ? decrypted : null;
  } catch {
    return null;
  }
}

/** Throws on a locked keychain or a full disk — callers (the IPC handler)
 *  catch and report, matching accountAuth.ts's writeStoredAccountCredential
 *  and copilotAuth.ts's save handler. */
export function writeStoredTypesafeApiKey(key: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "Secure storage isn't available on this device, so the key can't be saved safely here.",
    );
  }
  const encrypted = safeStorage.encryptString(key).toString('base64');
  const filePath = keyFilePath();
  fs.writeFileSync(filePath, JSON.stringify({ encrypted }), { mode: 0o600 });
  // `mode` in writeFileSync only applies on create; chmod on every write so
  // a file left wider by an earlier build stays 0o600 on rewrite too (same
  // reasoning as accountAuth.ts's writeStoredAccountCredential).
  fs.chmodSync(filePath, 0o600);
}

export function deleteStoredTypesafeApiKey(): void {
  try {
    fs.unlinkSync(keyFilePath());
  } catch {
    // Already gone — clearing an already-cleared key is a no-op, not an error.
  }
}

/** The renderer-safe projection: never the key, only whether one is set and
 *  its last four characters, so the settings page can show "configured
 *  (…a1b2)" without the key itself ever crossing IPC. */
export function maskedTail(key: string): string {
  return `…${key.slice(-4)}`;
}

// -----------------------------------------------------------------------
// The .env fallback (founder, 2026-09-22): "keep a .env file where I can
// paste my TypeSafe key." A key saved from the settings page still wins —
// it is encrypted at rest; the .env path is the dev convenience: a
// `TYPESAFE_API_KEY=…` line in waypoint-frontend/.env (gitignored at the
// repo root; `.env.example` carries the empty placeholder), or the same
// variable in the environment the app was launched with. The value is
// read on demand, never cached across a Save/Clear, and never logged.
// -----------------------------------------------------------------------

export type TypesafeKeySource = 'settings' | 'env';

/** The `.env` file the fallback reads: the app root in development (where
 *  package.json is); a packaged app has no such file and reads nothing. */
export function envFilePath(): string {
  return path.join(app.getAppPath(), '.env');
}

/** `KEY=value` lines only — no expansion, no export prefix, no quotes
 *  beyond one matching pair stripped; comments and blanks skipped. Enough
 *  for a pasted key, and nothing more that could surprise. */
export function readDotenvValue(filePath: string, name: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const match = text
    .split(/\r?\n/)
    .map((rawLine) => rawLine.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .find((line) => line.slice(0, line.indexOf('=')).trim() === name);
  if (!match) return null;
  let value = match.slice(match.indexOf('=') + 1).trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  return value.length > 0 ? value : null;
}

/**
 * The key the feature actually runs with, and where it came from:
 * the settings-page secret first, else `TYPESAFE_API_KEY` from the
 * process environment or the app's `.env`. Null when none is set.
 */
export function resolveTypesafeApiKey(): {
  key: string;
  source: TypesafeKeySource;
} | null {
  const stored = readStoredTypesafeApiKey();
  if (stored) return { key: stored, source: 'settings' };
  const fromProcess = process.env.TYPESAFE_API_KEY?.trim();
  if (fromProcess) return { key: fromProcess, source: 'env' };
  const fromFile = readDotenvValue(envFilePath(), 'TYPESAFE_API_KEY');
  if (fromFile) return { key: fromFile, source: 'env' };
  return null;
}
