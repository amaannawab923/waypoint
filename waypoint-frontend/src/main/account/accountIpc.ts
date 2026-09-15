import { ipcMain } from 'electron';
import {
  deleteStoredAccountCredential,
  isAccountSecureStorageAvailable,
  readStoredAccountCredential,
  toAccountIdentity,
  writeStoredAccountCredential,
} from './accountAuth';
import { cancelSignIn, checkInstanceSetupStatus, startSignIn } from './accountSignIn';
import type { AccountConnectionSnapshot, AccountIdentity, AccountResult, InstanceSetupStatus } from './accountTypes';

// AT10 (ROAD-145). Every `account:*` channel, in one place — mirrors
// jiraIpc.ts's own shape and the same rule its header states: nothing that
// crosses back to the renderer contains the session token, only
// AccountIdentity, built by accountAuth.ts's toAccountIdentity(). Two
// channels (`account:status`, `account:setupStatus`) are read-only and safe
// to call at any time; `account:signIn` is the one that actually opens a
// browser and can run for minutes, which is why it and `account:signIn:
// cancel` are split across two handles rather than one.
//
// No workspace creation and no purpose-specific behavior lives here — that
// is AT12 (the invite flow) and AT6 (Sync). This registers the reusable
// primitive both of those call identically, passing whatever `purpose`
// string means something to them.

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function registerAccountIpc(): void {
  ipcMain.handle('account:status', (): AccountConnectionSnapshot => {
    const credential = readStoredAccountCredential();
    if (!credential) return { connected: false, identity: null };
    return { connected: true, identity: toAccountIdentity(credential) };
  });

  ipcMain.handle('account:setupStatus', (): Promise<AccountResult<InstanceSetupStatus>> => {
    return checkInstanceSetupStatus();
  });

  ipcMain.handle(
    'account:signIn',
    async (_event, args: unknown): Promise<AccountResult<AccountIdentity>> => {
      const input = (args ?? {}) as Record<string, unknown>;
      const purpose = readString(input.purpose);

      // Checked before opening a browser, not after: sending someone
      // through a real sign-in only to discover the result can't be saved
      // wastes the one thing this flow can't get back — their attention.
      if (!isAccountSecureStorageAvailable()) {
        return {
          ok: false,
          reason: 'storage_unavailable',
          message: "Secure storage isn't available on this system, so a session can't be saved safely here.",
        };
      }

      const result = await startSignIn(purpose || undefined as unknown as string);
      if (!result.ok) return result;

      // AT9's redirect (waypoint-backend/src/auth/flows.ts's
      // finishRedirect) carries email/name/avatar alongside the token —
      // added specifically so this handler never needs a separate "who am
      // I" round trip against a backend a session token has only just
      // proven live. Not new exposure: the token this same redirect
      // already carries is the actual bearer secret.
      const { backendUrl, token, email, fullName, avatarUrl } = result.value;
      const credential = { backendUrl, token, email, fullName, avatarUrl };
      try {
        writeStoredAccountCredential(credential);
      } catch {
        // Resolved, never rejected — same hazard jiraAuth.ts's
        // writeStoredJiraCredential comment documents: a locked keychain
        // or a full disk here must not leave the caller's await hanging
        // forever with a completed sign-in silently dropped.
        return {
          ok: false,
          reason: 'storage_unavailable',
          message: 'Signed in, but the session could not be saved securely on this device — try again.',
        };
      }
      return { ok: true, value: toAccountIdentity(credential) };
    },
  );

  ipcMain.handle('account:signIn:cancel', (): { ok: true } => {
    cancelSignIn();
    return { ok: true };
  });

  ipcMain.handle('account:signOut', (): { ok: true } => {
    deleteStoredAccountCredential();
    return { ok: true };
  });
}
