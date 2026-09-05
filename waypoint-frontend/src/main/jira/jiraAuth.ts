import * as fs from 'fs';
import * as path from 'path';
import { app, safeStorage } from 'electron';
import type { JiraIdentity } from './jiraTypes';

// The Jira Cloud API-token credential store. Same shape as
// copilot/copilotAuth.ts's token store — Electron's safeStorage (OS keychain /
// libsecret / DPAPI) to encrypt, a 0o600 file under app.getPath('userData')
// to hold the ciphertext, and a hard refusal when
// safeStorage.isEncryptionAvailable() is false rather than a plaintext
// fallback — but a deliberately SEPARATE module and a separate file on disk.
// The two credentials are unrelated (one is an Anthropic inference token, the
// other is an Atlassian API token scoped to a specific person on a specific
// site), have different lifetimes, and are cleared independently; sharing one
// blob would mean disconnecting Jira could invalidate a Copilot login.
//
// Why this lives in the main process at all, rather than in waypoint-backend:
// the backend is a separate Express process whose own HTTP surface has no
// authentication boundary (src/middleware/ is asyncHandler/errorHandler/errors
// and nothing else), so a live Jira credential held there would sit on a local
// port anything else on the machine could reach. Main already holds exactly
// this class of secret for Copilot, behind IPC that only this app's own
// renderer can speak.
//
// An API token is a real bearer credential for the user's whole Jira account.
// It is never logged, never returned to the renderer, and never sent anywhere
// but the one site hostname stored alongside it (see jiraClient.ts).

const CREDENTIAL_FILE_NAME = 'jira-auth.json';

/**
 * Everything needed to authenticate as this user, stored as a single
 * encrypted blob. `email` is in here rather than in plaintext next to the
 * ciphertext on purpose: with `site` it identifies a real person's Atlassian
 * account, and it's also half of the Basic-auth pair, so it gets the same
 * protection the token does.
 */
export interface JiraCredential {
  site: string;
  email: string;
  apiToken: string;
  accountId: string;
  displayName: string;
  avatarUrl: string | null;
}

function credentialFilePath(): string {
  return path.join(app.getPath('userData'), CREDENTIAL_FILE_NAME);
}

/** Mirrors copilotAuth.ts's own guard: without OS-level encryption there is
 * no safe place to put this, and writing it in the clear is not an acceptable
 * fallback for a credential that can read and write someone's whole Jira. */
export function isJiraSecureStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The stored credential, or null if there isn't one (or it can't be read).
 * Every failure mode — no file, malformed JSON, encryption unavailable, a
 * blob that decrypts to something that isn't a credential — collapses to
 * null, exactly like copilotAuth.ts's readStoredToken: callers treat "no
 * usable credential" as "not connected", and there is no partially-usable
 * state worth distinguishing.
 */
export function readStoredJiraCredential(): JiraCredential | null {
  try {
    const raw = fs.readFileSync(credentialFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as { encrypted?: string };
    if (!parsed.encrypted) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    const decrypted = JSON.parse(
      safeStorage.decryptString(Buffer.from(parsed.encrypted, 'base64')),
    ) as Partial<JiraCredential>;
    if (
      !isNonEmptyString(decrypted.site) ||
      !isNonEmptyString(decrypted.email) ||
      !isNonEmptyString(decrypted.apiToken) ||
      !isNonEmptyString(decrypted.accountId)
    ) {
      return null;
    }
    return {
      site: decrypted.site,
      email: decrypted.email,
      apiToken: decrypted.apiToken,
      accountId: decrypted.accountId,
      displayName: isNonEmptyString(decrypted.displayName)
        ? decrypted.displayName
        : decrypted.email,
      avatarUrl: isNonEmptyString(decrypted.avatarUrl)
        ? decrypted.avatarUrl
        : null,
    };
  } catch {
    return null;
  }
}

/** Throws on a locked keychain or a full disk — callers are expected to catch
 * and report, not to let the failure escape as an unsettled IPC invoke (the
 * exact hazard copilotAuth.ts's save handler documents). */
export function writeStoredJiraCredential(credential: JiraCredential): void {
  const encrypted = safeStorage
    .encryptString(JSON.stringify(credential))
    .toString('base64');
  fs.writeFileSync(credentialFilePath(), JSON.stringify({ encrypted }), {
    mode: 0o600,
  });
}

export function deleteStoredJiraCredential(): void {
  try {
    fs.unlinkSync(credentialFilePath());
  } catch {
    // Already gone — disconnecting an already-disconnected account is a
    // no-op, not an error.
  }
}

/** The renderer-safe projection of a credential. This is the ONLY shape that
 * ever crosses IPC: it is the credential minus `apiToken`, and keeping the
 * conversion in one named function is what makes "the token never leaves the
 * main process" checkable rather than a convention. */
export function toJiraIdentity(credential: JiraCredential): JiraIdentity {
  return {
    site: credential.site,
    accountId: credential.accountId,
    email: credential.email,
    displayName: credential.displayName,
    avatarUrl: credential.avatarUrl,
  };
}
