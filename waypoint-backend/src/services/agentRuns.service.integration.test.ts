import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
  let inArray: typeof import('drizzle-orm')['inArray'];
  let and: typeof import('drizzle-orm')['and'];
  let runWithIdentity: typeof import('../lib/requestContext.js')['runWithIdentity'];

  const stamp = Date.now();
  const workspaceId = `ws-runs-${stamp}`;
  const memberId = `mem-runs-${stamp}`;
  const projectId = `proj-runs-${stamp}`;
  const stateId = `st-runs-${stamp}`;
  const ticketId = `wi-runs-${stamp}`;
  const conversationId = `conv-runs-${stamp}`;
  // ROAD-XXX (resume dead sessions): a dedicated ticket for the
  // reopenRun/write-once tests below, so their dispatched-and-live runs
  // never collide with the many other tests in this file that all share
  // `ticketId` above — the one-live-writer-per-ticket unique index (new,
  // same feature) enforces a real invariant those unrelated tests were
  // never written to respect.
  const resumeTicketId = `wi-resume-${stamp}`;

  const base = () => ({
    projectId,
    ticketId,
    ownerMemberId: memberId,
    entry: 'dispatched' as const,
    providerId: 'claude',
  });
  // ROAD-XXX: the reopenRun/write-once tests' own dedicated ticket (see
  // resumeTicketId above) — same shape as base(), pointed there instead.
  const resumeBase = () => ({ ...base(), ticketId: resumeTicketId });

  // AT11 (ROAD-146) third review round: createRun/updateRun now force
  // ownerMemberId to the real caller's identity (currentMemberId()) and
  // validate copilotConversationId ownership the same way, rather than
  // trusting whatever the request body claims — see agentRuns.service.ts's
  // own comment on createRun for why. This file's calls previously relied
  // on a bare service.createRun/updateRun writing the input's own
  // ownerMemberId straight through with no request context at all, which
  // outside any request falls back to Personal's CURRENT_USER_ID — not
  // this file's own real seeded `memberId` (or, for the paging test
  // below, its own second member `owner`). Wrapped in the real identity
  // each call is really acting as, so ownerMemberId keeps landing where
  // every existing assertion in this file already expects it to.
  function createRun(input: Parameters<typeof service.createRun>[0], asMemberId = memberId) {
    return runWithIdentity({ userId: `user-${asMemberId}`, memberId: asMemberId, workspaceId, role: 'admin' }, () =>
      service.createRun(input),
    );
  }
  function updateRun(id: string, input: Parameters<typeof service.updateRun>[0], asMemberId = memberId) {
    return runWithIdentity({ userId: `user-${asMemberId}`, memberId: asMemberId, workspaceId, role: 'admin' }, () =>
      service.updateRun(id, input),
    );
  }

  // Fifth review round: getRun/listRuns/listRunsForTicket/listEvents/
  // appendEvent are now ALSO workspace-scoped (previously only create/
  // update were, from the fourth round) — same reasoning, wrapped the
  // same way, so every existing call in this file keeps reaching the
  // real seeded workspace/member it always meant to instead of falling
  // back to Personal's WORKSPACE_ID outside any request context.
  function getRun(id: string, asMemberId = memberId) {
    return runWithIdentity({ userId: `user-${asMemberId}`, memberId: asMemberId, workspaceId, role: 'admin' }, () =>
      service.getRun(id),
    );
  }
  function listRuns(query: Parameters<typeof service.listRuns>[0], asMemberId = memberId) {
    return runWithIdentity({ userId: `user-${asMemberId}`, memberId: asMemberId, workspaceId, role: 'admin' }, () =>
      service.listRuns(query),
    );
  }
  function listRunsForTicket(ticketId: string, asMemberId = memberId) {
    return runWithIdentity({ userId: `user-${asMemberId}`, memberId: asMemberId, workspaceId, role: 'admin' }, () =>
      service.listRunsForTicket(ticketId),
    );
  }
  function listEvents(
    runId: string,
    options?: Parameters<typeof service.listEvents>[1],
    asMemberId = memberId,
  ) {
    return runWithIdentity({ userId: `user-${asMemberId}`, memberId: asMemberId, workspaceId, role: 'admin' }, () =>
      service.listEvents(runId, options),
    );
  }
  function appendEvent(runId: string, input: Parameters<typeof service.appendEvent>[1], asMemberId = memberId) {
    return runWithIdentity({ userId: `user-${asMemberId}`, memberId: asMemberId, workspaceId, role: 'admin' }, () =>
      service.appendEvent(runId, input),
    );
  }
  function reopenRun(id: string, reason?: string, asMemberId = memberId) {
    return runWithIdentity({ userId: `user-${asMemberId}`, memberId: asMemberId, workspaceId, role: 'admin' }, () =>
      service.reopenRun(id, reason),
    );
  }

  beforeAll(async () => {
    ({ db } = await import('../db/client.js'));
    service = await import('./agentRuns.service.js');
    schema = await import('../db/schema/index.js');
    ({ eq, asc, sql, inArray, and } = await import('drizzle-orm'));
    ({ runWithIdentity } = await import('../lib/requestContext.js'));

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
    await db.insert(schema.tickets).values({
      id: resumeTicketId,
      projectId,
      identifier: `RESUME-${stamp}`,
      sequenceId: 2,
      title: 'A ticket for the resume-dead-sessions tests',
      stateId,
      createdById: memberId,
    });
  });

  // Never-lock: createRun refuses a second *automatic dispatch* on a
  // ticket while one is queued or live — a real invariant this file's
  // shared-ticket fixtures were never written to respect (nearly every
  // test creates a dispatched run and leaves it `queued`). Each test
  // therefore leaves the shared tickets with no live dispatch. Direct on
  // the table, not through updateRun: this is fixture hygiene, not a
  // status move the trail should record.
  afterEach(async () => {
    await db
      .update(schema.agentRuns)
      .set({ status: 'cancelled', endedAt: new Date() })
      .where(
        and(
          inArray(schema.agentRuns.ticketId, [ticketId, resumeTicketId]),
          inArray(schema.agentRuns.status, ['queued', 'provisioning', 'running', 'blocked', 'finishing']),
        ),
      );
    // Likewise a publish claim (claimPublish) holds its ticket for up to
    // PUBLISH_CLAIM_TTL_MS — real behaviour, but not something one test
    // may leave for the next.
    await db.delete(schema.agentRunEvents).where(eq(schema.agentRunEvents.kind, 'publish_claimed'));
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
    const run = await createRun(base());

    expect(run.id).toMatch(/^run-/);
    expect(run.status).toBe('queued');
    expect(run.startedAt).toBeNull();
    const events = await listEvents(run.id);
    expect(events.map((e) => [e.seq, e.kind])).toEqual([[1, 'created']]);
    expect(events[0].payload).toMatchObject({ entry: 'dispatched', providerId: 'claude', ticketId });
  });

  it('walks the machine, stamping startedAt on first running and endedAt on terminal, one event per move', async () => {
    const run = await createRun(base());

    const provisioning = await updateRun(run.id, { status: 'provisioning' });
    expect(provisioning.startedAt).toBeNull();
    const running = await updateRun(run.id, {
      status: 'running',
      daemonSessionId: 'sess-1',
      worktreePath: '/tmp/wt',
      branch: 'agent/RUN-1',
    });
    expect(running.startedAt).not.toBeNull();
    expect(running.daemonSessionId).toBe('sess-1');
    const blocked = await updateRun(run.id, {
      status: 'blocked',
      blockedReason: 'Wants to run `npm test`',
    });
    expect(blocked.blockedReason).toBe('Wants to run `npm test`');
    const back = await updateRun(run.id, { status: 'running', reason: 'user allowed' });
    // Leaving blocked clears the reason; startedAt is first-entry only.
    expect(back.blockedReason).toBeNull();
    expect(back.startedAt?.getTime()).toBe(running.startedAt?.getTime());
    await updateRun(run.id, { status: 'finishing' });
    const done = await updateRun(run.id, { status: 'done', summary: 'Opened a PR.' });
    expect(done.endedAt).not.toBeNull();
    expect(done.summary).toBe('Opened a PR.');

    const events = await listEvents(run.id);
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
    const run = await createRun(base());
    await updateRun(run.id, { status: 'provisioning' });
    await updateRun(run.id, { status: 'running' });

    await expect(updateRun(run.id, { status: 'done', summary: 'should not land' })).rejects.toThrow(
      'A running run cannot become done; it can become blocked, finishing, interrupted, failed, cancelled.',
    );

    const after = await getRun(run.id);
    expect(after?.status).toBe('running');
    expect(after?.summary).toBeNull();
    const events = await listEvents(run.id);
    expect(events).toHaveLength(3); // created + two moves

    // ROAD-XXX: leave the shared ticket free — this run stayed live
    // (running) on purpose to prove the refused move above, but the new
    // one-live-writer-per-ticket index means every later test that also
    // dispatches on this shared ticket needs it actually cleared.
    await updateRun(run.id, { status: 'cancelled' });
  });

  it('a status-only patch to the current status is an idempotent no-op, not a 409', async () => {
    const run = await createRun(base());
    const again = await updateRun(run.id, { status: 'queued' });
    expect(again.status).toBe('queued');
    expect(await listEvents(run.id)).toHaveLength(1);
  });

  it('mints consecutive, unique seqs under concurrent appends', async () => {
    const run = await createRun(base());

    const appended = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        appendEvent(run.id, { kind: 'note', payload: { i } }),
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
    await expect(appendEvent('run-nope', { kind: 'note' })).rejects.toThrow('agent run not found');
  });

  it('a retry is a new row naming the first, and only a finished or interrupted run can be retried', async () => {
    const first = await createRun(base());
    await updateRun(first.id, { status: 'provisioning' });
    await updateRun(first.id, { status: 'running', worktreePath: '/tmp/first' });

    await expect(createRun({ ...base(), retryOfRunId: first.id })).rejects.toThrow(
      `Run ${first.id} is running; only a finished or interrupted run can be retried.`,
    );

    await updateRun(first.id, { status: 'failed', errorKind: 'generic', errorMessage: 'boom' });
    const retry = await createRun({ ...base(), retryOfRunId: first.id });

    expect(retry.id).not.toBe(first.id);
    expect(retry.retryOfRunId).toBe(first.id);
    expect(retry.worktreePath).toBeNull();
    // The first run's evidence is untouched (ROAD-56: rows, not upserts).
    const firstAfter = await getRun(first.id);
    expect(firstAfter?.worktreePath).toBe('/tmp/first');
    expect(firstAfter?.status).toBe('failed');
    // And the ticket lists both, newest first.
    const forTicket = await listRunsForTicket(ticketId);
    const ids = forTicket.map((r) => r.id);
    expect(ids.indexOf(retry.id)).toBeLessThan(ids.indexOf(first.id));
  });

  it('a proposal can point at a run, and deleting the run leaves the proposal with a null run id', async () => {
    const run = await createRun(base());
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
      const r = await createRun({ ...base(), ownerMemberId: owner, entry: 'independent', ticketId: null }, owner);
      made.push(r.id);
    }
    await updateRun(made[0], { status: 'cancelled' }, owner);

    const page1 = await listRuns({ ownerMemberId: owner, limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listRuns({ ownerMemberId: owner, limit: 2, cursor: page1.nextCursor! });
    const page3 = await listRuns({ ownerMemberId: owner, limit: 2, cursor: page2.nextCursor! });
    const all = [...page1.items, ...page2.items, ...page3.items].map((r) => r.id);
    expect(all).toHaveLength(5);
    expect(new Set(all).size).toBe(5);
    expect(all).toEqual([...made].reverse());
    expect(page3.nextCursor).toBeNull();

    const queuedOnly = await listRuns({ ownerMemberId: owner, status: ['queued'] });
    expect(queuedOnly.items.map((r) => r.id)).not.toContain(made[0]);
    expect(queuedOnly.items).toHaveLength(4);
    await expect(listRuns({ ownerMemberId: owner, cursor: 'not-a-cursor' })).rejects.toThrow('invalid cursor');
  });

  it('a finished run is read-only: a field patch is refused and nothing lands; an idempotent status retry still passes', async () => {
    const run = await createRun(base());
    await updateRun(run.id, { status: 'cancelled' });

    await expect(updateRun(run.id, { worktreePath: '/other', summary: 'rewritten' })).rejects.toThrow(
      'A cancelled run is finished; its record is read-only.',
    );
    const again = await updateRun(run.id, { status: 'cancelled' });

    expect(again.status).toBe('cancelled');
    expect(again.summary).toBeNull();
    expect(again.worktreePath).toBeNull();

    // W6: the pull request the host opens after the run is done is the one
    // field a finished run takes — alone, and once.
    const withPr = await updateRun(run.id, { prUrl: 'https://github.com/o/r/pull/60' });
    expect(withPr.prUrl).toBe('https://github.com/o/r/pull/60');
    await expect(updateRun(run.id, { prUrl: 'https://github.com/o/r/pull/61' })).rejects.toThrow(
      'read-only',
    );
    await expect(updateRun(run.id, { prUrl: 'https://x/pull/1', summary: 's' })).rejects.toThrow(
      'read-only',
    );
  });

  it('a blocked run asking a second question gets a blocked_reason_changed event without a transition', async () => {
    const run = await createRun(base());
    await updateRun(run.id, { status: 'provisioning' });
    await updateRun(run.id, { status: 'running' });
    await updateRun(run.id, { status: 'blocked', blockedReason: 'first question' });

    await updateRun(run.id, { status: 'blocked', blockedReason: 'second question' });

    const events = await listEvents(run.id);
    const last = events[events.length - 1];
    expect(last.kind).toBe('blocked_reason_changed');
    expect(last.payload).toEqual({ from: 'first question', to: 'second question' });
    expect((await getRun(run.id))?.status).toBe('blocked');

    // ROAD-XXX: leave the shared ticket free (see the identical note above).
    await updateRun(run.id, { status: 'cancelled' });
  });

  it('retrying an interrupted run cancels it under the lock, so there is never a second live run on the ticket', async () => {
    const first = await createRun(base());
    await updateRun(first.id, { status: 'provisioning' });
    await updateRun(first.id, { status: 'interrupted' });

    const retry = await createRun({ ...base(), retryOfRunId: first.id });

    const prior = await getRun(first.id);
    expect(prior?.status).toBe('cancelled');
    expect(prior?.endedAt).not.toBeNull();
    const priorEvents = await listEvents(first.id);
    expect(priorEvents[priorEvents.length - 1].payload).toEqual({
      from: 'interrupted',
      to: 'cancelled',
      reason: 'superseded by a retry',
    });
    // The resume arrow is now closed for good.
    await expect(updateRun(first.id, { status: 'running' })).rejects.toThrow('is finished');
    expect(retry.retryOfRunId).toBe(first.id);
  });

  it('a retry racing a resume waits for the row lock and then sees the truth', async () => {
    const first = await createRun(base());
    await updateRun(first.id, { status: 'provisioning' });
    await updateRun(first.id, { status: 'interrupted' });

    // Resume and retry issued together: whichever wins the lock decides
    // the other. Either the resume lands and the retry is refused (the
    // run is running), or the retry lands and the resume is refused (the
    // run is cancelled). Never both.
    const [resume, retry] = await Promise.allSettled([
      updateRun(first.id, { status: 'running', reason: 'resume' }),
      createRun({ ...base(), retryOfRunId: first.id }),
    ]);

    const after = await getRun(first.id);
    if (resume.status === 'fulfilled') {
      expect(retry.status).toBe('rejected');
      expect(after?.status).toBe('running');
      // ROAD-XXX: only this branch leaves the shared ticket occupied
      // (the other branch already lands on cancelled, terminal).
      await updateRun(first.id, { status: 'cancelled' });
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
      await expect(createRun({ ...base(), projectId: otherProject })).rejects.toThrow(
        'ticketId belongs to a different project than projectId',
      );
      await expect(createRun({ ...base(), retryOfRunId: 'run-nope000' })).rejects.toThrow(
        'retryOfRunId does not exist',
      );
    } finally {
      await db.delete(schema.projects).where(eq(schema.projects.id, otherProject));
    }
  });

  // W5b (ROAD-126): a run on a Jira issue names its ticket_refs handle.
  // Only the real database can prove the two facts that carry it: the FK
  // to tickets is gone (a tref id inserts), and the shape check refuses
  // anything that is neither a native id nor a ref.
  it('W5b: takes a run on a Jira ref with no project; refuses an unknown ref and a bare key', async () => {
    const [ref] = await db
      .insert(schema.ticketRefs)
      .values({
        id: `tref-runs${stamp}`,
        provider: 'jira',
        externalId: `ENG-${stamp}`,
        externalSite: 'itest.atlassian.net',
        cachedIdentifier: `ENG-${stamp}`,
        cachedTitle: 'A Jira issue with runs',
        cachedUrl: null,
        lastSeenAt: new Date(),
      })
      .returning();
    let runId: string | null = null;
    try {
      const run = await createRun({ ...base(), projectId: null, ticketId: ref.id });
      runId = run.id;
      expect(run.ticketId).toBe(ref.id);
      expect(run.projectId).toBeNull();
      expect((await listRunsForTicket(ref.id)).map((r) => r.id)).toEqual([run.id]);

      await expect(createRun({ ...base(), projectId: null, ticketId: 'tref-nope0000' })).rejects.toThrow(
        'ticketId does not exist',
      );
      // The check constraint, below the service: a bare key is not a ticket
      // id. Drizzle wraps the driver's error; the constraint is on its cause.
      const shape = await db
        .insert(schema.agentRuns)
        .values({
          id: `run-shape${stamp}`,
          ticketId: 'ENG-4',
          ownerMemberId: memberId,
          entry: 'dispatched',
          providerId: 'claude',
        })
        .then(
          () => null,
          (error: unknown) => error as { cause?: { constraint_name?: string; code?: string } },
        );
      expect(shape).not.toBeNull();
      expect(shape?.cause?.code).toBe('23514');
      expect(shape?.cause?.constraint_name).toBe('agent_runs_ticket_id_shape');
    } finally {
      if (runId) await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
      await db.delete(schema.ticketRefs).where(eq(schema.ticketRefs.id, ref.id));
    }
  });

  // ROAD-158: the Worked-on tab's own read, the reverse of listRunsForTicket
  // above — member + site to distinct Jira keys. Real-database because the
  // one thing worth proving is the join itself: a native ticket's 'wi-…' id
  // never matches a ticket_refs row, so it has to be excluded by the join
  // failing to match rather than by any filter this function writes.
  it('W5b/ROAD-158: lists a member’s own distinct Jira keys on one site, newest-worked first, excluding native-ticket runs and other members’/sites’', async () => {
    const otherMember = `mem-woj-${stamp}`;
    await db.insert(schema.members).values({
      id: otherMember,
      workspaceId,
      fullName: 'Other Worker',
      displayName: 'Other',
      email: `${otherMember}@example.test`,
      avatarColor: '#000000',
    });

    const refA = { id: `tref-woja${stamp}`, key: `WOJ-A-${stamp}` };
    const refB = { id: `tref-wojb${stamp}`, key: `WOJ-B-${stamp}` };
    const refOtherSite = { id: `tref-wojc${stamp}`, key: `WOJ-C-${stamp}` };
    const refOtherMember = { id: `tref-wojd${stamp}`, key: `WOJ-D-${stamp}` };
    const site = 'worked-on.atlassian.net';

    await db.insert(schema.ticketRefs).values([
      {
        id: refA.id,
        provider: 'jira',
        externalId: refA.key,
        externalSite: site,
        cachedIdentifier: refA.key,
        cachedTitle: 'Worked on, earlier',
        cachedUrl: null,
        lastSeenAt: new Date(),
      },
      {
        id: refB.id,
        provider: 'jira',
        externalId: refB.key,
        externalSite: site,
        cachedIdentifier: refB.key,
        cachedTitle: 'Worked on, later — two runs',
        cachedUrl: null,
        lastSeenAt: new Date(),
      },
      {
        id: refOtherSite.id,
        provider: 'jira',
        externalId: refOtherSite.key,
        externalSite: 'someone-elses-site.atlassian.net',
        cachedIdentifier: refOtherSite.key,
        cachedTitle: 'Same member, different site',
        cachedUrl: null,
        lastSeenAt: new Date(),
      },
      {
        id: refOtherMember.id,
        provider: 'jira',
        externalId: refOtherMember.key,
        externalSite: site,
        cachedIdentifier: refOtherMember.key,
        cachedTitle: "Another member's own work",
        cachedUrl: null,
        lastSeenAt: new Date(),
      },
    ]);

    const runIds = [
      `run-woja0001`,
      `run-wojb0001`,
      // A second run against refB: proves GROUP BY collapses two runs on
      // the same ticket into one key, not two.
      `run-wojb0002`,
      `run-wojc0001`,
      `run-wojd0001`,
      // A run against the plain native ticket every test in this file
      // shares — proves it is excluded by the join, not filtered out by
      // some ticketId-prefix check this function does not have.
      `run-wojnat01`,
    ];
    await db.insert(schema.agentRuns).values([
      {
        id: runIds[0],
        ticketId: refA.id,
        ownerMemberId: memberId,
        entry: 'dispatched',
        providerId: 'claude',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        id: runIds[1],
        ticketId: refB.id,
        ownerMemberId: memberId,
        entry: 'dispatched',
        providerId: 'claude',
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
      },
      {
        id: runIds[2],
        ticketId: refB.id,
        ownerMemberId: memberId,
        entry: 'dispatched',
        providerId: 'claude',
        // Newest activity on refB — this is the timestamp that should
        // decide refB's place in the ordering, not the first run's.
        createdAt: new Date('2026-01-05T00:00:00.000Z'),
      },
      {
        id: runIds[3],
        ticketId: refOtherSite.id,
        ownerMemberId: memberId,
        entry: 'dispatched',
        providerId: 'claude',
        createdAt: new Date('2026-01-03T00:00:00.000Z'),
      },
      {
        id: runIds[4],
        ticketId: refOtherMember.id,
        ownerMemberId: otherMember,
        entry: 'dispatched',
        providerId: 'claude',
        createdAt: new Date('2026-01-04T00:00:00.000Z'),
      },
      {
        id: runIds[5],
        ticketId,
        ownerMemberId: memberId,
        entry: 'dispatched',
        providerId: 'claude',
        createdAt: new Date('2026-01-06T00:00:00.000Z'),
      },
    ]);

    try {
      const keys = await service.listWorkedOnJiraTickets(memberId, site);
      // refB (last touched 2026-01-05) before refA (2026-01-01); neither
      // the other member's key nor the other site's key present.
      expect(keys).toEqual([refB.key, refA.key]);
    } finally {
      await db.delete(schema.agentRuns).where(inArray(schema.agentRuns.id, runIds));
      await db.delete(schema.ticketRefs).where(
        inArray(schema.ticketRefs.id, [refA.id, refB.id, refOtherSite.id, refOtherMember.id]),
      );
      await db.delete(schema.members).where(eq(schema.members.id, otherMember));
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
      const page = await listRuns({ ownerMemberId: owner, limit: 1, cursor });
      seen.push(...page.items.map((r) => r.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(seen).toEqual([...ids].reverse());
  });

  it('caps a summary at 20,000 characters with a marker rather than refusing it', async () => {
    const run = await createRun(base());
    const updated = await updateRun(run.id, { summary: 'y'.repeat(25_000) });
    expect(updated.summary).toHaveLength(20_000);
    expect(updated.summary?.endsWith('…')).toBe(true);
  });

  // ROAD-XXX: resume dead sessions. reopenRun is the one way an
  // interrupted/failed/cancelled run comes back — these prove its
  // preconditions hold under a real database, not just under mocks.
  describe('reopenRun', () => {
    async function deadRun(overrides: Partial<Parameters<typeof service.createRun>[0]> = {}) {
      const run = await createRun({ ...resumeBase(), ...overrides });
      await updateRun(run.id, { status: 'provisioning' });
      await updateRun(run.id, {
        status: 'running',
        worktreePath: `/tmp/wt-${run.id}`,
        providerSessionId: `prov-${run.id}`,
      });
      await updateRun(run.id, { status: 'failed', errorKind: 'generic', errorMessage: 'boom' });
      return (await getRun(run.id))!;
    }

    it('revives a failed run to provisioning, leaves endedAt/errorKind/errorMessage alone, and writes run_reopened then status_changed', async () => {
      const run = await deadRun();
      const before = run.endedAt;
      expect(before).not.toBeNull();

      const { run: reopened, from } = await reopenRun(run.id, 'testing revive');
      expect(from).toBe('failed');
      expect(reopened.status).toBe('provisioning');
      // Not nulled by reopenRun itself — only a successful resume clears it.
      expect(reopened.endedAt?.getTime()).toBe(before!.getTime());
      expect(reopened.reopenCount).toBe(1);
      expect(reopened.lastReopenedAt).not.toBeNull();
      expect(reopened.errorKind).toBe('generic');
      expect(reopened.errorMessage).toBe('boom');
      expect(reopened.worktreePath).toBe(`/tmp/wt-${run.id}`);

      const events = await listEvents(run.id);
      const lastTwo = events.slice(-2);
      expect(lastTwo.map((e) => e.kind)).toEqual(['run_reopened', 'status_changed']);
      expect(lastTwo[0].payload).toMatchObject({
        from: 'failed',
        errorKind: 'generic',
        errorMessage: 'boom',
        reason: 'testing revive',
      });
      expect(lastTwo[1].payload).toEqual({ from: 'failed', to: 'provisioning' });

      // Leave the ticket free for the tests that follow.
      await updateRun(run.id, { status: 'cancelled' });
    });

    it('revives an interrupted run and a cancelled run too', async () => {
      const interrupted = await createRun(resumeBase());
      await updateRun(interrupted.id, { status: 'provisioning' });
      await updateRun(interrupted.id, { status: 'interrupted' });
      expect((await reopenRun(interrupted.id)).run.status).toBe('provisioning');
      await updateRun(interrupted.id, { status: 'cancelled' });

      const cancelled = await createRun({ ...base(), ticketId: null, entry: 'independent' });
      await updateRun(cancelled.id, { status: 'cancelled' });
      expect((await reopenRun(cancelled.id)).run.status).toBe('provisioning');
      await updateRun(cancelled.id, { status: 'cancelled' });
    });

    // Never-lock (2026-09-20): a finished run is a conversation that can
    // be continued — the founder's rule: no session is ever locked.
    it('continues done and needs-review too, clearing endedAt only once the continuation reaches running', async () => {
      const done = await createRun({ ...base(), ticketId: null, entry: 'independent' });
      await updateRun(done.id, { status: 'provisioning' });
      await updateRun(done.id, { status: 'running' });
      await updateRun(done.id, { status: 'finishing' });
      const finished = await updateRun(done.id, { status: 'done' });
      expect(finished.endedAt).not.toBeNull();

      const { run: reopened, from } = await reopenRun(done.id, 'Continued by a new message');
      expect(from).toBe('done');
      expect(reopened.status).toBe('provisioning');
      // reopenRun leaves endedAt alone; updateRun clears it on the
      // continuation's provisioning → running, keyed on lastReopenedAt.
      expect(reopened.endedAt?.getTime()).toBe(finished.endedAt!.getTime());
      const running = await updateRun(done.id, { status: 'running' });
      expect(running.endedAt).toBeNull();
      await updateRun(done.id, { status: 'cancelled' });

      const needsReview = await createRun({ ...base(), ticketId: null, entry: 'independent' });
      await updateRun(needsReview.id, { status: 'provisioning' });
      await updateRun(needsReview.id, { status: 'running' });
      await updateRun(needsReview.id, { status: 'finishing' });
      await updateRun(needsReview.id, { status: 'needs-review' });
      expect((await reopenRun(needsReview.id)).from).toBe('needs-review');
      await updateRun(needsReview.id, { status: 'cancelled' });

      // A live run is the one thing there is nothing to reopen.
      const live = await createRun({ ...base(), ticketId: null, entry: 'independent' });
      await updateRun(live.id, { status: 'provisioning' });
      await updateRun(live.id, { status: 'running' });
      await expect(reopenRun(live.id)).rejects.toThrow(/is live, not something to reopen/);
    });

    it('a run a retry has superseded can still be continued — the retry works on its own branch', async () => {
      const first = await createRun(resumeBase());
      await updateRun(first.id, { status: 'provisioning' });
      await updateRun(first.id, { status: 'interrupted' });
      await createRun({ ...resumeBase(), retryOfRunId: first.id }); // cancels `first` under the lock

      expect((await getRun(first.id))?.status).toBe('cancelled');
      expect((await reopenRun(first.id)).run.status).toBe('provisioning');
    });

    it('refuses a non-owner', async () => {
      const otherMember = `mem-reopen-owner-${stamp}`;
      await db.insert(schema.members).values({
        id: otherMember,
        workspaceId,
        fullName: 'Other Owner',
        displayName: 'Other',
        email: `${otherMember}@example.test`,
        avatarColor: '#000000',
      });
      try {
        const run = await deadRun();
        await expect(reopenRun(run.id, undefined, otherMember)).rejects.toThrow(/belongs to another member/);
      } finally {
        await db.delete(schema.members).where(eq(schema.members.id, otherMember));
      }
    });

    it('many conversations may be live on one ticket: a continuation is never refused for another live writer', async () => {
      const dead = await deadRun();
      const live = await createRun(resumeBase());
      await updateRun(live.id, { status: 'provisioning' });
      await updateRun(live.id, { status: 'running' });

      // Two live writers on one ticket, on purpose (§3.3 of the design).
      const { run: revived } = await reopenRun(dead.id);
      expect(revived.status).toBe('provisioning');
      await updateRun(dead.id, { status: 'running' });
      const rows = await listRunsForTicket(resumeTicketId);
      expect(rows.filter((r) => r.status === 'running').map((r) => r.id).sort()).toEqual([dead.id, live.id].sort());
    });

    it('what stays single is the automatic dispatch: createRun refuses a second dispatched writer while one is queued or live', async () => {
      const first = await createRun(resumeBase()); // queued counts
      await expect(createRun(resumeBase())).rejects.toThrow(/already live on this ticket .* not dispatched twice/);
      // A plan-mode dispatch never writes, so it is not a second writer.
      const plan = await createRun({ ...resumeBase(), modeId: 'plan' });
      expect(plan.modeId).toBe('plan');
      // Nor is a run on no ticket.
      await createRun({ ...base(), ticketId: null, entry: 'independent' });
      // Once the first is over, a fresh dispatch is fine again.
      await updateRun(first.id, { status: 'cancelled' });
      await createRun(resumeBase());
    });

    it('two concurrent dispatches of one ticket: exactly one row lands (the advisory lock, across connections)', async () => {
      const results = await Promise.allSettled([createRun(resumeBase()), createRun(resumeBase())]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    });

    it('no cooldown and no cap: a conversation can be continued as often as the person likes', async () => {
      const run = await deadRun();
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await reopenRun(run.id);
        // eslint-disable-next-line no-await-in-loop
        await db.update(schema.agentRuns).set({ status: 'failed' }).where(eq(schema.agentRuns.id, run.id));
      }
      await db
        .update(schema.agentRuns)
        .set({ reopenCount: 500, lastReopenedAt: new Date(), status: 'failed' })
        .where(eq(schema.agentRuns.id, run.id));
      expect((await reopenRun(run.id)).run.reopenCount).toBe(501);
    });

    it('two concurrent reopens of the same run: one wins, the other is refused, never two run_reopened events', async () => {
      const run = await deadRun();
      const results = await Promise.allSettled([reopenRun(run.id), reopenRun(run.id)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const events = await listEvents(run.id);
      expect(events.filter((e) => e.kind === 'run_reopened')).toHaveLength(1);

      // Leave the ticket free for the tests that follow.
      await updateRun(run.id, { status: 'cancelled' });
    });

    // Round 2 of review, found missing: reopenRun took no advisory lock at
    // all, so a concurrent createRun on the same ticket could run its own
    // live-writer check against a stale, pre-commit read of the run being
    // reopened — the ticket-scoped `pg_advisory_xact_lock` createRun and
    // claimPublish already serialize on existed, reopenRun just never
    // joined it. Proven directly, the same way the two existing "one wins"
    // tests above prove serialization — not indirectly through timing.
    it('takes the same ticket-scoped advisory lock createRun and claimPublish use — a concurrent holder blocks it', async () => {
      const run = await deadRun();
      const raw = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
      try {
        await raw`SELECT pg_advisory_lock(hashtext(${resumeTicketId}))`;
        let resolved = false;
        const pending = reopenRun(run.id).then((r) => {
          resolved = true;
          return r;
        });
        await new Promise((r) => {
          setTimeout(r, 300);
        });
        // Still blocked: reopenRun is waiting on the same lock key.
        expect(resolved).toBe(false);
        await raw`SELECT pg_advisory_unlock(hashtext(${resumeTicketId}))`;
        const { run: reopened } = await pending;
        expect(resolved).toBe(true);
        expect(reopened.status).toBe('provisioning');
      } finally {
        await raw.end({ timeout: 3 });
      }

      // Leave the ticket free for the tests that follow.
      await updateRun(run.id, { status: 'cancelled' });
    });

    // Round 4 of review: the lock decision used to read `modeId` from the
    // unlocked peek and skip the lock for a plan-mode run — but `modeId`
    // is patchable, so a plan run flipped to a writing mode between the
    // peek and the row lock reopened as a real dispatched writer without
    // ever taking the lock. Now every dispatched ticketed run takes it.
    it('a plan-mode dispatched run takes the ticket lock too — the decision no longer trusts a mutable field read before the lock', async () => {
      const run = await deadRun({ modeId: 'plan' });
      expect(run.modeId).toBe('plan');
      const raw = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
      try {
        await raw`SELECT pg_advisory_lock(hashtext(${resumeTicketId}))`;
        let resolved = false;
        const pending = reopenRun(run.id).then((r) => {
          resolved = true;
          return r;
        });
        await new Promise((r) => {
          setTimeout(r, 300);
        });
        expect(resolved).toBe(false);
        await raw`SELECT pg_advisory_unlock(hashtext(${resumeTicketId}))`;
        await pending;
        expect(resolved).toBe(true);
      } finally {
        await raw.end({ timeout: 3 });
      }
      await updateRun(run.id, { status: 'cancelled' });
    });
  });

  // ROAD-XXX, security review's critical finding: once a run is non-
  // terminal again (reopened, or plainly interrupted), updateRun's
  // isTerminal guard no longer applies to it — these columns must refuse a
  // rewrite regardless of status, since they are handed straight to the
  // agent process as its execution directory.
  describe('write-once columns: cwd / worktreePath / daemonWorkspaceId', () => {
    it('refuses to change any of the three once set, even on a live, non-terminal row', async () => {
      const run = await createRun(resumeBase());
      await updateRun(run.id, { status: 'provisioning' });
      await updateRun(run.id, {
        status: 'running',
        worktreePath: '/tmp/original',
        daemonWorkspaceId: 'dw-1',
      });

      await expect(updateRun(run.id, { worktreePath: '/tmp/somewhere-else' })).rejects.toThrow(
        'worktreePath cannot be changed once set.',
      );
      await expect(updateRun(run.id, { daemonWorkspaceId: 'dw-evil' })).rejects.toThrow(
        'daemonWorkspaceId cannot be changed once set.',
      );
      // The same value back is a no-op patch, not a change — allowed.
      const same = await updateRun(run.id, { worktreePath: '/tmp/original' });
      expect(same.worktreePath).toBe('/tmp/original');

      // Leave the ticket free for the tests that follow.
      await updateRun(run.id, { status: 'cancelled' });
    });

    it('the regression this guard exists for: a reopened run stays un-patchable on these columns', async () => {
      const run = await createRun(resumeBase());
      await updateRun(run.id, { status: 'provisioning', cwd: '/tmp/legit' });
      await updateRun(run.id, { status: 'running', worktreePath: '/tmp/legit' });
      await updateRun(run.id, { status: 'failed', errorKind: 'generic', errorMessage: 'boom' });

      const { run: reopened } = await reopenRun(run.id);
      expect(reopened.status).toBe('provisioning'); // non-terminal — isTerminal alone would no longer refuse a patch here
      await expect(updateRun(run.id, { cwd: '/anything' })).rejects.toThrow('cwd cannot be changed once set.');
      await expect(updateRun(run.id, { worktreePath: '/anything' })).rejects.toThrow(
        'worktreePath cannot be changed once set.',
      );

      // Leave the ticket free for the tests that follow.
      await updateRun(run.id, { status: 'cancelled' });
    });

    it('the first write is allowed — this is how worktree provisioning itself sets cwd', async () => {
      const run = await createRun(base());
      const updated = await updateRun(run.id, { cwd: '/tmp/fresh' });
      expect(updated.cwd).toBe('/tmp/fresh');
      await expect(updateRun(run.id, { cwd: '/tmp/other' })).rejects.toThrow('cwd cannot be changed once set.');
    });
  });

  // Never-lock (2026-09-20): one publisher per ticket at publish time —
  // the guarantee that replaced the one-live-writer index (§3.3b).
  describe('claimPublish', () => {
    function claimPublish(id: string, headSha: string | null = null, asMemberId = memberId) {
      return runWithIdentity({ userId: `user-${asMemberId}`, memberId: asMemberId, workspaceId, role: 'admin' }, () =>
        service.claimPublish(id, headSha),
      );
    }
    async function finishingRun(overrides: Partial<Parameters<typeof service.createRun>[0]> = {}) {
      const run = await createRun({ ...resumeBase(), ...overrides });
      await updateRun(run.id, { status: 'provisioning' });
      await updateRun(run.id, { status: 'running' });
      await updateRun(run.id, { status: 'finishing' });
      return run;
    }

    it('claims for the only writer on the ticket, writing publish_claimed; an own second claim is fine', async () => {
      const run = await finishingRun();
      const { run: claimed } = await claimPublish(run.id, 'abc1234');
      expect(claimed.id).toBe(run.id);
      const events = await listEvents(run.id);
      expect(events.at(-1)).toMatchObject({ kind: 'publish_claimed', payload: { headSha: 'abc1234', ticketId: resumeTicketId } });
      // The header's Open PR re-claims the same run: no self-conflict.
      await claimPublish(run.id, 'abc1234');
    });

    it('refuses while another dispatched writer on the ticket is live, naming it', async () => {
      const mine = await finishingRun();
      // A second live writer — a continued conversation, say. Direct on
      // the table: createRun's single-dispatch guard exists exactly so
      // this cannot arise by dispatch; reopenRun is how it does.
      const other = await createRun({ ...base(), ticketId: null, entry: 'independent', title: 'Other one' });
      await db
        .update(schema.agentRuns)
        .set({ ticketId: resumeTicketId, entry: 'dispatched', status: 'running' })
        .where(eq(schema.agentRuns.id, other.id));
      await expect(claimPublish(mine.id)).rejects.toThrow(/live writer \(Other one\)/);
      // Its own claim, from the other side, is refused by `mine` too — and
      // a plan-mode writer never blocks anyone.
      await db.update(schema.agentRuns).set({ modeId: 'plan' }).where(eq(schema.agentRuns.id, other.id));
      await claimPublish(mine.id);
    });

    it("a stale claim (its holder died mid-push) blocks others only until the TTL; a claim followed by `finalized` never does", async () => {
      const dead = await finishingRun();
      await claimPublish(dead.id, 'aaaaaaa');
      await updateRun(dead.id, { status: 'cancelled' }); // no longer live, but its claim stands
      const mine = await finishingRun();
      await expect(claimPublish(mine.id)).rejects.toThrow(/publish is in progress/);

      // Its holder finished after all: a `finalized` event after the claim releases it.
      await appendEvent(dead.id, { kind: 'finalized', payload: { sequence: 1 } });
      await claimPublish(mine.id);

      // And a claim older than the TTL is ignored even without one.
      await appendEvent(mine.id, { kind: 'finalized', payload: { sequence: 1 } }); // release mine's own claim
      await updateRun(mine.id, { status: 'cancelled' }); // the ticket must be free to dispatch `stale`
      const stale = await finishingRun({ title: 'stale' });
      await updateRun(stale.id, { status: 'cancelled' });
      await claimPublish(stale.id, 'bbbbbbb');
      await db
        .update(schema.agentRunEvents)
        .set({ at: new Date(Date.now() - service.PUBLISH_CLAIM_TTL_MS - 1000) })
        .where(and(eq(schema.agentRunEvents.runId, stale.id), eq(schema.agentRunEvents.kind, 'publish_claimed')));
      const later = await finishingRun();
      await claimPublish(later.id);
    });

    it('two concurrent claims on one ticket: exactly one wins (the advisory lock)', async () => {
      const a = await finishingRun();
      await updateRun(a.id, { status: 'cancelled' });
      const b = await finishingRun();
      await updateRun(b.id, { status: 'cancelled' });
      const results = await Promise.allSettled([claimPublish(a.id, 'aaaaaaa'), claimPublish(b.id, 'bbbbbbb')]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    });

    it('a ticket-less run always claims; a non-owner never does', async () => {
      const solo = await createRun({ ...base(), ticketId: null, entry: 'independent' });
      await claimPublish(solo.id);
      const otherMember = `mem-claim-${stamp}`;
      await db.insert(schema.members).values({
        id: otherMember,
        workspaceId,
        fullName: 'Other',
        displayName: 'Other',
        email: `${otherMember}@example.test`,
        avatarColor: '#000000',
      });
      try {
        await expect(claimPublish(solo.id, null, otherMember)).rejects.toThrow(/belongs to another member/);
      } finally {
        await db.delete(schema.members).where(eq(schema.members.id, otherMember));
      }
    });
  });

  // Never-lock: the per-run outbox (pendingPrompts.service.ts).
  describe('pending prompts', () => {
    let pending: typeof import('./pendingPrompts.service.js');
    beforeAll(async () => {
      pending = await import('./pendingPrompts.service.js');
    });
    const as = <T,>(fn: () => Promise<T>, asMemberId = memberId) =>
      runWithIdentity({ userId: `user-${asMemberId}`, memberId: asMemberId, workspaceId, role: 'admin' }, fn);

    it('mints FIFO seqs under the row lock, writes prompt_queued, and lists in order', async () => {
      const run = await createRun({ ...base(), ticketId: null, entry: 'independent' });
      const rows = await Promise.all(
        ['one', 'two', 'three'].map((text) => as(() => pending.createPendingPrompt(run.id, { text, reason: 'starting' }))),
      );
      expect(rows.map((r) => r.seq).sort()).toEqual([1, 2, 3]);
      const listed = await as(() => pending.listPendingPrompts(run.id));
      expect(listed.map((r) => r.seq)).toEqual([1, 2, 3]);
      expect(listed.every((r) => r.state === 'queued' && r.byMemberId === memberId)).toBe(true);
      const events = await listEvents(run.id);
      expect(events.filter((e) => e.kind === 'prompt_queued')).toHaveLength(3);
      expect(events.find((e) => e.kind === 'prompt_queued')?.payload).toMatchObject({ reason: 'starting', by: memberId });
    });

    it('queued → sending (claimed) → delivered, one prompt_sent per phase; the owner only', async () => {
      const run = await createRun({ ...base(), ticketId: null, entry: 'independent' });
      const row = await as(() => pending.createPendingPrompt(run.id, { text: 'hi', reason: 'finishing' }));
      const sending = await as(() => pending.updatePendingPrompt(run.id, row.id, { state: 'sending' }));
      expect(sending.state).toBe('sending');
      expect(sending.claimedAt).not.toBeNull();
      const delivered = await as(() => pending.updatePendingPrompt(run.id, row.id, { state: 'delivered' }));
      expect(delivered.resolvedAt).not.toBeNull();
      const sent = (await listEvents(run.id)).filter((e) => e.kind === 'prompt_sent');
      expect(sent.map((e) => e.payload.phase)).toEqual(['claimed', 'delivered']);
      expect(sent.every((e) => e.payload.queuedId === row.id)).toBe(true);
      // Delivered is final.
      await expect(as(() => pending.updatePendingPrompt(run.id, row.id, { state: 'queued' }))).rejects.toThrow(
        /cannot become queued/,
      );
    });

    // Found in review (round 2): a same-value `state` PATCH used to be a
    // silent no-op 200 for every state, `sending` included — so a losing
    // racer's claim attempt against a row someone else just claimed
    // returned success indistinguishable from actually winning it.
    // Round 4 of review: the listing used to take the writers' FOR UPDATE
    // row lock, so a poll of the outbox queued behind a real writer on the
    // same run row. A read needs the workspace check, not the lock.
    it('listing pending prompts does not wait on a writer holding the run row', async () => {
      const run = await createRun({ ...base(), ticketId: null, entry: 'independent' });
      await as(() => pending.createPendingPrompt(run.id, { text: 'hi', reason: 'starting' }));
      const raw = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
      try {
        await raw`BEGIN`;
        await raw`SELECT id FROM agent_runs WHERE id = ${run.id} FOR UPDATE`;
        const listed = await Promise.race([
          as(() => pending.listPendingPrompts(run.id)),
          new Promise<'blocked'>((r) => {
            setTimeout(() => r('blocked'), 400);
          }),
        ]);
        expect(listed).not.toBe('blocked');
        expect((listed as { text: string }[]).map((r) => r.text)).toEqual(['hi']);
        await raw`ROLLBACK`;
      } finally {
        await raw.end({ timeout: 3 });
      }
    });

    it('a second claim on an already-claimed row is a conflict, not a silent no-op', async () => {
      const run = await createRun({ ...base(), ticketId: null, entry: 'independent' });
      const row = await as(() => pending.createPendingPrompt(run.id, { text: 'hi', reason: 'finishing' }));
      const first = await as(() => pending.updatePendingPrompt(run.id, row.id, { state: 'sending' }));
      expect(first.state).toBe('sending');
      const claimedAt = first.claimedAt;

      await expect(as(() => pending.updatePendingPrompt(run.id, row.id, { state: 'sending' }))).rejects.toThrow(
        /already claimed by another delivery attempt/,
      );
      // The loser's request changed nothing about the winner's claim.
      const [still] = await db
        .select()
        .from(schema.agentRunPendingPrompts)
        .where(eq(schema.agentRunPendingPrompts.id, row.id));
      expect(still.state).toBe('sending');
      expect(still.claimedAt?.getTime()).toBe(claimedAt?.getTime());

      // Two concurrent claims land the same way, not just sequential ones.
      const second = await as(() => pending.createPendingPrompt(run.id, { text: 'two', reason: 'finishing' }));
      await as(() => pending.updatePendingPrompt(run.id, second.id, { state: 'sending' }));
      const results = await Promise.allSettled([
        as(() => pending.updatePendingPrompt(run.id, second.id, { state: 'sending' })),
        as(() => pending.updatePendingPrompt(run.id, second.id, { state: 'sending' })),
      ]);
      expect(results.every((r) => r.status === 'rejected')).toBe(true);
    });

    it('a teammate may enqueue (owner-offline, attributed) and drop their own, but never deliver', async () => {
      const otherMember = `mem-outbox-${stamp}`;
      await db.insert(schema.members).values({
        id: otherMember,
        workspaceId,
        fullName: 'Teammate',
        displayName: 'Teammate',
        email: `${otherMember}@example.test`,
        avatarColor: '#000000',
      });
      try {
        const run = await createRun({ ...base(), ticketId: null, entry: 'independent' });
        const row = await as(() => pending.createPendingPrompt(run.id, { text: 'from a teammate', reason: 'owner-offline' }), otherMember);
        expect(row.byMemberId).toBe(otherMember);
        expect((await listEvents(run.id)).at(-1)?.payload).toMatchObject({ by: otherMember, forOwner: memberId });
        await expect(
          as(() => pending.updatePendingPrompt(run.id, row.id, { state: 'sending' }), otherMember),
        ).rejects.toThrow(/Only the run owner delivers/);
        const dropped = await as(() => pending.updatePendingPrompt(run.id, row.id, { state: 'dropped' }), otherMember);
        expect(dropped.state).toBe('dropped');
        expect((await listEvents(run.id)).at(-1)?.kind).toBe('prompt_dropped');
        // The row restricts on its author (like runs on their owner): the
        // run's cascade takes it first.
        await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
      } finally {
        await db.delete(schema.members).where(eq(schema.members.id, otherMember));
      }
    });

    it('a teammate cannot rewrite the owner-only bookkeeping fields by omitting `state` — the direct regression for the field-only bypass', async () => {
      const otherMember = `mem-outbox-bypass-${stamp}`;
      await db.insert(schema.members).values({
        id: otherMember,
        workspaceId,
        fullName: 'Teammate',
        displayName: 'Teammate',
        email: `${otherMember}@example.test`,
        avatarColor: '#000000',
      });
      try {
        const run = await createRun({ ...base(), ticketId: null, entry: 'independent' });
        const row = await as(() => pending.createPendingPrompt(run.id, { text: 'mine', reason: 'starting' }));
        // No `state` field at all — the check that used to gate these
        // three writes lived entirely inside the `state`-change branch.
        await expect(
          as(
            () => pending.updatePendingPrompt(run.id, row.id, { autoAttempts: 99, lastError: 'forged' }),
            otherMember,
          ),
        ).rejects.toThrow(/Only the run owner/);
        // `state` present but equal to the row's current state also used
        // to skip the whole guard block.
        await expect(
          as(
            () => pending.updatePendingPrompt(run.id, row.id, { state: 'queued', reason: 'spawn-failed' }),
            otherMember,
          ),
        ).rejects.toThrow(/Only the run owner/);
        const untouched = await as(() => pending.listPendingPrompts(run.id));
        expect(untouched[0]).toMatchObject({ autoAttempts: 0, lastError: null, reason: 'starting' });
        // The owner may still do it.
        const patched = await as(() => pending.updatePendingPrompt(run.id, row.id, { autoAttempts: 1 }));
        expect(patched.autoAttempts).toBe(1);
        await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
      } finally {
        await db.delete(schema.members).where(eq(schema.members.id, otherMember));
      }
    });

    it("a teammate's claimed `reason` is ignored — the server names it owner-offline regardless", async () => {
      const otherMember = `mem-outbox-reason-${stamp}`;
      await db.insert(schema.members).values({
        id: otherMember,
        workspaceId,
        fullName: 'Teammate',
        displayName: 'Teammate',
        email: `${otherMember}@example.test`,
        avatarColor: '#000000',
      });
      try {
        const run = await createRun({ ...base(), ticketId: null, entry: 'independent' });
        const row = await as(
          () => pending.createPendingPrompt(run.id, { text: 'from a teammate', reason: 'spawn-failed' }),
          otherMember,
        );
        expect(row.reason).toBe('owner-offline');
        await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
      } finally {
        await db.delete(schema.members).where(eq(schema.members.id, otherMember));
      }
    });

    it('a crash resolution: sending → unresolved, then queued again or delivered; autoAttempts and lastError are plain fields', async () => {
      const run = await createRun({ ...base(), ticketId: null, entry: 'independent' });
      const row = await as(() => pending.createPendingPrompt(run.id, { text: 'x', reason: 'spawn-failed' }));
      await as(() => pending.updatePendingPrompt(run.id, row.id, { state: 'sending' }));
      const unresolved = await as(() => pending.updatePendingPrompt(run.id, row.id, { state: 'unresolved' }));
      expect(unresolved.state).toBe('unresolved');
      const retried = await as(() =>
        pending.updatePendingPrompt(run.id, row.id, { state: 'queued', autoAttempts: 2, lastError: 'spawn: no provider' }),
      );
      expect(retried).toMatchObject({ state: 'queued', autoAttempts: 2, lastError: 'spawn: no provider', claimedAt: null });
    });
  });
});
