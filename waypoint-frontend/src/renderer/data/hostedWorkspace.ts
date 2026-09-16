// AT12 (ROAD-147). Team workspace creation, the switcher's listing, and
// invites — data/api.ts's own convention (async functions, never reach
// past them), but routed through window.electron.account.hostedFetch
// rather than httpClient.ts's direct fetch. httpClient.ts talks to the
// LOCAL Personal backend with no credential attached at all — there's
// nothing to attach, Personal has no auth. A Team workspace request needs
// a real Bearer session token, and that token never leaves the main
// process (main/account/accountAuth.ts's own rule, mirroring jiraAuth.ts's
// boundary for a different secret) — so, like jiraApi.ts, this file can
// only ask main to make the request, never make it itself.

export interface HostedWorkspace {
  id: string;
  name: string;
  slug: string;
  isPersonal: boolean;
  myMemberId: string;
  myRole: 'admin' | 'member' | 'guest';
}

export interface WorkspaceInvite {
  id: string;
  expiresAt: string;
  joinUrl: string;
}

/** Rides the backend's own message (and, when there is one, its HTTP
 * status) — the same "preserve what the failure actually said" reasoning
 * jiraApi.ts's JiraApiError documents for a sibling boundary. */
export class HostedApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'HostedApiError';
    this.status = status;
  }
}

async function call<T>(path: string, method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', body?: unknown): Promise<T> {
  const res = await window.electron.account.hostedFetch<T>({ path, method, body });
  if (!res.ok) throw new HostedApiError(res.message, res.status);
  return res.body;
}

/** Spec §7 step 6. Requires a signed-in account (main's requireUser gate on
 * the backend) but no active workspace yet — creating the first one is
 * exactly what has none selected. */
export function createTeamWorkspace(name: string): Promise<HostedWorkspace> {
  return call<HostedWorkspace>('/workspaces', 'POST', { name });
}

/** Spec §7 step 11 — the workspace switcher's own listing. */
export function listMyWorkspaces(): Promise<HostedWorkspace[]> {
  return call<HostedWorkspace[]>('/workspaces');
}

/** Spec §7 step 9. `email` only for "Email invite instead" — omitted, this
 * is the plain "Copy link" invite the mockup treats as the default. */
export function createWorkspaceInvite(workspaceId: string, email?: string): Promise<WorkspaceInvite> {
  return call<WorkspaceInvite>(
    `/workspaces/${encodeURIComponent(workspaceId)}/invites`,
    'POST',
    email ? { email } : {},
  );
}

export async function revokeWorkspaceInvite(workspaceId: string, inviteId: string): Promise<void> {
  await call<null>(`/workspaces/${encodeURIComponent(workspaceId)}/invites/${encodeURIComponent(inviteId)}`, 'DELETE');
}

/** Points the app at a different one of the signed-in user's workspaces —
 * persisted in main (accountAuth.ts's stored credential), read back by
 * hostedFetch on every subsequent call. Resolves false, never throws, on
 * a write failure (a locked keychain, a full disk) — the same
 * resolved-not-rejected discipline account:signIn's own storage_unavailable
 * path already uses, so a switcher click gets a clean "didn't take"
 * rather than an unhandled rejection. */
export async function setActiveWorkspace(workspaceId: string | null): Promise<boolean> {
  const res = await window.electron.account.setActiveWorkspace(workspaceId);
  return res.ok;
}
