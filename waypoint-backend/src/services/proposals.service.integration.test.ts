import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';

// The ONE proposals test that talks to real Postgres, and it exists for a
// specific reason: every other proposals test mocks Drizzle (see the header
// comments in proposals.service.test.ts / proposals.reviewQueue.service.test.ts),
// so 500 passing tests could not see that proposals.project_id was NOT NULL
// while createProposal legitimately resolves NULL for a Jira ("tref-") ticket.
// That combination broke every Copilot proposal against a Jira issue in
// production with a 23502, and a mocked db is structurally incapable of
// catching it — only the real column constraint can. Anything provable
// against mocks still belongs in those files; this one is deliberately thin.
//
// Skipped, not failed, when there's no reachable database: the default suite
// has always run without Docker up, and this file must not change that.
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

describe.skipIf(!REAL_DB)('proposals against real Postgres', () => {
  let service: typeof import('./proposals.service.js');
  let db: typeof import('../db/client.js')['db'];
  let schema: typeof import('../db/schema/index.js');
  let sql: typeof import('drizzle-orm')['sql'];
  let eq: typeof import('drizzle-orm')['eq'];

  // Everything this file writes hangs off one conversation id, so afterAll's
  // single delete reclaims it all through the FK cascade — this runs against
  // the developer's own dev database, not a disposable one, and must not
  // leave rows behind.
  const conversationId = `conv-itest-${Date.now()}`;
  // A project id that exists nowhere: the point of the filter assertions is
  // that a NULL-project row is excluded by ANY specific project filter, and
  // borrowing a real seeded project's id would let unrelated seed rows drift
  // into the assertion.
  const nativeProjectId = `proj-itest-${Date.now()}`;
  const jiraTicketId = 'tref-ITEST-1';
  let jiraProposalId: string;
  let nativeProposalId: string;

  beforeAll(async () => {
    // Dynamic, not top-level: db/client.ts throws on import when
    // DATABASE_URL is unset, which would fail this file instead of skipping it.
    ({ db } = await import('../db/client.js'));
    service = await import('./proposals.service.js');
    schema = await import('../db/schema/index.js');
    ({ sql, eq } = await import('drizzle-orm'));

    await db.insert(schema.copilotConversations).values({
      id: conversationId,
      memberId: 'mem-1',
      title: 'proposals integration test',
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(schema.copilotConversations).where(eq(schema.copilotConversations.id, conversationId));
  });

  it('accepts a proposal whose ticket is a Jira issue, storing a null project', async () => {
    // The exact shape that failed live on ENG-4: a comment proposal whose
    // ticketId is an external ref. createProposal's correlated subquery finds
    // no `tickets` row for a "tref-" id and so resolves NULL — correct, because
    // a Jira issue belongs to a Jira project, not to a `projects` row. Before
    // 0010 this line raised PostgresError 23502 rather than returning a row.
    const row = await service.createProposal({
      conversationId,
      kind: 'comment',
      ticketId: jiraTicketId,
      payload: { body: 'Integration test comment.' },
      snapshot: { ticketIdentifier: 'ENG-4', ticketTitle: 'A Jira issue' },
    });
    jiraProposalId = row.id;

    expect(row.projectId).toBeNull();
    expect(row.ticketId).toBe(jiraTicketId);

    // Read it back through a fresh query, so the assertion is about what
    // Postgres actually stored and not about the INSERT ... RETURNING value.
    const [persisted] = await db
      .select()
      .from(schema.proposals)
      .where(eq(schema.proposals.id, jiraProposalId));
    expect(persisted.projectId).toBeNull();
  });

  it('has project_id as a genuinely nullable column, not merely an unwritten one', async () => {
    // Asserts the migration itself, not the service: if 0010 were reverted or
    // never applied, the test above would fail with a constraint violation and
    // this one would name the reason directly.
    const [column] = await db.execute<{ is_nullable: string }>(
      sql`select is_nullable from information_schema.columns
          where table_name = 'proposals' and column_name = 'project_id'`,
    );
    expect(column.is_nullable).toBe('YES');
  });

  it('excludes a null-project proposal from a specific project filter but not from the unfiltered queue', async () => {
    // A second, project-scoped proposal on the same conversation, inserted
    // directly: this test is about listReviewQueue's filter semantics over
    // rows that differ only in project_id, and going through createProposal
    // would require seeding a whole native ticket to say the same thing.
    nativeProposalId = `prop-itest-${Date.now()}`;
    await db.insert(schema.proposals).values({
      id: nativeProposalId,
      origin: 'copilot',
      conversationId,
      kind: 'comment',
      ticketId: 'tk-itest-1',
      payload: { body: 'Integration test comment.' },
      snapshot: {},
      projectId: nativeProjectId,
      expiresAt: new Date(Date.now() + service.PROPOSAL_TTL_MS),
    });

    // limit is pinned above the dev database's own row count so paging can
    // never be what makes an id absent from either result.
    const unfiltered = await service.listReviewQueue({ status: 'proposed', limit: 100 });
    const unfilteredIds = unfiltered.proposals.map((p) => p.id);
    expect(unfilteredIds).toContain(jiraProposalId);
    expect(unfilteredIds).toContain(nativeProposalId);
    // The view type has to carry the null through, not coerce it to '' or drop it.
    expect(unfiltered.proposals.find((p) => p.id === jiraProposalId)?.projectId).toBeNull();

    const filtered = await service.listReviewQueue({
      status: 'proposed',
      projectId: nativeProjectId,
      limit: 100,
    });
    const filteredIds = filtered.proposals.map((p) => p.id);
    expect(filteredIds).toContain(nativeProposalId);
    // The intended behaviour, not a gap: a Jira proposal is in no Waypoint
    // project, so it belongs only to the "All projects" view.
    expect(filteredIds).not.toContain(jiraProposalId);
  });
});
