import { and, eq, gt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sessions, users } from '../db/schema/index.js';
import { newId } from '../lib/ids.js';
import { hashSecret, newSecret } from './tokens.js';

// AT9 (ROAD-144). Opaque bearer sessions. A session belongs to a user, not
// a member — one sign-in, any number of workspace memberships (spec §3).
// AT11's middleware calls resolveSession on every request that carries a
// bearer token; nothing in this ticket attaches req.user yet.

// 90 days: long enough that a laptop used weekly never re-prompts, short
// enough that a lost machine's session dies on its own. Not configurable
// yet — a knob nobody has asked for is a knob nobody has tested.
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Executor = typeof db | Tx;

export async function issueSession(
  userId: string,
  opts: { deviceLabel?: string | null; now?: Date } = {},
  tx: Executor = db,
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const now = opts.now ?? new Date();
  const token = newSecret();
  const sessionId = newId('sess');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await tx.insert(sessions).values({
    id: sessionId,
    userId,
    tokenHash: hashSecret(token),
    createdAt: now,
    expiresAt,
    lastSeenAt: now,
    deviceLabel: opts.deviceLabel ?? null,
  });
  return { token, sessionId, expiresAt };
}

// Null for unknown, expired, or a token whose user is gone (cascade). The
// caller decides whether that is a 401 or "not signed in".
export async function resolveSession(token: string, now: Date = new Date()) {
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashSecret(token)), gt(sessions.expiresAt, now)));
  if (!row) return null;
  return row;
}

export async function revokeSession(token: string): Promise<boolean> {
  const rows = await db.delete(sessions).where(eq(sessions.tokenHash, hashSecret(token))).returning({ id: sessions.id });
  return rows.length > 0;
}

// Touch lastSeenAt at most once per interval so the Devices list is
// roughly current without a write on every request.
export const LAST_SEEN_INTERVAL_MS = 15 * 60 * 1000;
export async function touchSession(sessionId: string, lastSeenAt: Date | null, now: Date = new Date()) {
  if (lastSeenAt && now.getTime() - lastSeenAt.getTime() < LAST_SEEN_INTERVAL_MS) return;
  await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, sessionId));
}
