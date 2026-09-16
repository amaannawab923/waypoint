// AT10 (ROAD-145). Types for the account sign-in primitive — the client
// side of docs/design/self-hosted-auth-and-multitenancy.md §5. One flow,
// reused identically by the invite click (AT12) and Settings → Devices &
// Sync (AT6); this ticket only builds the primitive itself.

/** What GET /instance/setup-status (AT8, ROAD-143) reports about whichever
 * backend WAYPOINT_API_BASE_URL currently points at. */
export interface InstanceSetupStatus {
  setupRequired: boolean;
  instanceName: string | null;
  authMethods: Array<'github' | 'google' | 'email'>;
  signupMode: 'open' | 'invite_only' | null;
}

/** The stored credential — main-process only, never crosses IPC. A session
 * token (AT9), not a long-lived API key: 90 days, revocable by signing out,
 * scoped to whichever backend issued it. */
export interface AccountCredential {
  backendUrl: string;
  token: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
  /** AT12 (ROAD-147). Which of the signed-in user's workspaces the app is
   * currently pointed at — the X-Waypoint-Workspace-Id header hostedApi.ts
   * attaches to every hostedFetch call. Null until the workspace switcher
   * (or the create/join flow) sets one; not a secret, but scoped to this
   * one credential the same way the token is, so signing out (a new
   * credential file, or none) clears it too rather than leaking a stale
   * selection into a different account. */
  activeWorkspaceId: string | null;
}

/** The renderer-safe projection — the credential minus `token`. The ONLY
 * shape that crosses IPC, mirroring jiraAuth.ts's JiraIdentity boundary. */
export interface AccountIdentity {
  backendUrl: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
  activeWorkspaceId: string | null;
}

export interface AccountConnectionSnapshot {
  connected: boolean;
  identity: AccountIdentity | null;
}

export type AccountFailureReason =
  | 'setup_required'
  // The instance has no auth method the operator has configured at all —
  // distinct from setup_required (setup is done, nothing usable came out
  // of it), which AT8's own completeSetup already refuses to produce, but
  // an operator can still remove every credential from their compose env
  // after the fact.
  | 'no_auth_methods'
  | 'already_in_progress'
  | 'cancelled'
  | 'timeout'
  | 'state_mismatch'
  | 'network'
  | 'storage_unavailable'
  | 'backend_error';

export interface AccountFailure {
  ok: false;
  reason: AccountFailureReason;
  message: string;
}

export type AccountResult<T> = { ok: true; value: T } | AccountFailure;

/** What the invite click / Sync toggle actually asks for — becomes the
 * sign-in page's `for` query param and, unchanged, the `for` the desktop
 * gets back on the loopback callback. AT12/AT6 give this real meaning
 * (a workspace slug, or the literal 'sync'); this ticket treats it as an
 * opaque string round-tripped through the backend.
 */
export type SignInPurpose = string;

// AT12 (ROAD-147). hostedApi.ts's one generic proxy — see that file's own
// comment for why a single request/response shape, rather than one IPC
// channel per new hosted-workspace feature, is the boundary: the renderer
// must never see the raw session token (accountAuth.ts's own rule), so
// every hosted-workspace API call has to be made IN main, with the
// renderer only ever sending "what to call" and receiving "what came
// back."
export interface HostedFetchRequest {
  path: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
}

export type HostedFetchResponse<T = unknown> =
  | { ok: true; status: number; body: T }
  // A real HTTP response the backend sent (status present) is distinct
  // from a call that never reached it at all (not signed in, no active
  // workspace, a network failure) — status is absent for the latter, so a
  // caller can tell "the backend said no" from "there was no backend to
  // ask" without parsing message text.
  | { ok: false; status?: number; message: string };
