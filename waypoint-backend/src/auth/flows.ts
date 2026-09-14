import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { authFlows, users } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { ConflictError, NotFoundError, ValidationError } from '../middleware/errors.js';
import { configuredAuthMethods, type AuthMethod } from '../lib/authMethods.js';
import { getSetupStatus } from '../services/instance.service.js';
import { oauthCredentials, oauthProviders } from './providers/index.js';
import type { FetchLike, ProviderIdentity } from './providers/types.js';
import type { Mailer } from './mailer.js';
import { issueSession } from './sessions.js';
import { hashSecret, newSecret } from './tokens.js';
import { escapeHtml, publicBaseUrl, validateClientState, validateRedirectUri } from './redirect.js';

export { publicBaseUrl, validateClientState, validateRedirectUri };

// AT9 (ROAD-144). A sign-in from the desktop's point of view is: open the
// backend's sign-in page with `redirect_uri` (its loopback callback) and
// `state` (its CSRF value); get sent back to that URI with `token` and the
// same `state`. Everything between is this module: one auth_flows row per
// attempt, the provider round trip, and — the part that matters for
// decision 001 §3 — resolving the person to an existing users row
// (linking it) rather than minting a second identity.
//
// Spec: docs/design/self-hosted-auth-and-multitenancy.md §5.

export const FLOW_TTL_MS = 15 * 60 * 1000;

export type FlowDeps = {
  env: NodeJS.ProcessEnv;
  fetch: FetchLike;
  mailer: Mailer | null;
  now: () => Date;
  // Where GitHub/Google send the browser back and where the magic link
  // points — this backend's public base URL, the one registered with the
  // provider. Stable per instance, never the desktop's loopback port.
  publicBaseUrl: string;
};

function purposeOf(raw: string | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().slice(0, 64);
  return v || null;
}

async function createFlow(
  provider: AuthMethod,
  args: { redirectUri: string; clientState: string; purpose: string | null; email?: string },
  deps: FlowDeps,
): Promise<{ secret: string; id: string }> {
  const secret = newSecret();
  const now = deps.now();
  const id = newId('flow');
  await db.insert(authFlows).values({
    id,
    provider,
    secretHash: hashSecret(secret),
    email: args.email ?? null,
    redirectUri: args.redirectUri,
    clientState: args.clientState,
    purpose: args.purpose,
    createdAt: now,
    expiresAt: new Date(now.getTime() + FLOW_TTL_MS),
  });
  return { secret, id };
}

// Consumes the flow atomically: the UPDATE ... WHERE consumed_at IS NULL
// is what makes a magic link or an OAuth state single-use even if two
// callbacks race.
async function consumeFlow(provider: AuthMethod, secret: string, deps: FlowDeps) {
  const now = deps.now();
  const [row] = await db
    .update(authFlows)
    .set({ consumedAt: now })
    .where(
      and(
        eq(authFlows.secretHash, hashSecret(secret)),
        eq(authFlows.provider, provider),
        isNull(authFlows.consumedAt),
        gt(authFlows.expiresAt, now),
      ),
    )
    .returning();
  if (!row) throw new NotFoundError('sign-in link (expired, already used, or unknown)');
  return row;
}

export type ResolvedIdentity = {
  provider: AuthMethod;
  providerId: string | null;
  email: string;
  emailVerified: boolean;
  fullName: string;
  avatarUrl: string | null;
};

// Decision 001 §3, "link, don't replace": a person is one users row for
// life. Match by provider subject first, then by email — which is how the
// desktop's local profile and AT8's setup admin (both unverified rows
// created before any sign-in) get claimed by the first real sign-in
// rather than duplicated. Signup mode is enforced only when a brand-new
// row would be needed: an existing row is by definition someone already
// let in (an invitee's row is pre-created by AT12).
export async function resolveOrCreateUser(identity: ResolvedIdentity, deps: FlowDeps) {
  const email = identity.email.trim().toLowerCase();
  const now = deps.now();

  const byProvider =
    identity.providerId &&
    (await db
      .select()
      .from(users)
      .where(and(eq(users.authMethod, identity.provider), eq(users.authProviderId, identity.providerId))))[0];
  const [byEmail] = byProvider ? [] : await db.select().from(users).where(sql`lower(${users.email}) = ${email}`);
  const existing = byProvider || byEmail;

  if (existing) {
    const patch: Partial<typeof users.$inferInsert> = {};
    if (identity.providerId && existing.authProviderId !== identity.providerId) {
      patch.authProviderId = identity.providerId;
      patch.authMethod = identity.provider;
    } else if (!identity.providerId && existing.authMethod !== identity.provider && !existing.authProviderId) {
      patch.authMethod = identity.provider;
    }
    if (identity.emailVerified && !existing.emailVerifiedAt) patch.emailVerifiedAt = now;
    // Stored lowercase always — users.email's unique index is case-
    // sensitive, so "Me@x" and "me@x" would otherwise be two people. A
    // verified sign-in may also correct the address outright.
    if (existing.email !== email && (identity.emailVerified || existing.email.toLowerCase() === email)) patch.email = email;
    if (!existing.avatarUrl && identity.avatarUrl) patch.avatarUrl = identity.avatarUrl;
    if (Object.keys(patch).length === 0) return { user: existing, created: false };
    const [updated] = await db.update(users).set(patch).where(eq(users.id, existing.id)).returning();
    return { user: updated, created: false };
  }

  const status = await getSetupStatus(deps.env);
  if (status.signupMode === 'invite_only') {
    throw new ConflictError('This instance is invite-only. Ask a workspace member for an invite link.');
  }
  const [created] = await db
    .insert(users)
    .values({
      id: newId('user'),
      email,
      authMethod: identity.provider,
      authProviderId: identity.providerId,
      emailVerifiedAt: identity.emailVerified ? now : null,
      fullName: identity.fullName,
      avatarUrl: identity.avatarUrl,
      createdAt: now,
    })
    .returning();
  return { user: created, created: true };
}

