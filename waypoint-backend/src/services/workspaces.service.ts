import { eq, and, isNull, gt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { workspaces, members, users, workspaceInvites } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { ConflictError, NotFoundError } from '../middleware/errors.js';
import { currentIdentity, currentMemberId, currentWorkspaceId } from '../lib/requestContext.js';
import { hashSecret, newSecret } from '../auth/tokens.js';

// AT12 (ROAD-147). Team workspace creation + the switcher's own listing —
// spec §7 steps 6/8/11. Distinct from the existing singular
// workspace.service.ts, which only ever reads/writes the CALLER's current
// workspace (workspaceGuard-scoped, req.member required); nothing here can
// use that — creating a workspace and listing "every workspace I belong
// to" both run before any single workspace is the caller's context.
// Callers sit behind middleware/auth.ts's requireUser, not resolveMember.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

const FOUNDING_MEMBER_COLOR = '#9c9280';

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'workspace';
}

// Numeric-suffix-on-collision, same shape as tickets.service.ts's own
// sequence handling elsewhere in this codebase — checked inside the same
// transaction as the insert below, so two workspaces racing on the same
// name still can't both win the same slug.
//
// Review finding (round 1, M5): an unbounded sequential scan here is an
// O(n) amplification per call and O(n²) across n workspaces sharing a
// name, each round trip inside an open transaction. Capped: after a
// small number of real collisions, a short random suffix replaces the
// incrementing counter, bounding the cost regardless of how many
// same-named workspaces already exist.
const SLUG_SEQUENTIAL_ATTEMPTS = 20;
async function uniqueSlug(tx: Tx, base: string): Promise<string> {
  let candidate = base;
  for (let suffix = 1; suffix <= SLUG_SEQUENTIAL_ATTEMPTS; suffix++) {
    const [existing] = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, candidate));
    if (!existing) return candidate;
    candidate = `${base}-${suffix + 1}`;
  }
  for (;;) {
    candidate = `${base}-${newSecret(4)}`;
    const [existing] = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, candidate));
    if (!existing) return candidate;
  }
}

export interface CreateWorkspaceInput {
  name: string;
}

export type AuthedUser = typeof users.$inferSelect;

// Spec §7 step 6: one field, workspace name → a workspaces row
// (isPersonal: false) and a founding admin members row for the
// already-signed-in user, in one transaction.
export async function createWorkspace(input: CreateWorkspaceInput, user: AuthedUser) {
  return db.transaction(async (tx) => {
    const slug = await uniqueSlug(tx, slugify(input.name));
    const [workspace] = await tx
      .insert(workspaces)
      .values({
        id: newId('ws'),
        name: input.name,
        slug,
        // Neither is collected at creation (mockup step 6 asks for a name
        // only) — both stay editable afterward via the existing
        // PATCH /workspace, same as any other workspace.
        companySize: '',
        timezone: 'UTC',
        isPersonal: false,
      })
      .returning();
    const [member] = await tx
      .insert(members)
      .values({
        id: newId('mem'),
        workspaceId: workspace.id,
        fullName: user.fullName,
        displayName: user.fullName,
        // Round 1 review finding (M6): lowercased, matching every other
        // member-email write this ticket makes — members_workspace_id_
        // email_unique is case-sensitive, so an inconsistently-cased
        // write here is how the same person ends up as two rows later.
        email: user.email.trim().toLowerCase(),
        avatarColor: FOUNDING_MEMBER_COLOR,
        role: 'admin',
        authMethod: user.authMethod,
        userId: user.id,
      })
      .returning();
    return { workspace, member };
  });
}

// Spec §7 step 11: the workspace switcher reads every membership row for
// the signed-in user, across however many workspaces they've joined —
// req.user.id, not req.member (there is no single "current" workspace at
// this call).
export async function listMyWorkspaces(userId: string) {
  const rows = await db
    .select({ workspace: workspaces, member: members })
    .from(members)
    .innerJoin(workspaces, eq(members.workspaceId, workspaces.id))
    .where(eq(members.userId, userId));
  return rows.map((r) => ({ ...r.workspace, myMemberId: r.member.id, myRole: r.member.role }));
}

// Lower-stakes than a session (design doc §7's own words) but still a
// real bearer secret while it's live — a week is generous for "share this
// link with a teammate" without leaving a stale, forever-valid link
// lying around in an old Slack thread.
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CreateInviteInput {
  // Only "Email invite instead" (mockup step 9) collects one — plain
  // "Copy link" creates a token with no address attached, and acceptance
  // (below) has to handle both.
  email?: string;
}

