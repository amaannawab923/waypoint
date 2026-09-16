import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { authFlows, users } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { ConflictError, NotFoundError, ValidationError } from '../middleware/errors.js';
import { configuredAuthMethods, type AuthMethod } from '../lib/authMethods.js';
import { getSetupStatus } from '../services/instance.service.js';
import { getInvitePreview, acceptInvite } from '../services/workspaces.service.js';
import { renderJoinCompletePage } from './joinPage.js';
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
  args: {
    redirectUri: string | null;
    clientState: string;
    purpose: string | null;
    email?: string;
    // AT12 (ROAD-147): set only for a join-flow row — see
    // resolveFlowTarget below for why redirectUri is null exactly when
    // this is set.
    inviteToken?: string | null;
  },
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
    inviteToken: args.inviteToken ?? null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + FLOW_TTL_MS),
  });
  return { secret, id };
}

// AT12 (ROAD-147). The one place that decides whether a flow is the
// desktop-loopback shape (redirectUri validated as a real loopback
// callback) or the join shape (no redirect target at all — the join page
// itself is the destination, completion renders a page directly). An
// inviteToken re-validated here (existence/expiry/not-yet-accepted, via
// getInvitePreview) so a dead link never even reaches the OAuth
// provider — the definitive, atomic check still happens again at
// acceptance time in workspaces.service.ts's acceptInvite, since a link
// can expire or be consumed by someone else during the OAuth round trip.
async function resolveFlowTarget(args: {
  redirectUri?: string;
  clientState?: string;
  inviteToken?: string;
}): Promise<{ redirectUri: string | null; clientState: string }> {
  if (args.inviteToken) {
    await getInvitePreview(args.inviteToken);
    return { redirectUri: null, clientState: newSecret() };
  }
  return { redirectUri: validateRedirectUri(args.redirectUri), clientState: validateClientState(args.clientState) };
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
// life. Match by provider subject first — that is proof of the same
// account regardless of what the provider says about the email today.
// Otherwise match by email, which is how the desktop's local profile and
// AT8's setup admin (both unverified rows created before any sign-in) get
// claimed by the first real sign-in rather than duplicated — but ONLY by
// an identity whose email the provider has verified. An unverified
// address is a claim, not a proof, and letting it match by email would
// let anyone who can set a profile email on a GitHub account take over
// the row behind it (including isInstanceAdmin). Such an identity is
// refused outright and pointed at the email link, which verifies.
//
// A row that already carries a provider subject keeps it: a verified
// sign-in through a second provider for the same email still succeeds,
// but doesn't overwrite the first binding (and can't flip-flop it).
// Signup mode is enforced only when a brand-new row would be needed: an
// existing row is by definition someone already let in (an invitee's row
// is pre-created by AT12).
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export async function resolveOrCreateUser(
  identity: ResolvedIdentity,
  deps: FlowDeps,
  // AT12 (ROAD-147): set only by finishFlow when completing a join-flow
  // row — accepting a valid, already-server-verified workspace invite is
  // itself the authorization an invite-only instance is checking for.
  // Never derived from anything client-supplied; resolveFlowTarget/
  // acceptInvite own the real invite validation, not this flag.
  opts: { skipSignupModeCheck?: boolean } = {},
  // Ninth-round-style review fix (AT12): a join-flow completion passes
  // its own transaction here so a users row created by this function
  // rolls back together with a subsequent acceptInvite failure — see
  // finishFlow. Every other caller keeps using the plain db client.
  executor: Executor = db,
) {
  const email = identity.email.trim().toLowerCase();
  const now = deps.now();

  const [byProvider] = identity.providerId
    ? await executor
        .select()
        .from(users)
        .where(and(eq(users.authMethod, identity.provider), eq(users.authProviderId, identity.providerId)))
    : [];
  if (byProvider) {
    const patch: Partial<typeof users.$inferInsert> = {};
    if (identity.emailVerified && !byProvider.emailVerifiedAt) patch.emailVerifiedAt = now;
    if (!byProvider.avatarUrl && identity.avatarUrl) patch.avatarUrl = identity.avatarUrl;
    return { user: await applyPatch(byProvider, patch, executor), created: false };
  }

  if (!identity.emailVerified) {
    throw new ConflictError(
      `Your ${identity.provider} account's email address isn't verified, so it can't be used to sign in here. Verify it with ${identity.provider}, or use "Email me a link" instead.`,
    );
  }

  const [byEmail] = await executor.select().from(users).where(sql`lower(${users.email}) = ${email}`);
  if (byEmail) {
    const patch: Partial<typeof users.$inferInsert> = {};
    if (identity.providerId && !byEmail.authProviderId) {
      patch.authProviderId = identity.providerId;
      patch.authMethod = identity.provider;
    } else if (!identity.providerId && !byEmail.authProviderId && byEmail.authMethod !== 'email') {
      // AT8's setup admin carries a placeholder method; the email link is
      // what actually signed them in.
      patch.authMethod = 'email';
    }
    if (!byEmail.emailVerifiedAt) patch.emailVerifiedAt = now;
    // Stored lowercase always — users.email's unique index is case-
    // sensitive, so "Me@x" and "me@x" would otherwise be two people.
    if (byEmail.email !== email) patch.email = email;
    if (!byEmail.avatarUrl && identity.avatarUrl) patch.avatarUrl = identity.avatarUrl;
    return { user: await applyPatch(byEmail, patch, executor), created: false };
  }

  // Round 2 review finding (L-3): getSetupStatus's result is provably
  // unused whenever skipSignupModeCheck is true (the condition below is
  // false regardless of what it returns), so skip the call entirely in
  // that case rather than making it and discarding the answer. Not just
  // an efficiency nit: getSetupStatus queries via the plain db client,
  // never the join-flow transaction's own executor — called unconditionally
  // from inside finishFlow's transaction (see below), it used to reserve
  // a second pool connection per in-flight join completion. A batch of
  // concurrent new-invitee joins (the ordinary case: a brand-new person,
  // neither by-provider nor by-email match, is exactly when this line
  // used to run) could exhaust postgres.js's default 10-connection pool
  // and hang the eleventh request rather than erroring.
  if (!opts.skipSignupModeCheck) {
    const status = await getSetupStatus(deps.env);
    if (status.signupMode === 'invite_only') {
      throw new ConflictError('This instance is invite-only. Ask a workspace member for an invite link.');
    }
  }
  try {
    const [created] = await executor
      .insert(users)
      .values({
        id: newId('user'),
        email,
        authMethod: identity.provider,
        authProviderId: identity.providerId,
        emailVerifiedAt: now,
        fullName: identity.fullName,
        avatarUrl: identity.avatarUrl,
        createdAt: now,
      })
      .returning();
    return { user: created, created: true };
  } catch (err) {
    // Two first sign-ins for the same new address racing: the loser's
    // insert hits users_email_unique. Say so instead of leaking a driver
    // error into the browser page.
    if (isUniqueViolation(err)) throw new ConflictError('That account was just created — try signing in again.');
    throw err;
  }
}

async function applyPatch(
  existing: typeof users.$inferSelect,
  patch: Partial<typeof users.$inferInsert>,
  executor: Executor = db,
) {
  if (Object.keys(patch).length === 0) return existing;
  const [updated] = await executor.update(users).set(patch).where(eq(users.id, existing.id)).returning();
  return updated;
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code ?? (err as { cause?: { code?: unknown } })?.cause?.code;
  return code === '23505';
}

// email/name ride the same redirect the token does — no new backend
// endpoint for the desktop (AT10) to ask "who am I" separately. Not new
// exposure: the token this same query string already carries is the
// actual bearer secret; an email and a display name are what the
// sign-in page itself showed moments earlier, on the very account this
// browser just proved control of.
function finishRedirect(flow: typeof authFlows.$inferSelect, token: string, user: typeof users.$inferSelect): string {
  // Only ever called from finishFlow's non-join branch, where
  // resolveFlowTarget guarantees this was validated as a real loopback
  // callback at flow-start time — never null there. A join-flow row
  // (redirectUri null) takes the other branch entirely.
  if (!flow.redirectUri) throw new ValidationError('this sign-in has no redirect target');
  const u = new URL(flow.redirectUri);
  u.searchParams.set('token', token);
  u.searchParams.set('state', flow.clientState);
  u.searchParams.set('email', user.email);
  u.searchParams.set('name', user.fullName);
  if (user.avatarUrl) u.searchParams.set('avatar', user.avatarUrl);
  if (flow.purpose) u.searchParams.set('for', flow.purpose);
  return u.toString();
}

// AT12 (ROAD-147). What completing a flow yields: the ordinary
// desktop-loopback shape sends the browser back to the app via a
// redirect; a join-flow row (inviteToken set) has nowhere to redirect
// to, so completion renders a confirmation page directly instead. Both
// route handlers in auth.routes.ts branch on `.kind`.
export type FlowCompletion = { kind: 'redirect'; to: string } | { kind: 'html'; body: string };

async function finishFlow(
  flow: typeof authFlows.$inferSelect,
  identity: ResolvedIdentity,
  deps: FlowDeps,
): Promise<FlowCompletion> {
  if (flow.inviteToken) {
    // Ninth-round review finding: resolving/creating the user and
    // accepting the invite used to be two separate, uncommitted-together
    // statements — a users row (and its signup-mode bypass) committed
    // even when acceptInvite failed immediately afterward (the invite
    // already consumed by a concurrent completion, expired mid-flow,
    // etc.), leaving a real account that could then sign in normally
    // forever, invite-only or not. One transaction: if acceptInvite
    // throws, the user (and session) this same flow just created rolls
    // back with it — a join either fully succeeds or leaves nothing
    // behind, not a real account with no membership.
    const inviteToken = flow.inviteToken;
    return db.transaction(async (tx) => {
      const { user } = await resolveOrCreateUser(identity, deps, { skipSignupModeCheck: true }, tx);
      await issueSession(user.id, { now: deps.now() }, tx);
      // acceptInvite re-validates the invite from scratch (expiry, not
      // already accepted) rather than trusting resolveFlowTarget's
      // earlier check — a link can expire or get consumed by someone
      // else during the OAuth round trip in between.
      const { workspace } = await acceptInvite(inviteToken, user, tx);
      return { kind: 'html', body: renderJoinCompletePage(workspace.name) };
    });
  }
  const { user } = await resolveOrCreateUser(identity, deps);
  const { token } = await issueSession(user.id, { now: deps.now() });
  return { kind: 'redirect', to: finishRedirect(flow, token, user) };
}

// ---- OAuth -----------------------------------------------------------------

export async function startOAuth(
  provider: 'github' | 'google',
  args: { redirectUri?: string; clientState?: string; purpose?: string; inviteToken?: string },
  deps: FlowDeps,
): Promise<string> {
  if (!configuredAuthMethods(deps.env).includes(provider)) {
    throw new ValidationError(`${provider} sign-in is not configured on this instance`);
  }
  const creds = oauthCredentials(provider, deps.env)!;
  const { redirectUri, clientState } = await resolveFlowTarget(args);
  const { secret } = await createFlow(
    provider,
    { redirectUri, clientState, purpose: purposeOf(args.purpose), inviteToken: args.inviteToken },
    deps,
  );
  return oauthProviders[provider].authorizeUrl({
    clientId: creds.clientId,
    redirectUri: `${deps.publicBaseUrl}/auth/${provider}/callback`,
    state: secret,
  });
}

// Returns the desktop redirect to send the browser to, or (a join flow) a
// page to render directly. Throws on a bad or reused state, a failed
// exchange, an invite-only refusal, or an invite that died mid-flow — the
// route renders those as a page, since a browser is what's on the other
// end either way.
export async function completeOAuth(
  provider: 'github' | 'google',
  args: { code?: string; state?: string; error?: string },
  deps: FlowDeps,
): Promise<FlowCompletion> {
  if (args.error) throw new ValidationError(`${provider} refused the sign-in: ${args.error}`);
  if (!args.state || !args.code) throw new ValidationError('missing code or state');
  const flow = await consumeFlow(provider, args.state, deps);
  const creds = oauthCredentials(provider, deps.env);
  if (!creds) throw new ValidationError(`${provider} sign-in is not configured on this instance`);
  const identity: ProviderIdentity = await oauthProviders[provider].exchange(
    { ...creds, redirectUri: `${deps.publicBaseUrl}/auth/${provider}/callback`, code: args.code },
    deps.fetch,
  );
  return finishFlow(flow, identity, deps);
}

// ---- Email magic link ------------------------------------------------------

export async function startEmailLink(
  args: { email?: string; redirectUri?: string; clientState?: string; purpose?: string; inviteToken?: string },
  deps: FlowDeps,
): Promise<{ sentTo: string }> {
  if (!configuredAuthMethods(deps.env).includes('email') || !deps.mailer) {
    throw new ValidationError('Email sign-in is not configured on this instance');
  }
  const email = args.email?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError('a valid email is required');
  const { redirectUri, clientState } = await resolveFlowTarget(args);
  const { secret } = await createFlow(
    'email',
    { redirectUri, clientState, purpose: purposeOf(args.purpose), email, inviteToken: args.inviteToken },
    deps,
  );
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

export async function completeEmailLink(args: { token?: string }, deps: FlowDeps): Promise<FlowCompletion> {
  if (!args.token) throw new ValidationError('missing token');
  const flow = await consumeFlow('email', args.token, deps);
  if (!flow.email) throw new ValidationError('malformed sign-in link');
  return finishFlow(
    flow,
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
}
