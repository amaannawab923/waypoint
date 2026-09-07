import { ipcMain } from 'electron';
import {
  encodeJiraCredentialHeader,
  readStoredJiraCredential,
  JIRA_CREDENTIAL_HEADER,
} from '../jira/jiraAuth';

/**
 * Approving and rejecting Copilot proposals, from the MAIN process.
 *
 * These three POSTs used to be plain fetch() calls out of the renderer (see
 * data/api.ts). That worked for as long as every proposal was a change to a
 * row in this app's own database. It stops working the moment approving one
 * can write to Jira, because the credential that authorizes such a write only
 * ever exists here: jira/jiraAuth.ts holds the one persisted copy, encrypted
 * by the OS keychain, and its own module comment is explicit that the API
 * token is "never logged, never returned to the renderer, and never sent
 * anywhere" outside main. A renderer-issued approve therefore has no way to
 * carry it, and a Jira proposal approved that way is permanently stuck —
 * safely stuck (the backend resolves it as stale), but stuck.
 *
 * So the request moves to where the credential already lives, rather than the
 * credential moving to where the request already was. That direction is the
 * whole point: nothing here returns the token, and the renderer's own code is
 * unchanged apart from which function it calls.
 *
 * The credential rides on the same borrowed-per-request header the MCP
 * endpoint already uses, encoded by the same function (see jiraAuth.ts's
 * encodeJiraCredentialHeader). The backend parses it into a value that lives
 * as long as the request and writes it nowhere.
 *
 * Reject deliberately does NOT carry it. A reject executes nothing, so it
 * needs no credential, and sending one on a request that cannot use it is a
 * larger surface for no benefit.
 */

// The same fallback claudeSession.ts uses for the MCP endpoint — 14000, not
// Express's conventional 4000, matching waypoint-backend's own default.
function apiBaseUrl(): string {
  return process.env.WAYPOINT_API_BASE_URL || 'http://localhost:14000';
}

/**
 * Guards every id that reaches a URL path, the same rule jiraIpc.ts applies
 * to its own ticket ids and for the same reason: the renderer is this app's
 * own code, but IPC is still an external input to the privileged process, and
 * an id is not a value worth taking on trust from a caller. The shape is
 * lib/ids.ts's — a prefix, a hyphen, then alphanumerics — which cannot spell
 * a path segment, a query string, or a scheme.
 */
const PROPOSAL_ID = /^[a-z]+-[A-Za-z0-9]{1,64}$/;

// Matches the backend's own MAX_REVIEW_QUEUE_LIMIT (proposals.service.ts) —
// the review queue this bulk-approve acts on can never hand back more rows
// than that in one page, so a caller has no legitimate reason to submit
// more. Without a cap here, an unbounded array becomes an unbounded
// sequential loop server-side (bulkApproveProposals approves one at a time),
// which is a cheap denial-of-service on this endpoint from any local caller.
const MAX_BULK_APPROVE_IDS = 100;

function readProposalId(value: unknown): string | null {
  return typeof value === 'string' && PROPOSAL_ID.test(value) ? value : null;
}

/**
 * One POST to the backend, returning its parsed JSON.
 *
 * Deliberately thin, and deliberately NOT a re-implementation of the
 * renderer's httpClient: the toast-on-failure behavior there is a renderer
 * concern (it can show one), and the error handling that matters here is
 * simply that a failure arrives at the caller as a rejected promise carrying
 * the backend's own message — which is exactly what data/api.ts's callers
 * already expect, since an ipcRenderer.invoke rejects when the handler
 * throws.
 */
async function post<T>(
  path: string,
  options: { withJiraCredential: boolean; body?: unknown },
): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (options.withJiraCredential) {
    // No connected account simply omits the header. There is nothing to
    // special-case downstream: the backend handles "Jira is not connected"
    // for the header-absent case regardless, and almost every approve is of
    // a native proposal that never touches it.
    const credential = encodeJiraCredentialHeader(readStoredJiraCredential());
    if (credential) headers[JIRA_CREDENTIAL_HEADER] = credential;
  }

  const response = await fetch(`${apiBaseUrl()}${path}`, {
    method: 'POST',
    headers,
    // '{}' rather than no body at all: the single-row endpoints run their
    // request body through a zod schema, which needs an object to parse.
    body: JSON.stringify(options.body ?? {}),
  });

  if (!response.ok) {
    // The backend's own sentence beats a bare status number, and it is what
    // the renderer will show. A non-JSON body (a proxy's error page, say)
    // falls back rather than throwing a second, less useful error.
    let message = `Request failed: ${response.status} ${path}`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (body?.error) {
        message =
          typeof body.error === 'string'
            ? body.error
            : JSON.stringify(body.error);
      }
    } catch {
      // no JSON error body — keep the generic message
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

export function registerProposalApprovalIpc(): void {
  // Request/response throughout — an approve produces exactly one settled
  // answer, never a stream — so ipcMain.handle rather than the send/on pair
  // the run and connect flows need. Same shape as jiraIpc.ts's channels.
  ipcMain.handle(
    'copilot:proposals:approve',
    async (_event, rawId: unknown) => {
      const id = readProposalId(rawId);
      if (!id) throw new Error('Invalid proposal id.');
      return post(`/copilot/proposals/${id}/approve`, {
        withJiraCredential: true,
      });
    },
  );

  ipcMain.handle('copilot:proposals:reject', async (_event, rawId: unknown) => {
    const id = readProposalId(rawId);
    if (!id) throw new Error('Invalid proposal id.');
    // No credential: a reject executes nothing.
    return post(`/copilot/proposals/${id}/reject`, {
      withJiraCredential: false,
    });
  });

  ipcMain.handle(
    'copilot:proposals:bulk-approve',
    async (_event, rawIds: unknown) => {
      if (
        !Array.isArray(rawIds) ||
        rawIds.length === 0 ||
        rawIds.length > MAX_BULK_APPROVE_IDS
      ) {
        throw new Error('Invalid proposal ids.');
      }
      // Every id, or none. A batch that silently dropped the malformed ones
      // would report success for a set the caller never asked for, and the
      // review screen patches its rows from that result.
      const ids = rawIds.map(readProposalId);
      if (ids.some((id) => id === null))
        throw new Error('Invalid proposal ids.');
      // Note the path: bare /proposals/..., not /copilot/proposals/... — this
      // is the workspace-scoped review-queue router, not the conversation-
      // scoped Copilot one (see the backend's reviewQueue.routes.ts).
      return post('/proposals/bulk-approve', {
        withJiraCredential: true,
        body: { ids },
      });
    },
  );
}
