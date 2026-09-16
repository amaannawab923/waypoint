import { readStoredAccountCredential } from './accountAuth';
import type { HostedFetchRequest, HostedFetchResponse } from './accountTypes';

// AT12 (ROAD-147). The one seam a hosted-workspace API call crosses IPC
// through — accountAuth.ts's own rule ("the renderer never sees the raw
// session token") means the renderer cannot build these requests itself;
// main has to make them and hand back only the result. One generic
// request/response shape rather than a dedicated IPC channel per new
// hosted-workspace feature (create workspace, list workspaces, create an
// invite, ...): the backend's own route surface (waypoint-backend/src/
// routes/workspaces.routes.ts, workspaceInvites.routes.ts) is what
// actually defines what's callable, and duplicating that as a matching
// main-process function per route would be the same information twice,
// drifting the moment one side changes without the other.
//
// Deliberately NOT the same client accountSignIn.ts's checkInstanceSetup
// Status uses (a bare fetch against a fixed path) — this one has to
// attach the Bearer token AND, when one is selected, the workspace
// header, and translate a non-2xx response into the same HostedFetch
// Response['ok'] === false shape a network failure produces, so callers
// (renderer/data/hostedWorkspace.ts) have exactly one failure branch to
// handle rather than two.

const REQUEST_TIMEOUT_MS = 20_000;

export async function hostedFetch<T = unknown>(req: HostedFetchRequest): Promise<HostedFetchResponse<T>> {
  const credential = readStoredAccountCredential();
  if (!credential) {
    return { ok: false, message: 'Not signed in to a Team workspace.' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credential.token}`,
    };
    // Only attached when one is actually selected — some routes
    // (creating/listing workspaces) work without it by design
    // (waypoint-backend's identityOnlyRouter), and sending a stale or
    // wrong one for those would be worse than sending none.
    if (credential.activeWorkspaceId) headers['X-Waypoint-Workspace-Id'] = credential.activeWorkspaceId;

    const res = await fetch(`${credential.backendUrl}${req.path}`, {
      method: req.method ?? 'GET',
      headers,
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // A non-JSON body (an HTML error page from a misconfigured
        // reverse proxy, for instance) — fall through with parsed left
        // null rather than throwing out of a function that's supposed
        // to collapse every failure to the same shape.
      }
    }

    if (!res.ok) {
      const message =
        (parsed as { message?: string; error?: string } | null)?.message ??
        (parsed as { message?: string; error?: string } | null)?.error ??
        `The backend refused this request (${res.status}).`;
      return { ok: false, status: res.status, message };
    }
    return { ok: true, status: res.status, body: parsed as T };
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      return { ok: false, message: "Couldn't reach the backend — timed out." };
    }
    return { ok: false, message: "Couldn't reach the backend. Check it's running and reachable." };
  } finally {
    clearTimeout(timeout);
  }
}
