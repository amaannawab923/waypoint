import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';

// The agent-runs ledger's properties that only a real database can prove
// (ROAD-53/54/56): the row lock that mints `seq`, the FK from
// proposals.agent_run_id, the enum, the status machine refusing inside a
// transaction and leaving nothing behind. Same posture as the other
// *.integration.test.ts files: skipped, not failed, without DATABASE_URL.
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

describe.skipIf(!REAL_DB)('agent runs against real Postgres', () => {
  let service: typeof import('./agentRuns.service.js');
  let db: typeof import('../db/client.js')['db'];
  let schema: typeof import('../db/schema/index.js');
  let eq: typeof import('drizzle-orm')['eq'];
  let asc: typeof import('drizzle-orm')['asc'];
  let sql: typeof import('drizzle-orm')['sql'];

  const stamp = Date.now();
  const workspaceId = `ws-runs-${stamp}`;
  const memberId = `mem-runs-${stamp}`;
  const projectId = `proj-runs-${stamp}`;
  const stateId = `st-runs-${stamp}`;
  const ticketId = `wi-runs-${stamp}`;
  const conversationId = `conv-runs-${stamp}`;

  const base = () => ({
    projectId,
    ticketId,
    ownerMemberId: memberId,
    entry: 'dispatched' as const,
    providerId: 'claude',
  });

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));
    service = await import('./agentRuns.service.js');
    schema = await import('../db/schema/index.js');
    ({ eq, asc, sql } = await import('drizzle-orm'));

    await db.insert(schema.workspaces).values({
      id: workspaceId,
      name: 'ROAD-53 integration test workspace',
      slug: workspaceId,
      companySize: '2-10',
      timezone: 'UTC',
    });
    await db.insert(schema.members).values({
      id: memberId,
      workspaceId,
      fullName: 'Runs Tester',
      displayName: 'Runs',
      email: `${memberId}@example.test`,
      avatarColor: '#000000',
    });
    await db.insert(schema.projects).values({
      id: projectId,
      workspaceId,
      name: 'ROAD-53 integration test project',
      identifier: 'RUN',
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
    await db.insert(schema.tickets).values({
      id: ticketId,
      projectId,
      identifier: `RUN-${stamp}`,
      sequenceId: 1,
      title: 'A ticket with runs',
      stateId,
      createdById: memberId,
    });
  });

  afterAll(async () => {
    // This is the developer's own dev database, not a disposable one.
    // Explicit order, innermost first: tickets and runs both `restrict`
    // on members, so a bare workspace delete would trip on its own
    // cascade. The project delete cascades runs, events and states.
    await db.delete(schema.proposals).where(eq(schema.proposals.projectId, projectId));
    await db.delete(schema.tickets).where(eq(schema.tickets.projectId, projectId));
    await db.delete(schema.projects).where(eq(schema.projects.id, projectId));
    await db.delete(schema.copilotConversations).where(eq(schema.copilotConversations.id, conversationId));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  });

  it('createRun writes the row queued with a `created` event at seq 1', async () => {
    const run = await service.createRun(base());

    expect(run.id).toMatch(/^run-/);
    expect(run.status).toBe('queued');
    expect(run.startedAt).toBeNull();
    const events = await service.listEvents(run.id);
    expect(events.map((e) => [e.seq, e.kind])).toEqual([[1, 'created']]);
    expect(events[0].payload).toMatchObject({ entry: 'dispatched', providerId: 'claude', ticketId });
  });

  it('walks the machine, stamping startedAt on first running and endedAt on terminal, one event per move', async () => {
    const run = await service.createRun(base());

    const provisioning = await service.updateRun(run.id, { status: 'provisioning' });
    expect(provisioning.startedAt).toBeNull();
    const running = await service.updateRun(run.id, {
      status: 'running',
      daemonSessionId: 'sess-1',
      worktreePath: '/tmp/wt',
      branch: 'agent/RUN-1',
    });
    expect(running.startedAt).not.toBeNull();
    expect(running.daemonSessionId).toBe('sess-1');
    const blocked = await service.updateRun(run.id, {
      status: 'blocked',
      blockedReason: 'Wants to run `npm test`',
    });
    expect(blocked.blockedReason).toBe('Wants to run `npm test`');
    const back = await service.updateRun(run.id, { status: 'running', reason: 'user allowed' });
    // Leaving blocked clears the reason; startedAt is first-entry only.
    expect(back.blockedReason).toBeNull();
    expect(back.startedAt?.getTime()).toBe(running.startedAt?.getTime());
    await service.updateRun(run.id, { status: 'finishing' });
    const done = await service.updateRun(run.id, { status: 'done', summary: 'Opened a PR.' });
    expect(done.endedAt).not.toBeNull();
    expect(done.summary).toBe('Opened a PR.');

    const events = await service.listEvents(run.id);
    expect(events.map((e) => [e.seq, e.kind])).toEqual([
      [1, 'created'],
      [2, 'status_changed'],
      [3, 'status_changed'],
      [4, 'status_changed'],
      [5, 'status_changed'],
      [6, 'status_changed'],
      [7, 'status_changed'],
    ]);
    expect(events[4].payload).toEqual({ from: 'blocked', to: 'running', reason: 'user allowed' });
    expect(events[3].payload).toMatchObject({ from: 'running', to: 'blocked', blockedReason: 'Wants to run `npm test`' });
  });

  it('refuses an illegal move with a 409 sentence and writes nothing — not even the field patch', async () => {
    const run = await service.createRun(base());
    await service.updateRun(run.id, { status: 'provisioning' });
    await service.updateRun(run.id, { status: 'running' });

    await expect(service.updateRun(run.id, { status: 'done', summary: 'should not land' })).rejects.toThrow(
      'A running run cannot become done; it can become blocked, finishing, interrupted, failed, cancelled.',
    );

    const after = await service.getRun(run.id);
    expect(after?.status).toBe('running');
    expect(after?.summary).toBeNull();
    const events = await service.listEvents(run.id);
    expect(events).toHaveLength(3); // created + two moves
  });

  it('a status-only patch to the current status is an idempotent no-op, not a 409', async () => {
    const run = await service.createRun(base());
    const again = await service.updateRun(run.id, { status: 'queued' });
    expect(again.status).toBe('queued');
    expect(await service.listEvents(run.id)).toHaveLength(1);
  });

  it('mints consecutive, unique seqs under concurrent appends', async () => {
    const run = await service.createRun(base());

    const appended = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        service.appendEvent(run.id, { kind: 'note', payload: { i } }),
      ),
    );

    const seqs = appended.map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => i + 2)); // 1 is `created`
    const stored = await db
      .select()
      .from(schema.agentRunEvents)
      .where(eq(schema.agentRunEvents.runId, run.id))
      .orderBy(asc(schema.agentRunEvents.seq));
    expect(stored).toHaveLength(13);
  });

  it('appendEvent on an unknown run is a 404, not an FK error', async () => {
    await expect(service.appendEvent('run-nope', { kind: 'note' })).rejects.toThrow('agent run not found');
  });

  it('a retry is a new row naming the first, and only a finished or interrupted run can be retried', async () => {
    const first = await service.createRun(base());
    await service.updateRun(first.id, { status: 'provisioning' });
    await service.updateRun(first.id, { status: 'running', worktreePath: '/tmp/first' });

    await expect(service.createRun({ ...base(), retryOfRunId: first.id })).rejects.toThrow(
      `Run ${first.id} is running; only a finished or interrupted run can be retried.`,
    );

    await service.updateRun(first.id, { status: 'failed', errorKind: 'generic', errorMessage: 'boom' });
    const retry = await service.createRun({ ...base(), retryOfRunId: first.id });

    expect(retry.id).not.toBe(first.id);
    expect(retry.retryOfRunId).toBe(first.id);
    expect(retry.worktreePath).toBeNull();
    // The first run's evidence is untouched (ROAD-56: rows, not upserts).
    const firstAfter = await service.getRun(first.id);
    expect(firstAfter?.worktreePath).toBe('/tmp/first');
    expect(firstAfter?.status).toBe('failed');
    // And the ticket lists both, newest first.
    const forTicket = await service.listRunsForTicket(ticketId);
    const ids = forTicket.map((r) => r.id);
    expect(ids.indexOf(retry.id)).toBeLessThan(ids.indexOf(first.id));
  });

  it('a proposal can point at a run, and deleting the run leaves the proposal with a null run id', async () => {
    const run = await service.createRun(base());
    await db.insert(schema.copilotConversations).values({ id: conversationId, memberId, title: 'runs itest' });
    const proposalId = `prop-runs-${stamp}`;
    await db.insert(schema.proposals).values({
      id: proposalId,
      origin: 'agent_run',
      agentRunId: run.id,
      kind: 'comment',
      ticketId,
      projectId,
      payload: { body: 'from a run' },
      snapshot: {},
      status: 'proposed',
      disclosureText: '',
      expiresAt: new Date(Date.now() + 60_000),
    });

    // A nonexistent run is refused by the FK — the reason the FK exists.
    await expect(
      db.insert(schema.proposals).values({
        id: `${proposalId}-bad`,
        origin: 'agent_run',
        agentRunId: 'run-does-not-exist',
        kind: 'comment',
        ticketId,
        projectId,
        payload: { body: 'orphan' },
        snapshot: {},
        status: 'proposed',
        disclosureText: '',
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23503' }) });

    await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
    const [proposal] = await db.select().from(schema.proposals).where(eq(schema.proposals.id, proposalId));
    expect(proposal).toBeDefined();
    expect(proposal.agentRunId).toBeNull();
    // Its events went with the run.
    expect(await db.select().from(schema.agentRunEvents).where(eq(schema.agentRunEvents.runId, run.id))).toEqual([]);
  });

  it('pages newest-first by (created_at, id) with a cursor and filters by status list', async () => {
    const owner = `mem-page-${stamp}`;
    await db.insert(schema.members).values({
      id: owner,
      workspaceId,
      fullName: 'Pager',
      displayName: 'Pager',
      email: `${owner}@example.test`,
      avatarColor: '#000000',
    });
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await service.createRun({ ...base(), ownerMemberId: owner, entry: 'independent', ticketId: null });
      made.push(r.id);
    }
    await service.updateRun(made[0], { status: 'cancelled' });

    const page1 = await service.listRuns({ ownerMemberId: owner, limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await service.listRuns({ ownerMemberId: owner, limit: 2, cursor: page1.nextCursor! });
    const page3 = await service.listRuns({ ownerMemberId: owner, limit: 2, cursor: page2.nextCursor! });
    const all = [...page1.items, ...page2.items, ...page3.items].map((r) => r.id);
    expect(all).toHaveLength(5);
    expect(new Set(all).size).toBe(5);
    expect(all).toEqual([...made].reverse());
    expect(page3.nextCursor).toBeNull();

    const queuedOnly = await service.listRuns({ ownerMemberId: owner, status: ['queued'] });
    expect(queuedOnly.items.map((r) => r.id)).not.toContain(made[0]);
    expect(queuedOnly.items).toHaveLength(4);
    await expect(service.listRuns({ ownerMemberId: owner, cursor: 'not-a-cursor' })).rejects.toThrow('invalid cursor');
  });

  it('a finished run is read-only: a field patch is refused and nothing lands; an idempotent status retry still passes', async () => {
    const run = await service.createRun(base());
    await service.updateRun(run.id, { status: 'cancelled' });

    await expect(service.updateRun(run.id, { worktreePath: '/other', summary: 'rewritten' })).rejects.toThrow(
      'A cancelled run is finished; its record is read-only.',
    );
    const again = await service.updateRun(run.id, { status: 'cancelled' });

    expect(again.status).toBe('cancelled');
    expect(again.summary).toBeNull();
    expect(again.worktreePath).toBeNull();
  });

  it('a blocked run asking a second question gets a blocked_reason_changed event without a transition', async () => {
    const run = await service.createRun(base());
    await service.updateRun(run.id, { status: 'provisioning' });
    await service.updateRun(run.id, { status: 'running' });
    await service.updateRun(run.id, { status: 'blocked', blockedReason: 'first question' });

    await service.updateRun(run.id, { status: 'blocked', blockedReason: 'second question' });

    const events = await service.listEvents(run.id);
    const last = events[events.length - 1];
    expect(last.kind).toBe('blocked_reason_changed');
    expect(last.payload).toEqual({ from: 'first question', to: 'second question' });
    expect((await service.getRun(run.id))?.status).toBe('blocked');
  });

  it('retrying an interrupted run cancels it under the lock, so there is never a second live run on the ticket', async () => {
    const first = await service.createRun(base());
    await service.updateRun(first.id, { status: 'provisioning' });
    await service.updateRun(first.id, { status: 'interrupted' });

    const retry = await service.createRun({ ...base(), retryOfRunId: first.id });

    const prior = await service.getRun(first.id);
    expect(prior?.status).toBe('cancelled');
    expect(prior?.endedAt).not.toBeNull();
    const priorEvents = await service.listEvents(first.id);
    expect(priorEvents[priorEvents.length - 1].payload).toEqual({
      from: 'interrupted',
      to: 'cancelled',
      reason: 'superseded by a retry',
    });
    // The resume arrow is now closed for good.
    await expect(service.updateRun(first.id, { status: 'running' })).rejects.toThrow('is finished');
    expect(retry.retryOfRunId).toBe(first.id);
  });

  it('a retry racing a resume waits for the row lock and then sees the truth', async () => {
    const first = await service.createRun(base());
    await service.updateRun(first.id, { status: 'provisioning' });
    await service.updateRun(first.id, { status: 'interrupted' });

    // Resume and retry issued together: whichever wins the lock decides
    // the other. Either the resume lands and the retry is refused (the
    // run is running), or the retry lands and the resume is refused (the
    // run is cancelled). Never both.
    const [resume, retry] = await Promise.allSettled([
      service.updateRun(first.id, { status: 'running', reason: 'resume' }),
      service.createRun({ ...base(), retryOfRunId: first.id }),
    ]);

    const after = await service.getRun(first.id);
    if (resume.status === 'fulfilled') {
      expect(retry.status).toBe('rejected');
      expect(after?.status).toBe('running');
    } else {
      expect(retry.status).toBe('fulfilled');
      expect(after?.status).toBe('cancelled');
    }
  });

  it('refuses a run about a ticket in another project, and a retry of a run that does not exist, as 400s', async () => {
    const otherProject = `proj-other-${stamp}`;
    await db.insert(schema.projects).values({
      id: otherProject,
      workspaceId,
      name: 'other',
      identifier: 'OTH',
      icon: 'folder',
      coverGradientStart: '#000000',
      coverGradientEnd: '#ffffff',
      timezone: 'UTC',
      automations: {},
    });
    try {
      await expect(service.createRun({ ...base(), projectId: otherProject })).rejects.toThrow(
        'ticketId belongs to a different project than projectId',
      );
      await expect(service.createRun({ ...base(), retryOfRunId: 'run-nope000' })).rejects.toThrow(
        'retryOfRunId does not exist',
      );
    } finally {
      await db.delete(schema.projects).where(eq(schema.projects.id, otherProject));
    }
  });

  it('pages exactly across rows created in the same millisecond (the cursor keeps microseconds)', async () => {
    const owner = `mem-ms-${stamp}`;
    await db.insert(schema.members).values({
      id: owner,
      workspaceId,
      fullName: 'Millis',
      displayName: 'Millis',
      email: `${owner}@example.test`,
      avatarColor: '#000000',
    });
    // Three rows whose created_at differ only in microseconds.
    const at = '2026-01-01 00:00:00.123';
    const ids = ['run-msa0001', 'run-msb0002', 'run-msc0003'];
    await db.insert(schema.agentRuns).values(
      ids.map((id, i) => ({
        id,
        projectId,
        ownerMemberId: owner,
        entry: 'independent' as const,
        providerId: 'claude',
        createdAt: sql`${`${at}${String(i * 200).padStart(3, '0')}+00`}::timestamptz`,
      })),
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i += 1) {
      const page = await service.listRuns({ ownerMemberId: owner, limit: 1, cursor });
      seen.push(...page.items.map((r) => r.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(seen).toEqual([...ids].reverse());
  });

  it('caps a summary at 20,000 characters with a marker rather than refusing it', async () => {
    const run = await service.createRun(base());
    const updated = await service.updateRun(run.id, { summary: 'y'.repeat(25_000) });
    expect(updated.summary).toHaveLength(20_000);
    expect(updated.summary?.endsWith('…')).toBe(true);
  });
});
