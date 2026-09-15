import * as http from 'http';
import { randomBytes } from 'crypto';
import { shell } from 'electron';
import type { AccountFailure, AccountResult, InstanceSetupStatus, SignInPurpose } from './accountTypes';

// AT10 (ROAD-145). The client half of
// docs/design/self-hosted-auth-and-multitenancy.md §5 — what actually
// happens when someone clicks Invite (mockup step 6/7) or Settings →
// Devices & Sync (step 14). AT9 (ROAD-144) built the backend's /sign-in
// page and /auth/* exchange; this module is the loopback receiver that
// calls it, mirroring the mechanism (not the code — ours has no PKCE
// exchange step, see below) copied from
// /Users/amaannawab/emdash/apps/emdash-desktop/src/main/core/shared/
// oauth-flow.ts.
//
// One real difference from that reference, load-bearing: emdash's flow
// gets a `code` back and exchanges it for a token itself. Ours doesn't —
// AT9's backend already completed the entire OAuth exchange server-side
// (§5 step 4) before ever redirecting the browser back here, so this
// loopback server receives the finished `token` directly. There is
// nothing left to exchange; there is only something left to store
// (accountAuth.ts) and something left to verify (`state`, below).

// The same fallback claudeSession.ts, proposalApproval.ts, and
// ledgerClient.ts each use for the backend's own default — 14000, not
// Express's conventional 4000.
function backendBaseUrl(): string {
  return process.env.WAYPOINT_API_BASE_URL || 'http://localhost:14000';
}

function failure(reason: AccountFailure['reason'], message: string): AccountFailure {
  return { ok: false, reason, message };
}

/** GET /instance/setup-status (AT8) against whichever backend
 * WAYPOINT_API_BASE_URL currently points at — checked before ever opening
 * a browser, so a self-hosted instance that hasn't completed first-run
 * setup is caught here rather than as a confusing 503 mid-flow. Cloud's is
 * always already provisioned (AT8 §4), so this call is cheap there too. */
