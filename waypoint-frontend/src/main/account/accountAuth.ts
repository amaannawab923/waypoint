import * as fs from 'fs';
import * as path from 'path';
import { app, safeStorage } from 'electron';
import type { AccountCredential, AccountIdentity } from './accountTypes';

// The Team/Sync session-token store. Same shape as jira/jiraAuth.ts's Jira
// credential store and copilotAuth.ts's token store — safeStorage to
// encrypt, a 0o600 file under app.getPath('userData') to hold the
// ciphertext, a hard refusal when safeStorage.isEncryptionAvailable() is
// false rather than a plaintext fallback — but its own dedicated file, for
// the same reason jiraAuth.ts's header gives for keeping Jira and Copilot
// apart: this credential is unrelated to either (an opaque bearer session
// against this app's own backend, not a third party's API), has its own
// lifetime (90 days, AT9's SESSION_TTL_MS), and is cleared independently —
// disconnecting Jira, or signing out of Copilot, must not touch it.
//
// Unlike Jira's credential, this one is genuinely optional at the type
// level everywhere else in main: Personal has to work with this file never
// having existed at all (decision 001 §3 — the first-launch local profile,
// ROAD-149, lives entirely in the app's own local database, not here).
// This file only ever holds something once a person has actually signed
// in — at the invite click or Settings → Devices & Sync.

const CREDENTIAL_FILE_NAME = 'account-auth.json';

function credentialFilePath(): string {
  return path.join(app.getPath('userData'), CREDENTIAL_FILE_NAME);
}

/** Mirrors jiraAuth.ts's isJiraSecureStorageAvailable(): without OS-level
 * encryption there is no safe place to put a session token, and writing it
 * in the clear is not an acceptable fallback. */
export function isAccountSecureStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The stored credential, or null if there isn't one (or it can't be read).
 * Every failure mode — no file, malformed JSON, encryption unavailable, a
 * blob that decrypts to something that isn't a credential — collapses to
 * null: callers treat "no usable credential" as "not connected to a Team",
 * same discipline as jiraAuth.ts's readStoredJiraCredential.
 */
export function readStoredAccountCredential(): AccountCredential | null {
  try {
    const raw = fs.readFileSync(credentialFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as { encrypted?: string };
    if (!parsed.encrypted) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    const decrypted = JSON.parse(
      safeStorage.decryptString(Buffer.from(parsed.encrypted, 'base64')),
    ) as Partial<AccountCredential>;
    if (
      !isNonEmptyString(decrypted.backendUrl) ||
      !isNonEmptyString(decrypted.token) ||
      !isNonEmptyString(decrypted.email)
    ) {
      return null;
    }
    return {
      backendUrl: decrypted.backendUrl,
      token: decrypted.token,
      email: decrypted.email,
      fullName: isNonEmptyString(decrypted.fullName) ? decrypted.fullName : decrypted.email,
      avatarUrl: isNonEmptyString(decrypted.avatarUrl) ? decrypted.avatarUrl : null,
      // AT12: absent on a credential written before this field existed —
      // same "missing means null" reading as avatarUrl above.
      activeWorkspaceId: isNonEmptyString(decrypted.activeWorkspaceId) ? decrypted.activeWorkspaceId : null,
    };
  } catch {
    return null;
  }
}

/** AT12 (ROAD-147). Re-encrypts the whole credential with a patched
 * activeWorkspaceId — there's no partial-write primitive for a
 * safeStorage-sealed file, so this reads, patches the one field, and
 * writes the whole thing back through writeStoredAccountCredential.
 * Returns false (not signed in — switching workspaces without an account
 * makes no sense) or throws (the same locked-keychain/full-disk failure
 * writeStoredAccountCredential itself documents; callers, e.g.
 * accountIpc.ts's account:signIn handler already does for the same
 * throw, catch it and report storage_unavailable rather than letting an
 * IPC invoke hang unsettled). */
export function setStoredActiveWorkspaceId(workspaceId: string | null): boolean {
  const existing = readStoredAccountCredential();
  if (!existing) return false;
  writeStoredAccountCredential({ ...existing, activeWorkspaceId: workspaceId });
  return true;
}

/** Throws on a locked keychain or a full disk — callers are expected to
 * catch and report (see accountIpc.ts's signIn handler), not to let the
 * failure escape as an unsettled IPC invoke. */
export function writeStoredAccountCredential(credential: AccountCredential): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is unavailable on this device, so the session cannot be saved.');
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(credential)).toString('base64');
  const filePath = credentialFilePath();
  fs.writeFileSync(filePath, JSON.stringify({ encrypted }), { mode: 0o600 });
  // Same reasoning as jiraAuth.ts's writeStoredJiraCredential: `mode` in
  // writeFileSync only applies on create, so a file left at a wider mode
  // by an earlier build or a restored backup would otherwise stay that way
  // forever. chmod every time makes the 0o600 promise true on rewrite too.
  fs.chmodSync(filePath, 0o600);
}

export function deleteStoredAccountCredential(): void {
  try {
    fs.unlinkSync(credentialFilePath());
  } catch {
    // Already gone — signing out twice is a no-op, not an error.
  }
}

/** The renderer-safe projection. This is the ONLY shape that ever crosses
 * IPC: the credential minus `token`, kept in one named function so "the
 * token never leaves the main process" is checkable rather than a
 * convention — the exact boundary jiraAuth.ts's toJiraIdentity() draws. */
export function toAccountIdentity(credential: AccountCredential): AccountIdentity {
  return {
    backendUrl: credential.backendUrl,
    email: credential.email,
    fullName: credential.fullName,
    avatarUrl: credential.avatarUrl,
    activeWorkspaceId: credential.activeWorkspaceId,
  };
}

/** The Bearer header value for a request scoped to a Team workspace or
 * Sync, or null when nothing is connected. Named beside the credential it
 * reads, same reasoning as jiraAuth.ts's encodeJiraCredentialHeader: a
 * name and an encoding must not drift apart from each other. */
export function accountAuthorizationHeader(credential: AccountCredential | null): string | null {
  if (!credential) return null;
  return `Bearer ${credential.token}`;
}
