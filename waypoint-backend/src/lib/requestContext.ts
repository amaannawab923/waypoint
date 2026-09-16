import { AsyncLocalStorage } from 'node:async_hooks';
import { CURRENT_USER_ID, WORKSPACE_ID } from './currentUser.js';

// AT11 (ROAD-146). Every service in this codebase reads CURRENT_USER_ID/
// WORKSPACE_ID as bare imported constants — there is no req parameter
// threaded through the ~15 functions across 12 files that need "who is
// this" or "which workspace is this." Adding one would mean changing
// every one of those signatures and every route that calls them, a huge,
// high-risk diff for what is fundamentally request-scoped context.
// AsyncLocalStorage carries it instead: middleware/resolveMember.ts sets
// it once per request; every service reads it via the two functions
// below, wherever it previously read the constants directly.
//
// currentUser.ts itself is untouched, per the spec's explicit "Personal's
// local backend keeps importing the literal constants unmodified" —
// these two functions are this file's own fallback to them, not a
// replacement of them. Outside any request (a unit test calling a
// service function directly, a script, the dev seed) getStore() returns
// undefined and both functions return exactly what they always did —
// existing tests that assert against the literal 'mem-1'/'ws-1' need no
// changes.

export interface RequestIdentity {
  userId: string;
  memberId: string;
  workspaceId: string;
  role: 'admin' | 'member' | 'guest';
}

const als = new AsyncLocalStorage<RequestIdentity>();

export function runWithIdentity<T>(identity: RequestIdentity, fn: () => T): T {
  return als.run(identity, fn);
}

export function currentIdentity(): RequestIdentity | undefined {
  return als.getStore();
}

/** `req.member.id` on the hosted path; `CURRENT_USER_ID` on Personal
 * (unauthenticated) requests — the fallback IS the Personal behavior,
 * not an error case. */
export function currentMemberId(): string {
  return als.getStore()?.memberId ?? CURRENT_USER_ID;
}

/** `req.member.workspaceId` on the hosted path; `WORKSPACE_ID` on
 * Personal requests. */
export function currentWorkspaceId(): string {
  return als.getStore()?.workspaceId ?? WORKSPACE_ID;
}
