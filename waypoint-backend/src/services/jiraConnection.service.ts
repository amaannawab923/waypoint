import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { integrationCredentials } from '../db/schema/index.js';
import { seal, open } from '../lib/secretBox.js';
import { validateCredential, type JiraCredential, type JiraResult } from '../lib/jira/client.js';
// The site control moved to where the credential now enters this process —
// the MCP header parser — since that is the only path a site still arrives
// by. Imported rather than kept here so there is one definition of it.
import { normalizeSite } from '../lib/jira/credentialHeader.js';

/**
 * The backend's own Jira connection — separate by design from the one the
 * desktop app's My Jira sidebar uses (see db/schema/integrations.ts for the
 * full reasoning and the accepted tradeoff).
 */

// The provider key, which is also the primary key of the single row, and
// also the AAD the token is sealed against. One constant so those three can
// never drift apart into a token that is stored under one name and sealed
// against another.
export const JIRA_PROVIDER = 'jira';

export interface JiraConnectionStatus {
  connected: boolean;
  site?: string;
  email?: string;
  displayName?: string | null;
  accountId?: string | null;
  connectedAt?: Date;
  /**
   * True when a row exists but its token cannot be opened — the key is gone
   * or the ciphertext was tampered with (see lib/secretBox.ts). Surfaced as
   * its own flag rather than reported as "not connected", because the two
   * need different words in front of a user: nothing to set up, versus set it
   * up again.
   */
  needsReconnect?: boolean;
}

async function readRow() {
  const [row] = await db
    .select()
    .from(integrationCredentials)
    .where(eq(integrationCredentials.provider, JIRA_PROVIDER))
    .limit(1);
  return row;
}

export async function getStatus(): Promise<JiraConnectionStatus> {
  const row = await readRow();
  if (!row) return { connected: false };
  const token = open(row.sealedToken, JIRA_PROVIDER);
  return {
    connected: token !== null,
    needsReconnect: token === null,
    site: row.site,
    email: row.email,
    displayName: row.displayName,
    accountId: row.accountId,
    connectedAt: row.connectedAt,
  };
}

/**
 * The credential itself, for the provider layer.
 *
 * Returns null for both "never connected" and "cannot be opened", because
 * every caller's response to the two is the same: behave as though Jira is
 * not connected. Callers must treat null as "Jira is off", never as "Jira
 * said no" — see the resolution algorithm in mcp/ticketTools.ts, where
 * confusing those two would make it assert an identifier is native-only on
 * the strength of a credential it simply failed to read.
 */
export async function getCredential(): Promise<JiraCredential | null> {
  const row = await readRow();
  if (!row) return null;
  const apiToken = open(row.sealedToken, JIRA_PROVIDER);
  if (apiToken === null) {
    console.error('[jira] stored credential could not be decrypted — treating Jira as disconnected');
    return null;
  }
  return { site: row.site, email: row.email, apiToken };
}

/**
 * Saves a connection, but only one that has been proven to work.
 *
 * Validate-then-store, never store-then-validate: a stored credential that
 * has never authenticated is indistinguishable, later, from one that worked
 * and then expired — and the second is worth telling a user about while the
 * first is just a typo they could have fixed in the moment.
 */
export async function connect(input: {
  site: string;
  email: string;
  apiToken: string;
}): Promise<JiraResult<JiraConnectionStatus>> {
  const site = normalizeSite(input.site);
  if (!site) {
    return {
      ok: false,
      reason: 'site_not_found',
      message: 'That is not a Jira site address — use a hostname like yourteam.atlassian.net.',
    };
  }

  const candidate: JiraCredential = { site, email: input.email.trim(), apiToken: input.apiToken };
  const identity = await validateCredential(candidate);
  if (!identity.ok) return identity;

  const row = {
    provider: JIRA_PROVIDER,
    site,
    email: identity.value.email,
    sealedToken: seal(candidate.apiToken, JIRA_PROVIDER),
    accountId: identity.value.accountId,
    displayName: identity.value.displayName,
    connectedAt: new Date(),
  };
  // Upsert on the provider key: reconnecting REPLACES the connection rather
  // than accumulating a second one. connectedAt is refreshed too — it means
  // "when this credential was last proven", which is the only reading of it
  // that stays true after a reconnect.
  await db.insert(integrationCredentials).values(row).onConflictDoUpdate({
    target: integrationCredentials.provider,
    set: {
      site: row.site,
      email: row.email,
      sealedToken: row.sealedToken,
      accountId: row.accountId,
      displayName: row.displayName,
      connectedAt: row.connectedAt,
    },
  });

  return {
    ok: true,
    value: {
      connected: true,
      site,
      email: row.email,
      displayName: row.displayName,
      accountId: row.accountId,
      connectedAt: row.connectedAt,
    },
  };
}

/**
 * Re-proves the stored credential against Jira.
 *
 * Worth having as its own operation because a credential is a claim with an
 * expiry date that this app does not control: a revoked or rotated token
 * fails identically to a wrong one, and the only way to know is to ask.
 */
export async function test(): Promise<JiraResult<JiraConnectionStatus>> {
  const credential = await getCredential();
  if (!credential) {
    return { ok: false, reason: 'invalid_credentials', message: 'Jira is not connected.' };
  }
  const identity = await validateCredential(credential);
  if (!identity.ok) return identity;
  return { ok: true, value: await getStatus() };
}

/**
 * Deletes the row outright rather than flagging it disconnected. There is no
 * audit value in keeping a sealed token nobody intends to use, and a deleted
 * row is the only version of "disconnected" that cannot be undone by a bug.
 *
 * ticket_refs rows are deliberately left alone: they hold no secret, and they
 * are what lets a reconnect resolve previously-seen identifiers to the same
 * local handles instead of minting new ones for tickets the model may already
 * be holding ids for.
 */
export async function disconnect(): Promise<void> {
  await db.delete(integrationCredentials).where(eq(integrationCredentials.provider, JIRA_PROVIDER));
}
