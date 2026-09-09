import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';

// createTicket's sequenceId allocation (ROAD-38) relies on real Postgres
// semantics this file's mocked-Drizzle sibling (tickets.service.test.ts,
// which vi.mock()s Drizzle's query builder wholesale) cannot exercise: an
// atomic UPDATE...RETURNING against projects.next_sequence_id, and — the
// bug this file exists to catch — whether a deleted ticket's number can
// still be minted again for a later, unrelated ticket. A mock can only
// assert which query shape this file BUILDS; only a real database, with
// real deletes, can prove a retired identifier stays retired. Same
// rationale, and same skip-when-unreachable shape, as
// proposals.service.integration.test.ts / ticketRefs.service.integration.test.ts.
async function databaseReachable(): Promise<boolean> {
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  const probe = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await probe`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 3 });
  }
}

const REAL_DB = await databaseReachable();

describe.skipIf(!REAL_DB)('createTicket sequenceId allocation against real Postgres', () => {
  let service: typeof import('./tickets.service.js');
  let db: typeof import('../db/client.js')['db'];
  let schema: typeof import('../db/schema/index.js');
  let eq: typeof import('drizzle-orm')['eq'];

  // Everything this file writes hangs off one workspace id, so afterAll's
  // single delete reclaims it all through the FK cascade (workspace ->
  // project -> ticket_states/tickets) — this runs against the developer's
  // own dev database, not a disposable one, and must not leave rows behind.
  const workspaceId = `ws-itest-${Date.now()}`;
  const projectId = `proj-itest-${Date.now()}`;
  const stateId = `st-itest-${Date.now()}`;

  beforeAll(async () => {
    // Dynamic, not top-level: db/client.ts throws on import when
    // DATABASE_URL is unset, which would fail this file instead of skipping it.
    ({ db } = await import('../db/client.js'));
    service = await import('./tickets.service.js');
    schema = await import('../db/schema/index.js');
    ({ eq } = await import('drizzle-orm'));

    await db.insert(schema.workspaces).values({
      id: workspaceId,
      name: 'ROAD-38 integration test workspace',
      slug: workspaceId,
      companySize: '2-10',
      timezone: 'UTC',
    });
    await db.insert(schema.projects).values({
      id: projectId,
      workspaceId,
      name: 'ROAD-38 integration test project',
      identifier: 'RIT',
      icon: 'folder',
      coverGradientStart: '#000000',
      coverGradientEnd: '#ffffff',
      timezone: 'UTC',
      automations: {},
    });
    await db.insert(schema.ticketStates).values({
      id: stateId,
      projectId,
      name: 'Todo',
      group: 'unstarted',
      color: '#000000',
      isDefault: true,
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  });

  it('never reuses a deleted ticket\'s sequenceId/identifier for a later, unrelated ticket', async () => {
    const first = await service.createTicket({ projectId, title: 'First ticket', stateId });
    const second = await service.createTicket({ projectId, title: 'Second ticket', stateId });

    expect(first!.sequenceId).toBe(1);
    expect(first!.identifier).toBe('RIT-1');
    expect(second!.sequenceId).toBe(2);
    expect(second!.identifier).toBe('RIT-2');

    // Delete the second ticket — MAX(sequenceId) over the surviving rows
    // is now 1 again, which is exactly the trap the old derivation fell into.
    await service.deleteTicket(second!.id);

    const third = await service.createTicket({ projectId, title: 'Third ticket', stateId });

    // The third ticket must continue from the persistent counter (3), never
    // reuse RIT-2 — the identifier a git commit, Slack link, or bookmark
    // might still reference for the now-deleted second ticket.
    expect(third!.sequenceId).toBe(3);
    expect(third!.identifier).toBe('RIT-3');
    expect(third!.identifier).not.toBe(second!.identifier);

    // Read the counter back through a fresh query, so the assertion is
    // about what Postgres actually stored, not about a service return value.
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
    expect(project.nextSequenceId).toBe(3);
  });

  it('keeps allocating past a whole run of deletions, never dropping back to a lower, previously-used number', async () => {
    const a = await service.createTicket({ projectId, title: 'A', stateId });
    const b = await service.createTicket({ projectId, title: 'B', stateId });
    const c = await service.createTicket({ projectId, title: 'C', stateId });

    await service.deleteTicket(a!.id);
    await service.deleteTicket(b!.id);
    await service.deleteTicket(c!.id);

    // Every prior ticket in this project is now gone — MAX(sequenceId) over
    // existing rows would be undefined/0, which is exactly what would let
    // the old derivation restart numbering from 1.
    const d = await service.createTicket({ projectId, title: 'D', stateId });

    expect(d!.sequenceId).toBeGreaterThan(c!.sequenceId);
    expect([a!.identifier, b!.identifier, c!.identifier]).not.toContain(d!.identifier);
  });

  // Caught in review, and reproduced against a real disposable Postgres
  // before this fix landed: db/seed.ts bulk-inserts its demo tickets
  // directly via tx.insert(schema.tickets) — the same bypass-createTicket
  // shape this test replicates below — which never touched
  // projects.nextSequenceId, left at its schema default of 0. The very
  // first ticket created through the app after a real `npm run db:seed`
  // then collided with the seed data's own CW-1/PL-1 on the identifier's
  // unique constraint, and every create after that kept failing forever —
  // a failed insert rolls the whole transaction back before the counter
  // could ever advance, so it never self-healed. seed.ts now backfills
  // projects.nextSequenceId to the highest sequenceId it just inserted,
  // once, right after the bulk insert — this test proves that pattern
  // actually closes the gap, without calling the real seed() function
  // itself (which truncates every table and would destroy whatever real
  // data this integration suite's target database holds).
  it('lets a ticket be created after a seed-style bulk insert, once the seeded project\'s counter is backfilled', async () => {
    // Own project, not the describe block's shared one — the shared project
    // already has real tickets from the tests above by the time this one
    // runs (RIT-1/2/3, A/B/C/D), so a hardcoded low identifier here would
    // collide with THEIR rows, not with the bug this test exists to prove.
    const seedProjectId = `proj-itest-seed-${Date.now()}`;
    const seedStateId = `st-itest-seed-${Date.now()}`;
    const seedTicketId = `wi-seedstyle-${Date.now()}`;
    await db.insert(schema.projects).values({
      id: seedProjectId,
      workspaceId,
      name: 'ROAD-38 seed-backfill integration test project',
      identifier: 'SBK',
      icon: 'folder',
      coverGradientStart: '#000000',
      coverGradientEnd: '#ffffff',
      timezone: 'UTC',
      automations: {},
    });
    await db.insert(schema.ticketStates).values({
      id: seedStateId,
      projectId: seedProjectId,
      name: 'Todo',
      group: 'unstarted',
      color: '#000000',
      isDefault: true,
    });

    // Mirrors seed.ts's own tx.insert(schema.tickets).values(...) shape: a
    // direct insert bypassing createTicket(), so the persistent counter is
    // never touched by this statement — exactly the seed.ts bug.
    await db.insert(schema.tickets).values({
      id: seedTicketId,
      projectId: seedProjectId,
      identifier: 'SBK-1',
      sequenceId: 1,
      stateId: seedStateId,
      title: 'Bulk-inserted, seed-style',
      createdById: 'mem-1',
    });

    const [beforeBackfill] = await db.select().from(schema.projects).where(eq(schema.projects.id, seedProjectId));
    expect(beforeBackfill.nextSequenceId).toBe(0);

    // The fix under test: seed.ts's own backfill statement, reproduced
    // verbatim rather than invoked, since the real seed() is destructive.
    await db.update(schema.projects).set({ nextSequenceId: 1 }).where(eq(schema.projects.id, seedProjectId));

    const afterSeed = await service.createTicket({
      projectId: seedProjectId,
      title: 'Created after a seed-style bulk insert',
      stateId: seedStateId,
    });

    expect(afterSeed!.sequenceId).toBe(2);
    expect(afterSeed!.identifier).toBe('SBK-2');
    expect(afterSeed!.identifier).not.toBe('SBK-1');
  });
});