function finishRedirect(flow: typeof authFlows.$inferSelect, token: string): string {
  const u = new URL(flow.redirectUri);
  u.searchParams.set('token', token);
  u.searchParams.set('state', flow.clientState);
  if (flow.purpose) u.searchParams.set('for', flow.purpose);
  return u.toString();
}

// ---- OAuth -----------------------------------------------------------------

export async function startOAuth(
  provider: 'github' | 'google',
  args: { redirectUri?: string; clientState?: string; purpose?: string },
  deps: FlowDeps,
): Promise<string> {
  if (!configuredAuthMethods(deps.env).includes(provider)) {
    throw new ValidationError(`${provider} sign-in is not configured on this instance`);
  }
  const creds = oauthCredentials(provider, deps.env)!;
  const redirectUri = validateRedirectUri(args.redirectUri);
  const clientState = validateClientState(args.clientState);
  const { secret } = await createFlow(provider, { redirectUri, clientState, purpose: purposeOf(args.purpose) }, deps);
  return oauthProviders[provider].authorizeUrl({
    clientId: creds.clientId,
    redirectUri: `${deps.publicBaseUrl}/auth/${provider}/callback`,
    state: secret,
  });
}

// Returns the desktop redirect to send the browser to. Throws on a bad or
// reused state, a failed exchange, or an invite-only refusal — the route
// renders those as a page, since a browser is what's on the other end.
export async function completeOAuth(
  provider: 'github' | 'google',
  args: { code?: string; state?: string; error?: string },
  deps: FlowDeps,
): Promise<string> {
  if (args.error) throw new ValidationError(`${provider} refused the sign-in: ${args.error}`);
  if (!args.state || !args.code) throw new ValidationError('missing code or state');
  const flow = await consumeFlow(provider, args.state, deps);
  const creds = oauthCredentials(provider, deps.env);
  if (!creds) throw new ValidationError(`${provider} sign-in is not configured on this instance`);
  const identity: ProviderIdentity = await oauthProviders[provider].exchange(
    { ...creds, redirectUri: `${deps.publicBaseUrl}/auth/${provider}/callback`, code: args.code },
    deps.fetch,
  );
  const { user } = await resolveOrCreateUser(identity, deps);
  const { token } = await issueSession(user.id, { now: deps.now() });
  return finishRedirect(flow, token);
}

// ---- Email magic link ------------------------------------------------------

export async function startEmailLink(
  args: { email?: string; redirectUri?: string; clientState?: string; purpose?: string },
  deps: FlowDeps,
): Promise<{ sentTo: string }> {
  if (!configuredAuthMethods(deps.env).includes('email') || !deps.mailer) {
    throw new ValidationError('Email sign-in is not configured on this instance');
  }
  const email = args.email?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError('a valid email is required');
  const redirectUri = validateRedirectUri(args.redirectUri);
  const clientState = validateClientState(args.clientState);
  const { secret } = await createFlow('email', { redirectUri, clientState, purpose: purposeOf(args.purpose), email }, deps);
  const link = `${deps.publicBaseUrl}/auth/email/verify?token=${encodeURIComponent(secret)}`;
  const status = await getSetupStatus(deps.env);
  const name = status.instanceName ?? 'Waypoint';
  await deps.mailer.send({
    to: email,
    subject: `Sign in to ${name}`,
    text: `Open this link to sign in to ${name}. It works once and expires in 15 minutes.\n\n${link}\n\nIf you didn't ask for this, ignore it — nothing happens unless the link is opened.`,
    html: `<p>Open this link to sign in to <b>${escapeHtml(name)}</b>. It works once and expires in 15 minutes.</p><p><a href="${link}">${link}</a></p><p>If you didn't ask for this, ignore it — nothing happens unless the link is opened.</p>`,
  });
  return { sentTo: email };
}

export async function completeEmailLink(args: { token?: string }, deps: FlowDeps): Promise<string> {
  if (!args.token) throw new ValidationError('missing token');
  const flow = await consumeFlow('email', args.token, deps);
  if (!flow.email) throw new ValidationError('malformed sign-in link');
  const { user } = await resolveOrCreateUser(
    {
      provider: 'email',
      providerId: null,
      email: flow.email,
      // Clicking a link that only that inbox received is the verification.
      emailVerified: true,
      fullName: flow.email.split('@')[0],
      avatarUrl: null,
    },
    deps,
  );
  const { token } = await issueSession(user.id, { now: deps.now() });
  return finishRedirect(flow, token);
}