export async function checkInstanceSetupStatus(): Promise<AccountResult<InstanceSetupStatus>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${backendBaseUrl()}/instance/setup-status`, { signal: controller.signal });
    if (!res.ok) return failure('backend_error', `The backend answered unexpectedly (${res.status}).`);
    const status = (await res.json()) as InstanceSetupStatus;
    return { ok: true, value: status };
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      return failure('network', "Couldn't reach the backend — timed out.");
    }
    return failure('network', "Couldn't reach the backend. Check it's running and reachable.");
  } finally {
    clearTimeout(timeout);
  }
}

export interface SignInSuccess {
  backendUrl: string;
  token: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
  // The `for` the backend echoed back — always the same value passed in,
  // round-tripped rather than trusted independently, but returned so a
  // caller that raced two purposes (shouldn't happen; one flow at a time
  // is enforced below) can confirm which one actually completed.
  purpose: SignInPurpose | null;
}

const SIGN_IN_TIMEOUT_MS = 5 * 60_000; // five minutes to complete in the browser

// One sign-in in flight at a time, app-wide — the same posture jiraFiles.ts
// takes on attachment transfers ('transfer_in_progress'). A second click
// while one is open cancels cleanly rather than opening a second loopback
// server and a second browser tab racing the first for the same purpose.
let current: { server: http.Server; cancel: (result: AccountFailure) => void } | null = null;

/**
 * Runs one full sign-in: starts a one-shot loopback server on an
 * OS-assigned 127.0.0.1 port, opens the backend's /sign-in page in the
 * system browser with that port as `redirect_uri`, and resolves once the
 * browser is sent back with a token — or with a failure (cancelled,
 * timed out, state mismatch, the person closed the tab without finishing).
 *
 * Resolved, never rejected, for every outcome including cancellation —
 * the same "an awaited connect flow must not hang or throw past a caller
 * that's just waiting to update a spinner" discipline jiraAuth.ts's
 * writeStoredJiraCredential comment documents for its own failure modes.
 * accountIpc.ts's handler is the only caller; it decides what to persist.
 */
export function startSignIn(purpose?: SignInPurpose): Promise<AccountResult<SignInSuccess>> {
  if (current) {
    return Promise.resolve(failure('already_in_progress', 'A sign-in is already open in your browser.'));
  }

  const backendUrl = backendBaseUrl();
  const state = randomBytes(24).toString('base64url');

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: AccountResult<SignInSuccess>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      const server = current?.server;
      current = null;
      resolve(result);
      // Closed after resolving, not before: a slow client (the browser
      // hasn't finished reading the response body yet) must still get its
      // "you can close this tab" page even though the flow is already
      // decided from this app's side.
      server?.close();
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const returnedState = url.searchParams.get('state');
      const token = url.searchParams.get('token');
      const email = url.searchParams.get('email');
      const purposeBack = url.searchParams.get('for');

      if (returnedState !== state || !token || !email) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(calloutPage(
          "Sign-in didn't complete",
          "That link didn't match the sign-in this app started. Close this tab and try again from Waypoint.",
        ));
        finish(failure('state_mismatch', "The callback didn't match the sign-in that was started."));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(calloutPage(
        "You're signed in",
        'Waypoint picked this up automatically. You can close this tab.',
      ));
      finish({
        ok: true,
        value: {
          backendUrl,
          token,
          email,
          fullName: url.searchParams.get('name') || email,
          avatarUrl: url.searchParams.get('avatar'),
          purpose: purposeBack,
        },
      });
    });

    server.on('error', (err) => {
      finish(failure('network', `Couldn't start the local sign-in listener: ${err.message}`));
    });

    const timeoutHandle = setTimeout(() => {
      finish(failure('timeout', "Sign-in wasn't completed in time."));
    }, SIGN_IN_TIMEOUT_MS);

    current = { server, cancel: finish };

    // Node reports a real bind failure asynchronously via the 'error'
    // listener above, never a synchronous throw here — but that's a
    // guarantee about Node's own implementation, not this function's
    // contract to its caller. Defense in depth, from review: an
    // unguarded throw here would reject this Promise, breaking the
    // documented "resolves, never rejects" contract, and leave `current`
    // set forever with nothing left to clear it — every later sign-in
    // wedged behind already_in_progress until the app restarts.
    try {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          finish(failure('network', "Couldn't determine the local sign-in port."));
          return;
        }
        const redirectUri = `http://127.0.0.1:${address.port}/callback`;
        const params = new URLSearchParams({ redirect_uri: redirectUri, state });
        if (purpose) params.set('for', purpose);
        shell.openExternal(`${backendUrl}/sign-in?${params.toString()}`).catch((err: Error) => {
          finish(failure('network', `Couldn't open the browser: ${err.message}`));
        });
      });
    } catch (err) {
      finish(failure('network', `Couldn't start the local sign-in listener: ${(err as Error).message}`));
    }
  });
}

/** Cancels the one in-flight sign-in, if there is one — what the waiting
 * card's Cancel button (onboarding-final.html step 7) calls. A no-op,
 * successfully, when nothing is in flight: cancelling a flow that already
 * finished on its own is not an error. */
export function cancelSignIn(): void {
  current?.cancel(failure('cancelled', 'Cancelled.'));
}

/**
 * Tells the backend this session token is dead — AT9's `POST
 * /auth/signout` (`revokeSession`), added in review. Without this, "Sign
 * out" only forgot the token locally while it stayed live on the backend
 * for up to its full 90-day TTL. Best-effort and silent about failure:
 * the caller (accountIpc.ts's `account:signOut`) deletes the local
 * credential regardless — a person clicking Sign Out with no network
 * must not be told it didn't work, because the one thing that has to be
 * true locally, is.
 */
export async function revokeAccountSession(backendUrl: string, token: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    await fetch(`${backendUrl}/auth/signout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
  } catch {
    // Nothing to do — see the doc comment above.
  } finally {
    clearTimeout(timeout);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// A minimal terminal page for the loopback tab itself — not the backend's
// /sign-in page (AT9 owns that), just what the browser shows for the
// instant between the redirect landing here and the tab being closed.
function calloutPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(
    title,
  )}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#f4f4f6;color:#0a0a0c}@media(prefers-color-scheme:dark){body{background:#0a0a0c;color:#f2f2f4}}main{max-width:360px;padding:0 24px;text-align:center}h1{font-size:16px}p{font-size:13px;color:#53535c;line-height:1.5}</style></head><body><main><h1>${escapeHtml(
    title,
  )}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
}