// Spec §7 step 9. `workspaceId` is a route param, not implied by the
// caller's own session — checked against currentWorkspaceId() the same
// way every id-in-URL guard in the AT11 audit works: a foreign workspace
// id 404s, it doesn't silently create an invite into someone else's
// workspace.
//
// Round 1 review finding (H3): that guard alone isn't enough here,
// unlike everywhere else it's used. resolveMember's "no Authorization
// header → Personal" fallback (correct and load-bearing for reading/
// writing a Personal install's own local data) means an UNAUTHENTICATED
// caller resolves to the seeded Personal identity — currentWorkspaceId()
// returns the real 'ws-1' constant, so `workspaceId === currentWorkspaceId()`
// trivially passes for anyone supplying "ws-1" with no credentials at
// all. Every other route this audit has scoped only ever reads or
// writes existing data under that fallback; this one MINTS a credential
// (a working invite link, and — via acceptInvite — a real users row).
// currentIdentity() being unset means "no real bearer session resolved
// this request", which this route now refuses outright rather than
// silently operating as Personal.
export async function createInvite(workspaceId: string, input: CreateInviteInput) {
  if (!currentIdentity()) throw new NotFoundError('workspace');
  if (workspaceId !== currentWorkspaceId()) throw new NotFoundError('workspace');
  const now = new Date();
  const secret = newSecret();
  const email = input.email ? input.email.trim().toLowerCase() : null;
  const [invite] = await db
    .insert(workspaceInvites)
    .values({
      id: newId('inv'),
      workspaceId,
      tokenHash: hashSecret(secret),
      email,
      createdByMemberId: currentMemberId(),
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
      createdAt: now,
    })
    .returning();
  // "Email invite instead" pre-creates the pending membership row (the
  // members.userId schema comment's "an issued invite, AT12") — decision
  // 4 in the plan: acceptInvite claims this row rather than inserting a
  // second one for the same person. Always role: 'member' — nothing in
  // this function ever lets the caller request an elevated role for an
  // invite-created row (see acceptInvite/claimOrCreateMember's own
  // comment on why an existing row with any other role is refused, not
  // claimed).
  if (email) {
    const [existing] = await db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.workspaceId, workspaceId), eq(members.email, email)));
    if (!existing) {
      const localPart = email.split('@')[0];
      await db.insert(members).values({
        id: newId('mem'),
        workspaceId,
        fullName: localPart,
        displayName: localPart,
        email,
        avatarColor: FOUNDING_MEMBER_COLOR,
        role: 'member',
        authMethod: 'email',
        userId: null,
      });
    }
  }
  return { id: invite.id, token: secret, expiresAt: invite.expiresAt };
}

// Round 1 review finding (M2): an invite had no way to be taken back —
// a departed member's outstanding links stayed live for the full TTL.
// :id checked the same way createInvite's own workspaceId is (a foreign
// workspace's invite 404s, not 403 — existence of an invite in a
// workspace you're not in is not this route's business to confirm or
// deny), and the invite itself is looked up scoped to that workspace
// too, so guessing a real invite id from a workspace you're not in
// still 404s.
export async function revokeInvite(workspaceId: string, inviteId: string): Promise<void> {
  if (!currentIdentity()) throw new NotFoundError('invite');
  if (workspaceId !== currentWorkspaceId()) throw new NotFoundError('invite');
  const [row] = await db
    .delete(workspaceInvites)
    .where(and(eq(workspaceInvites.id, inviteId), eq(workspaceInvites.workspaceId, workspaceId)))
    .returning({ id: workspaceInvites.id });
  if (!row) throw new NotFoundError('invite');
}

// The public, unauthenticated half — what GET /join/:token shows before
// anyone signs in. Deliberately minimal: a workspace name and the
// inviter's display name, nothing that could double as an existence
// oracle for anything else on the instance.
export async function getInvitePreview(token: string) {
  const now = new Date();
  const [row] = await db
    .select({ invite: workspaceInvites, workspace: workspaces })
    .from(workspaceInvites)
    .innerJoin(workspaces, eq(workspaceInvites.workspaceId, workspaces.id))
    .where(eq(workspaceInvites.tokenHash, hashSecret(token)));
  if (!row || row.invite.acceptedAt || row.invite.expiresAt < now) {
    throw new NotFoundError('invite (expired, already used, or unknown)');
  }
  let inviterName: string | null = null;
  if (row.invite.createdByMemberId) {
    const [inviter] = await db
      .select({ displayName: members.displayName })
      .from(members)
      .where(eq(members.id, row.invite.createdByMemberId));
    inviterName = inviter?.displayName ?? null;
  }
  return { workspaceName: row.workspace.name, inviterName };
}

