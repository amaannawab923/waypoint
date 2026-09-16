import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { members } from '../db/schema/index.js';
import { seal, open } from '../lib/secretBox.js';
import { normalizeSite } from '../lib/jira/credentialHeader.js';
import type { JiraCredential } from '../lib/jira/client.js';
import { currentIdentity, currentMemberId } from '../lib/requestContext.js';
import { NotFoundError, ValidationError } from '../middleware/errors.js';

// AT12 (ROAD-147). Spec §7: "per-member Jira credential storage on the
// hosted path... a Postgres column per members row, replacing the
// single-machine jira-auth.json for hosted members." Storage only — the
// actual MCP/Jira request path still reads the per-request header exactly
// as before (lib/jira/credentialHeader.ts); wiring that to prefer this
// stored value instead is a deliberate, separate follow-up (a hosted
// member and the desktop machine holding jira-auth.json today aren't
// guaranteed to be the same thing, which is the whole reason this needs a
// home in Postgres at all).
//
// Always currentMemberId()-scoped, never an id-in-URL — every function
// here reads or writes the CALLING member's own row and nothing else, so
// this can't become another cross-tenant surface the way an id-taking
// function would need its own guard (the AT11 audit's whole discipline).
//
// The whole {site, email, apiToken} credential is sealed as one JSON blob
// (secretBox.ts's seal/open, AAD-bound to the member's own id) rather than
// splitting site/email into plain columns and only sealing apiToken: one
// column, one seal/open call, and the shape sealed is exactly
// lib/jira/client.ts's own JiraCredential, so a future consumption-side
// read is a straight JSON.parse of what open() returns.

export interface MyJiraCredentialStatus {
  connected: boolean;
  site?: string;
  email?: string;
  updatedAt?: Date;
  // A row exists but its ciphertext no longer opens — the encryption key
  // changed or was lost, or the value was tampered with (secretBox.ts's
  // own doc comment on why this collapses to null rather than throwing).
  // Surfaced as its own flag, matching the deleted jiraConnection.service.
  // ts's own JiraConnectionStatus shape: "nothing to set up" reads
  // differently from "set it up again".
  needsReconnect?: boolean;
}

// Round 2 review finding (M-1): every function here is currentMemberId()-
// scoped, never an id-in-URL — correct against a cross-tenant caller, but
// resolveMember's "no Authorization header → Personal" fallback means an
// UNAUTHENTICATED caller on a hosted instance still resolves to the
// seeded Personal identity (mem-1), with no header check catching it the
// way workspaces.service.ts's createInvite/revokeInvite already do (the
// H3 fix). Unlike those two id-taking routes, this file has no id
// parameter to guard — the guard has to be "is this a real, resolved
// identity at all," the same currentIdentity() check, applied here
// directly. Read-only elsewhere on the Personal fallback is accepted
// (AT11's own stance); this is the first SECRET STORE on that surface —
// an anonymous PUT would otherwise plant an attacker-chosen credential in
// mem-1's own row, sealed correctly under mem-1's real AAD.
function requireRealIdentity(): void {
  if (!currentIdentity()) throw new NotFoundError('current member');
}

async function readRow(memberId: string) {
  const [row] = await db
    .select({ sealed: members.jiraCredentialEncrypted, updatedAt: members.jiraCredentialUpdatedAt })
    .from(members)
    .where(eq(members.id, memberId));
  if (!row) throw new NotFoundError('current member');
  return row;
}

function openCredential(sealed: string, memberId: string): JiraCredential | null {
  const plaintext = open(sealed, memberId);
  if (plaintext === null) return null;
  try {
    const parsed = JSON.parse(plaintext) as JiraCredential;
    if (typeof parsed.site !== 'string' || typeof parsed.email !== 'string' || typeof parsed.apiToken !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function getMyJiraCredentialStatus(): Promise<MyJiraCredentialStatus> {
  requireRealIdentity();
  const memberId = currentMemberId();
  const row = await readRow(memberId);
  if (!row.sealed) return { connected: false };
  const credential = openCredential(row.sealed, memberId);
  return {
    connected: credential !== null,
    needsReconnect: credential === null,
    site: credential?.site,
    email: credential?.email,
    updatedAt: row.updatedAt ?? undefined,
  };
}

// The raw credential, for the future consumption-side reader this ticket
// deliberately doesn't build yet — kept here now so that follow-up is a
// call to this function, not a second seal/open call site to keep in sync
// with this one's AAD context and JSON shape.
export async function getMyJiraCredential(): Promise<JiraCredential | null> {
  requireRealIdentity();
  const memberId = currentMemberId();
  const row = await readRow(memberId);
  if (!row.sealed) return null;
  return openCredential(row.sealed, memberId);
}

export interface SetJiraCredentialInput {
  site: string;
  email: string;
  apiToken: string;
}

// No live validation against Jira this pass (unlike the deleted
// jiraConnection.service.ts's connect(), which proved a credential via a
// real /myself call before storing it) — deliberately: this ticket stores
// but doesn't yet consume the credential anywhere, so there's no request
// path that would surface a wrong token any sooner than the first real
// use eventually will, and adding a live outbound Jira call to a storage-
// only commit is exactly the kind of scope creep this ticket's plan
// named and avoided elsewhere. site is still normalized the same way the
// borrowed-header path already does, so a malformed or hostile site value
// can't reach storage in the first place.
export async function setMyJiraCredential(input: SetJiraCredentialInput): Promise<MyJiraCredentialStatus> {
  requireRealIdentity();
  const memberId = currentMemberId();
  const site = normalizeSite(input.site);
  if (!site) throw new ValidationError('site must be a Jira Cloud hostname, e.g. yourteam.atlassian.net');
  const email = input.email.trim();
  const apiToken = input.apiToken.trim();
  if (!email || !apiToken) throw new ValidationError('email and apiToken are required');

  const credential: JiraCredential = { site, email, apiToken };
  const sealed = seal(JSON.stringify(credential), memberId);
  const now = new Date();
  const [row] = await db
    .update(members)
    .set({ jiraCredentialEncrypted: sealed, jiraCredentialUpdatedAt: now })
    .where(eq(members.id, memberId))
    .returning({ id: members.id });
  if (!row) throw new NotFoundError('current member');
  return { connected: true, site, email, updatedAt: now };
}

export async function clearMyJiraCredential(): Promise<void> {
  requireRealIdentity();
  const memberId = currentMemberId();
  await db
    .update(members)
    .set({ jiraCredentialEncrypted: null, jiraCredentialUpdatedAt: null })
    .where(eq(members.id, memberId));
}
