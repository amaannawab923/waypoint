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