// Spec §7 step 10 — the whole reason an invite exists. The UPDATE ...
// WHERE accepted_at IS NULL is what makes acceptance atomic and
// single-use even if the same link is opened twice at once (a two-tab
// double-click, or an attacker replaying a captured completion): only one
// caller ever wins the row.
//
// Round 1 review finding (H1/M3): the caller (auth/flows.ts's
// finishFlow) now runs this inside the SAME transaction it creates/
// resolves the signing-in user in — a failure here (the common case:
// the invite already got consumed) rolls the user creation back with
// it, rather than leaving a real, usable account behind that bypassed
// signup mode for nothing. `tx` defaults to the plain db client so any
// other caller (there are none yet) still works standalone.
export async function acceptInvite(token: string, user: AuthedUser, tx: Executor = db) {
  const now = new Date();
  const [invite] = await tx
    .update(workspaceInvites)
    .set({ acceptedAt: now, acceptedByUserId: user.id })
    .where(
      and(
        eq(workspaceInvites.tokenHash, hashSecret(token)),
        isNull(workspaceInvites.acceptedAt),
        gt(workspaceInvites.expiresAt, now),
      ),
    )
    .returning();
  if (!invite) throw new NotFoundError('invite (expired, already used, or unknown)');

  const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, invite.workspaceId));
  if (!workspace) throw new NotFoundError('workspace');

  const email = user.email.trim().toLowerCase();
  // Round 1 review finding (M1): invite.email was written at creation
  // and then never read again — an "Email invite instead" link was
  // actually a bearer credential, usable by anyone who obtained it
  // (a forward, a compromised mailbox), silently orphaning the pending
  // row it was meant to target. A "Copy link" invite (email null) still
  // accepts any signed-in identity, unchanged — that one is genuinely
  // meant to be shared.
  if (invite.email && invite.email !== email) {
    throw new ConflictError('This invite was sent to a specific email address — sign in with that address to accept it.');
  }

  // Claim-or-create (decision 4): a pending row from "Email invite
  // instead" (userId null, matching email) gets claimed; a row that
  // already has a userId means this person already joined (re-opening an
  // old link) and this is a no-op, not an error; otherwise a fresh row.
  // The insert can still race a second invite for the same
  // (workspaceId, email) accepted concurrently — members_workspace_id_
  // email_unique is the real guard; a losing insert here re-reads and
  // claims the winner's row instead of failing the whole acceptance.
  const member = await claimOrCreateMember(invite.workspaceId, email, user, tx);
  return { workspace, member };
}

async function claimOrCreateMember(
  workspaceId: string,
  email: string,
  user: AuthedUser,
  tx: Executor = db,
): Promise<typeof members.$inferSelect> {
  const [existing] = await tx
    .select()
    .from(members)
    .where(and(eq(members.workspaceId, workspaceId), eq(members.email, email)));
  if (existing && !existing.userId) {
    // Round 1 review finding (H2), the most severe one: this used to
    // claim ANY pending row with a matching email regardless of its
    // role. members.service.ts's pre-existing (and pre-AT7) inviteMember
    // lets any signed-in member create a pending row with role: 'admin'
    // — harmless on its own (a userId-less row can never authenticate,
    // resolveMember's lookup requires eq(members.userId, user.id)) until
    // something binds a real user to it. That something is this
    // function. A generic join must never be the thing that grants an
    // elevated role — createInvite above only ever pre-creates role:
    // 'member' rows, so the only way an existing pending row could carry
    // anything else is exactly the escalation path this closes.
    if (existing.role !== 'member') {
      throw new ConflictError(
        'This workspace already has a pending invitation for this email address with a different role — ask a workspace admin to resolve it before joining.',
      );
    }
    const [claimed] = await tx.update(members).set({ userId: user.id }).where(eq(members.id, existing.id)).returning();
    return claimed;
  }
  if (existing) return existing;
  try {
    const [created] = await tx
      .insert(members)
      .values({
        id: newId('mem'),
        workspaceId,
        fullName: user.fullName,
        displayName: user.fullName,
        email,
        avatarColor: FOUNDING_MEMBER_COLOR,
        role: 'member',
        authMethod: user.authMethod,
        userId: user.id,
      })
      .returning();
    return created;
  } catch (err) {
    if (isUniqueViolation(err)) return claimOrCreateMember(workspaceId, email, user, tx);
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code ?? (err as { cause?: { code?: unknown } })?.cause?.code;
  return code === '23505';
}
