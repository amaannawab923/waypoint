import { ipcMain } from 'electron';
import {
  deleteStoredAccountCredential,
  isAccountSecureStorageAvailable,
  readStoredAccountCredential,
  setStoredActiveWorkspaceId,
  toAccountIdentity,
  writeStoredAccountCredential,
} from './accountAuth';
import { cancelSignIn, checkInstanceSetupStatus, revokeAccountSession, startSignIn } from './accountSignIn';
import { hostedFetch } from './hostedApi';
import type {
  AccountConnectionSnapshot,
  AccountIdentity,
  AccountResult,
  HostedFetchRequest,
  HostedFetchResponse,
  InstanceSetupStatus,
} from './accountTypes';

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

      const result = await startSignIn(purpose || undefined);
      if (!result.ok) return result;

      // AT9's redirect (waypoint-backend/src/auth/flows.ts's
      // finishRedirect) carries email/name/avatar alongside the token —
      // added specifically so this handler never needs a separate "who am
      // I" round trip against a backend a session token has only just
      // proven live. Not new exposure: the token this same redirect
      // already carries is the actual bearer secret.
      const { backendUrl, token, email, fullName, avatarUrl } = result.value;
      // AT12: a fresh sign-in always starts with no active workspace —
      // set explicitly afterward, either right after creating one or by
      // picking one from the switcher. Preserving a prior selection here
      // would risk pointing a NEW session at a workspace this sign-in
      // was never proven to still belong to.
      const credential = { backendUrl, token, email, fullName, avatarUrl, activeWorkspaceId: null };
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

  ipcMain.handle('account:signOut', async (): Promise<{ ok: true }> => {
    // Best-effort server-side revoke before forgetting the credential
    // locally — read it first, since deleting it first would lose the
    // token this needs. Review fix: signing out previously only deleted
    // the local file, leaving the session valid on the backend for up to
    // its full 90-day TTL.
    const credential = readStoredAccountCredential();
    if (credential) await revokeAccountSession(credential.backendUrl, credential.token);
    deleteStoredAccountCredential();
    return { ok: true };
  });

  // AT12 (ROAD-147).
  ipcMain.handle('account:activeWorkspace:set', (_event, args: unknown): { ok: boolean } => {
    const input = (args ?? {}) as Record<string, unknown>;
    const workspaceId = typeof input.workspaceId === 'string' && input.workspaceId ? input.workspaceId : null;
    try {
      return { ok: setStoredActiveWorkspaceId(workspaceId) };
    } catch {
      // Same locked-keychain/full-disk hazard writeStoredAccountCredential
      // always carries — resolved false, not rejected, so a switcher click
      // gets a clean "didn't take" instead of an unsettled invoke.
      return { ok: false };
    }
  });

  // The one generic proxy every hosted-workspace renderer call goes
  // through — see hostedApi.ts's own comment for why this is a single
  // channel rather than one per feature. `req.path` is plain string
  // concatenation onto credential.backendUrl in hostedApi.ts, never URL
  // resolution (new URL(path, base)), so a "//evil.com/x"-shaped path
  // can't escape the stored backend's own origin the way protocol-
  // relative resolution would allow.
  ipcMain.handle(
    'account:hostedFetch',
    (_event, req: HostedFetchRequest): Promise<HostedFetchResponse> => hostedFetch(req),
  );
}
