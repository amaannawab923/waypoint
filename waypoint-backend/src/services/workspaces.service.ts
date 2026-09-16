import { eq, and, isNull, gt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { workspaces, members, users, workspaceInvites } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { NotFoundError } from '../middleware/errors.js';
import { currentMemberId, currentWorkspaceId } from '../lib/requestContext.js';
import { hashSecret, newSecret } from '../auth/tokens.js';

// AT12 (ROAD-147). Team workspace creation + the switcher's own listing —
// spec §7 steps 6/8/11. Distinct from the existing singular
// workspace.service.ts, which only ever reads/writes the CALLER's current
// workspace (workspaceGuard-scoped, req.member required); nothing here can
// use that — creating a workspace and listing "every workspace I belong
// to" both run before any single workspace is the caller's context.
// Callers sit behind middleware/auth.ts's requireUser, not resolveMember.

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
async function uniqueSlug(tx: Tx, base: string): Promise<string> {
  let candidate = base;
  let suffix = 1;
  for (;;) {
    const [existing] = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, candidate));
    if (!existing) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`;
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
        email: user.email,
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
export async function createInvite(workspaceId: string, input: CreateInviteInput) {
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
  // second one for the same person.
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
export async function acceptInvite(token: string, user: AuthedUser) {
  const now = new Date();
  const [invite] = await db
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

  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, invite.workspaceId));
  if (!workspace) throw new NotFoundError('workspace');

  // Claim-or-create (decision 4): a pending row from "Email invite
  // instead" (userId null, matching email) gets claimed; a row that
  // already has a userId means this person already joined (re-opening an
  // old link) and this is a no-op, not an error; otherwise a fresh row.
  // The insert can still race a second invite for the same
  // (workspaceId, email) accepted concurrently — members_workspace_id_
  // email_unique is the real guard; a losing insert here re-reads and
  // claims the winner's row instead of failing the whole acceptance.
  const email = user.email.trim().toLowerCase();
  const member = await claimOrCreateMember(invite.workspaceId, email, user);
  return { workspace, member };
}

async function claimOrCreateMember(workspaceId: string, email: string, user: AuthedUser): Promise<typeof members.$inferSelect> {
  const [existing] = await db
    .select()
    .from(members)
    .where(and(eq(members.workspaceId, workspaceId), eq(members.email, email)));
  if (existing && !existing.userId) {
    const [claimed] = await db.update(members).set({ userId: user.id }).where(eq(members.id, existing.id)).returning();
    return claimed;
  }
  if (existing) return existing;
  try {
    const [created] = await db
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
    if (isUniqueViolation(err)) return claimOrCreateMember(workspaceId, email, user);
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code ?? (err as { cause?: { code?: unknown } })?.cause?.code;
  return code === '23505';
}
