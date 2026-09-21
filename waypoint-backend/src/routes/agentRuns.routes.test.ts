import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/errorHandler.js';
import { ConflictError, NotFoundError } from '../middleware/errors.js';

// Same shape as proposals.routes.test.ts: mocked service, minimal app, the
// HTTP contract only — status codes, strict-body validation running before
// any service call, the 404/409 mappings. What the service does with a
// real database is agentRuns.service.integration.test.ts's job.
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../services/agentRuns.service.js');
vi.mock('../services/proposals.service.js');
vi.mock('../services/pendingPrompts.service.js');
const service = await import('../services/agentRuns.service.js');
const pendingService = await import('../services/pendingPrompts.service.js');
const proposalsService = await import('../services/proposals.service.js');
const { agentRunsRouter } = await import('./agentRuns.routes.js');

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use(agentRunsRouter);
  app.use(errorHandler);
  return app;
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-abc1234',
    projectId: 'proj-1',
    ticketId: 'wi-1',
    ownerMemberId: 'mem-1',
    agentId: null,
    entry: 'dispatched',
    providerId: 'claude',
    status: 'queued',
    createdAt: new Date('2026-09-12T00:00:00.000Z'),
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /agent-runs', () => {
  it('creates a run and returns 201', async () => {
    vi.mocked(service.createRun).mockResolvedValue(run());

    const res = await request(buildTestApp()).post('/agent-runs').send({
      projectId: 'proj-1',
      ticketId: 'wi-1',
      ownerMemberId: 'mem-1',
      entry: 'dispatched',
      providerId: 'claude',
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('run-abc1234');
    expect(service.createRun).toHaveBeenCalledWith({
      projectId: 'proj-1',
      ticketId: 'wi-1',
      ownerMemberId: 'mem-1',
      entry: 'dispatched',
      providerId: 'claude',
    });
  });

  it('trims a title on create; a blank one is null, a long one is 400', async () => {
    vi.mocked(service.createRun).mockResolvedValue(run({ entry: 'independent', ticketId: null }));
    const app = buildTestApp();
    const base = { projectId: 'proj-1', ownerMemberId: 'mem-1', entry: 'independent', providerId: 'claude' };

    expect((await request(app).post('/agent-runs').send({ ...base, title: '  Fix the flaky test  ' })).status).toBe(201);
    expect(service.createRun).toHaveBeenLastCalledWith({ ...base, title: 'Fix the flaky test' });

    expect((await request(app).post('/agent-runs').send({ ...base, title: '   ' })).status).toBe(201);
    expect(service.createRun).toHaveBeenLastCalledWith({ ...base, title: null });

    const long = await request(app).post('/agent-runs').send({ ...base, title: 'x'.repeat(121) });
    expect(long.status).toBe(400);
    expect(service.createRun).toHaveBeenCalledTimes(2);
  });

  it('W4b: an independent run may have no project; isolation and autoApprove pass through; a dispatched run is always a worktree', async () => {
    vi.mocked(service.createRun).mockResolvedValue(run({ entry: 'independent', ticketId: null, projectId: null }));
    const app = buildTestApp();

    const direct = await request(app).post('/agent-runs').send({
      projectId: null,
      ownerMemberId: 'mem-1',
      entry: 'independent',
      providerId: 'claude',
      isolation: 'directory',
      autoApprove: true,
    });
    expect(direct.status).toBe(201);
    expect(service.createRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectId: null, isolation: 'directory', autoApprove: true }),
    );

    const ticketNoProject = await request(app).post('/agent-runs').send({
      ticketId: 'wi-1',
      ownerMemberId: 'mem-1',
      entry: 'independent',
      providerId: 'claude',
    });
    expect(ticketNoProject.status).toBe(400);

    const dispatchedDirect = await request(app).post('/agent-runs').send({
      projectId: 'proj-1',
      ticketId: 'wi-1',
      ownerMemberId: 'mem-1',
      entry: 'dispatched',
      providerId: 'claude',
      isolation: 'directory',
    });
    expect(dispatchedDirect.status).toBe(400);
    expect(service.createRun).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown entry with 400 before touching the service', async () => {
    const res = await request(buildTestApp()).post('/agent-runs').send({
      projectId: 'proj-1',
      ownerMemberId: 'mem-1',
      entry: 'autonomous',
      providerId: 'claude',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_input');
    expect(service.createRun).not.toHaveBeenCalled();
  });

  it('rejects a stray field with 400 (strict body)', async () => {
    const res = await request(buildTestApp()).post('/agent-runs').send({
      projectId: 'proj-1',
      ownerMemberId: 'mem-1',
      entry: 'independent',
      providerId: 'claude',
      status: 'running',
    });

    expect(res.status).toBe(400);
    expect(service.createRun).not.toHaveBeenCalled();
  });

  it('rejects a dispatched run with no ticket, and a baseRef that git would read as an option', async () => {
    const dispatched = await request(buildTestApp()).post('/agent-runs').send({
      projectId: 'proj-1',
      ownerMemberId: 'mem-1',
      entry: 'dispatched',
      providerId: 'claude',
    });
    expect(dispatched.status).toBe(400);

    for (const baseRef of ['--detach', '-f', 'a b', 'a..b', 'x.lock']) {
      const res = await request(buildTestApp()).post('/agent-runs').send({
        projectId: 'proj-1',
        ownerMemberId: 'mem-1',
        entry: 'independent',
        providerId: 'claude',
        baseRef,
      });
      expect(res.status).toBe(400);
    }
    expect(service.createRun).not.toHaveBeenCalled();
  });

  // W5b: a run on a Jira issue names the issue's `tref-` handle and may
  // have no project (the folder it works in decides); a native ticket
  // still needs its project.
  it('W5b: a dispatched run on a Jira ref needs no project; a native ticket still does', async () => {
    vi.mocked(service.createRun).mockResolvedValue(run({ ticketId: 'tref-abc1234', projectId: null }));
    const app = buildTestApp();

    const jira = await request(app).post('/agent-runs').send({
      projectId: null,
      ticketId: 'tref-abc1234',
      ownerMemberId: 'mem-1',
      entry: 'dispatched',
      providerId: 'claude',
    });
    expect(jira.status).toBe(201);
    expect(service.createRun).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: 'tref-abc1234', projectId: null }),
    );

    const native = await request(app).post('/agent-runs').send({
      projectId: null,
      ticketId: 'wi-1',
      ownerMemberId: 'mem-1',
      entry: 'dispatched',
      providerId: 'claude',
    });
    expect(native.status).toBe(400);
    expect(service.createRun).toHaveBeenCalledTimes(1);
  });

  it('maps a retry of a live run to 409 with the service sentence', async () => {
    vi.mocked(service.createRun).mockRejectedValue(
      new ConflictError('Run run-old is running; only a finished or interrupted run can be retried.'),
    );

    const res = await request(buildTestApp()).post('/agent-runs').send({
      projectId: 'proj-1',
      ticketId: 'wi-1',
      ownerMemberId: 'mem-1',
      entry: 'dispatched',
      providerId: 'claude',
      retryOfRunId: 'run-old',
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Run run-old is running; only a finished or interrupted run can be retried.');
  });
});

describe('GET /agent-runs', () => {
  it('splits a comma-separated status filter into an array', async () => {
    vi.mocked(service.listRuns).mockResolvedValue({ items: [run()], nextCursor: null });

    const res = await request(buildTestApp()).get('/agent-runs?ownerMemberId=mem-1&status=running,blocked&limit=10');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(service.listRuns).toHaveBeenCalledWith({
      ownerMemberId: 'mem-1',
      status: ['running', 'blocked'],
      limit: 10,
    });
  });

  it('rejects a status the machine does not know with 400', async () => {
    const res = await request(buildTestApp()).get('/agent-runs?status=running,awaiting_review');

    expect(res.status).toBe(400);
    expect(service.listRuns).not.toHaveBeenCalled();
  });

  it('caps limit at 100', async () => {
    const res = await request(buildTestApp()).get('/agent-runs?limit=1000');

    expect(res.status).toBe(400);
    expect(service.listRuns).not.toHaveBeenCalled();
  });
});

describe('GET /agent-runs/worked-on-jira-keys', () => {
  // The one thing this route's own placement exists to prove: registered
  // ahead of GET /agent-runs/:id, so 'worked-on-jira-keys' is never read as
  // an :id and swallowed by getRun (which 404s on anything it doesn't
  // recognize) before this handler ever runs.
  it('is not shadowed by GET /agent-runs/:id', async () => {
    vi.mocked(service.listWorkedOnJiraTickets).mockResolvedValue(['ENG-1']);

    const res = await request(buildTestApp()).get(
      '/agent-runs/worked-on-jira-keys?site=waypoint123.atlassian.net',
    );

    expect(res.status).toBe(200);
    expect(service.getRun).not.toHaveBeenCalled();
  });

  it("passes the caller's own member id and the site straight through", async () => {
    vi.mocked(service.listWorkedOnJiraTickets).mockResolvedValue(['ENG-1', 'PLAT-2']);

    const res = await request(buildTestApp()).get(
      '/agent-runs/worked-on-jira-keys?site=waypoint123.atlassian.net',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(['ENG-1', 'PLAT-2']);
    expect(service.listWorkedOnJiraTickets).toHaveBeenCalledWith(
      expect.any(String),
      'waypoint123.atlassian.net',
    );
  });

  it('rejects a request with no site', async () => {
    const res = await request(buildTestApp()).get('/agent-runs/worked-on-jira-keys');

    expect(res.status).toBe(400);
    expect(service.listWorkedOnJiraTickets).not.toHaveBeenCalled();
  });
});

describe('GET /agent-runs/:id', () => {
  it('returns the run', async () => {
    vi.mocked(service.getRun).mockResolvedValue(run());

    const res = await request(buildTestApp()).get('/agent-runs/run-abc1234');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('run-abc1234');
  });

  it('404s an unknown run', async () => {
    vi.mocked(service.getRun).mockResolvedValue(null);

    const res = await request(buildTestApp()).get('/agent-runs/run-nope');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('agent run not found');
  });
});

describe('PATCH /agent-runs/:id', () => {
  it('passes a status move and its reason through to the service', async () => {
    vi.mocked(service.updateRun).mockResolvedValue(run({ status: 'cancelled' }));

    const res = await request(buildTestApp())
      .patch('/agent-runs/run-abc1234')
      .send({ status: 'cancelled', reason: 'user clicked Stop' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(service.updateRun).toHaveBeenCalledWith('run-abc1234', {
      status: 'cancelled',
      reason: 'user clicked Stop',
    });
  });

  it('accepts the provider session id and a title as plain fields', async () => {
    vi.mocked(service.updateRun).mockResolvedValue(run({ status: 'running' }));

    const res = await request(buildTestApp())
      .patch('/agent-runs/run-abc1234')
      .send({ status: 'running', providerSessionId: 'sess-uuid-1', title: 'Renamed ', cwd: '/w/run-1' });

    expect(res.status).toBe(200);
    expect(service.updateRun).toHaveBeenCalledWith('run-abc1234', {
      status: 'running',
      providerSessionId: 'sess-uuid-1',
      title: 'Renamed',
      cwd: '/w/run-1',
    });
  });

  it('maps a refused transition to 409 carrying the machine sentence', async () => {
    vi.mocked(service.updateRun).mockRejectedValue(
      new ConflictError('A done run is finished; it cannot become running.'),
    );

    const res = await request(buildTestApp()).patch('/agent-runs/run-abc1234').send({ status: 'running' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A done run is finished; it cannot become running.');
  });

  it('rejects an empty patch with 400', async () => {
    const res = await request(buildTestApp()).patch('/agent-runs/run-abc1234').send({});

    expect(res.status).toBe(400);
    expect(service.updateRun).not.toHaveBeenCalled();
  });

  it('rejects a prUrl that is not a URL', async () => {
    const res = await request(buildTestApp())
      .patch('/agent-runs/run-abc1234')
      .send({ prUrl: 'not a url' });

    expect(res.status).toBe(400);
    expect(service.updateRun).not.toHaveBeenCalled();
  });

  it('rejects a verdict outside the vocabulary; accepts one inside it (W5c)', async () => {
    const bad = await request(buildTestApp())
      .patch('/agent-runs/run-abc1234')
      .send({ verdict: 'shipped' });
    expect(bad.status).toBe(400);
    expect(service.updateRun).not.toHaveBeenCalled();

    vi.mocked(service.updateRun).mockResolvedValue({ id: 'run-abc1234', verdict: 'not-a-bug' } as never);
    const ok = await request(buildTestApp())
      .patch('/agent-runs/run-abc1234')
      .send({ verdict: 'not-a-bug' });
    expect(ok.status).toBe(200);
    expect(service.updateRun).toHaveBeenCalledWith('run-abc1234', { verdict: 'not-a-bug' });
  });

  it('404s an unknown run', async () => {
    vi.mocked(service.updateRun).mockRejectedValue(new NotFoundError('agent run'));

    const res = await request(buildTestApp()).patch('/agent-runs/run-nope').send({ summary: 'x' });

    expect(res.status).toBe(404);
  });
});

// ROAD-XXX: revive an interrupted/failed/cancelled run — see reopenRun's
// own doc comment (agentRuns.service.ts) for the preconditions it enforces;
// this is the HTTP contract only, same posture as PATCH's own tests above.
describe('POST /agent-runs/:id/reopen', () => {
  it('reopens a run and returns 200, with an optional reason passed through', async () => {
    vi.mocked(service.reopenRun).mockResolvedValue({
      run: run({ status: 'provisioning' }),
      from: 'failed',
    } as never);

    const res = await request(buildTestApp())
      .post('/agent-runs/run-abc1234/reopen')
      .send({ reason: 'resumed by a new message' });

    expect(res.status).toBe(200);
    expect(res.body.run.status).toBe('provisioning');
    expect(res.body.from).toBe('failed');
    expect(service.reopenRun).toHaveBeenCalledWith('run-abc1234', 'resumed by a new message');
  });

  it('reopens with no body at all — reason is optional', async () => {
    vi.mocked(service.reopenRun).mockResolvedValue({ run: run({ status: 'provisioning' }), from: 'cancelled' } as never);

    const res = await request(buildTestApp()).post('/agent-runs/run-abc1234/reopen').send();

    expect(res.status).toBe(200);
    expect(service.reopenRun).toHaveBeenCalledWith('run-abc1234', undefined);
  });

  it('rejects an unknown body field with 400, without calling the service', async () => {
    const res = await request(buildTestApp())
      .post('/agent-runs/run-abc1234/reopen')
      .send({ status: 'provisioning' });

    expect(res.status).toBe(400);
    expect(service.reopenRun).not.toHaveBeenCalled();
  });

  it('maps every refusal the service can throw to its HTTP status', async () => {
    const app = buildTestApp();

    vi.mocked(service.reopenRun).mockRejectedValueOnce(new NotFoundError('agent run'));
    const notFound = await request(app).post('/agent-runs/run-nope/reopen').send();
    expect(notFound.status).toBe(404);

    vi.mocked(service.reopenRun).mockRejectedValueOnce(
      new ConflictError('A done run finished successfully; it cannot be resumed.'),
    );
    const notRevivable = await request(app).post('/agent-runs/run-abc1234/reopen').send();
    expect(notRevivable.status).toBe(409);
    expect(notRevivable.body.error).toBe('A done run finished successfully; it cannot be resumed.');

    vi.mocked(service.reopenRun).mockRejectedValueOnce(
      new ConflictError('Run run-abc1234 was superseded by a retry (run-xyz); open that one instead.'),
    );
    const superseded = await request(app).post('/agent-runs/run-abc1234/reopen').send();
    expect(superseded.status).toBe(409);

    vi.mocked(service.reopenRun).mockRejectedValueOnce(
      new ConflictError('Run run-abc1234 belongs to another member; only its owner can resume it.'),
    );
    const notOwner = await request(app).post('/agent-runs/run-abc1234/reopen').send();
    expect(notOwner.status).toBe(409);
  });
});

describe('POST /agent-runs/:id/events', () => {
  it('appends a client event and returns 201', async () => {
    vi.mocked(service.appendEvent).mockResolvedValue({
      runId: 'run-abc1234',
      seq: 4,
      kind: 'permission_requested',
      payload: { tool: 'bash' },
      at: new Date(),
    } as never);

    const res = await request(buildTestApp())
      .post('/agent-runs/run-abc1234/events')
      .send({ kind: 'permission_requested', payload: { tool: 'bash' } });

    expect(res.status).toBe(201);
    expect(res.body.seq).toBe(4);
    expect(service.appendEvent).toHaveBeenCalledWith('run-abc1234', {
      kind: 'permission_requested',
      payload: { tool: 'bash' },
    });
  });

  it('refuses the service-owned kinds — a client cannot write status_changed', async () => {
    for (const kind of ['created', 'status_changed']) {
      const res = await request(buildTestApp()).post('/agent-runs/run-abc1234/events').send({ kind });
      expect(res.status).toBe(400);
    }
    expect(service.appendEvent).not.toHaveBeenCalled();
  });

  it('refuses a payload over 16 KiB', async () => {
    const res = await request(buildTestApp())
      .post('/agent-runs/run-abc1234/events')
      .send({ kind: 'note', payload: { text: 'x'.repeat(17_000) } });

    expect(res.status).toBe(400);
    expect(service.appendEvent).not.toHaveBeenCalled();
  });
});

describe('GET /agent-runs/:id/events', () => {
  it('passes afterSeq and limit through', async () => {
    vi.mocked(service.listEvents).mockResolvedValue([]);

    const res = await request(buildTestApp()).get('/agent-runs/run-abc1234/events?afterSeq=7&limit=50');

    expect(res.status).toBe(200);
    expect(service.listEvents).toHaveBeenCalledWith('run-abc1234', { afterSeq: 7, limit: 50 });
  });
});

describe('GET /tickets/:id/agent-runs', () => {
  it('lists the ticket’s runs', async () => {
    vi.mocked(service.listRunsForTicket).mockResolvedValue([run(), run({ id: 'run-older' })]);

    const res = await request(buildTestApp()).get('/tickets/wi-1/agent-runs');

    expect(res.status).toBe(200);
    expect(res.body.map((r: { id: string }) => r.id)).toEqual(['run-abc1234', 'run-older']);
    expect(service.listRunsForTicket).toHaveBeenCalledWith('wi-1');
  });
});

describe('POST /agent-runs/:id/proposals (W5a)', () => {
  it('files a comment or a state change on the run’s behalf and refuses any other kind', async () => {
    vi.mocked(proposalsService.createRunProposal).mockResolvedValue({ id: 'prop-1' } as never);
    const app = buildTestApp();

    const comment = await request(app)
      .post('/agent-runs/run-abc1234/proposals')
      .send({ kind: 'comment', body: 'Root cause: …' });
    expect(comment.status).toBe(201);
    // No credential header → null: the native path never needs one.
    expect(proposalsService.createRunProposal).toHaveBeenLastCalledWith(
      {
        agentRunId: 'run-abc1234',
        kind: 'comment',
        payload: { body: 'Root cause: …' },
        groupId: null,
      },
      null,
    );

    const move = await request(app)
      .post('/agent-runs/run-abc1234/proposals')
      .send({ kind: 'state_change', stateId: 'st-review', groupId: 'run-abc1234:2' });
    expect(move.status).toBe(201);
    expect(proposalsService.createRunProposal).toHaveBeenLastCalledWith(
      {
        agentRunId: 'run-abc1234',
        kind: 'state_change',
        payload: { stateId: 'st-review' },
        groupId: 'run-abc1234:2',
      },
      null,
    );

    const create = await request(app)
      .post('/agent-runs/run-abc1234/proposals')
      .send({ kind: 'create_ticket', title: 'x' });
    expect(create.status).toBe(400);
    expect(proposalsService.createRunProposal).toHaveBeenCalledTimes(2);
  });

  // W5b: a run on a Jira issue files through the same borrowed-credential
  // seam an approve uses — the header main attaches becomes the credential
  // the service reads the issue with, and lives only for this request.
  it('hands the service the credential main borrowed on the header (W5b)', async () => {
    vi.mocked(proposalsService.createRunProposal).mockResolvedValue({ id: 'prop-1' } as never);
    const header = Buffer.from(
      JSON.stringify({
        site: 'yourteam.atlassian.net',
        email: 'max@example.com',
        apiToken: 'tok',
        displayName: 'Max Chen',
      }),
    ).toString('base64');

    const res = await request(buildTestApp())
      .post('/agent-runs/run-abc1234/proposals')
      .set('x-waypoint-jira-credential', header)
      .send({ kind: 'state_change', stateId: '31' });

    expect(res.status).toBe(201);
    expect(proposalsService.createRunProposal).toHaveBeenLastCalledWith(
      { agentRunId: 'run-abc1234', kind: 'state_change', payload: { stateId: '31' }, groupId: null },
      { site: 'yourteam.atlassian.net', email: 'max@example.com', apiToken: 'tok', displayName: 'Max Chen' },
    );
  });
});

describe('the transcript snapshot (ROAD-124)', () => {
  it('PUT replaces it whole and answers the row; GET reads it, 404 when none', async () => {
    const turns = [{ id: 't1', seq: 1, items: [{ kind: 'message', role: 'assistant', text: 'hi' }] }];
    vi.mocked(service.saveTranscript).mockResolvedValue({
      runId: 'run-abc1234',
      turns,
      turnCount: 1,
      capturedAt: new Date(),
    } as never);
    const put = await request(buildTestApp()).put('/agent-runs/run-abc1234/transcript').send({ turns });
    expect(put.status).toBe(200);
    expect(put.body.turnCount).toBe(1);
    expect(service.saveTranscript).toHaveBeenCalledWith('run-abc1234', { turns });

    vi.mocked(service.getTranscript).mockResolvedValueOnce(null);
    expect((await request(buildTestApp()).get('/agent-runs/run-abc1234/transcript')).status).toBe(404);
    vi.mocked(service.getTranscript).mockResolvedValueOnce({ runId: 'run-abc1234', turns, turnCount: 1, capturedAt: new Date() } as never);
    const got = await request(buildTestApp()).get('/agent-runs/run-abc1234/transcript');
    expect(got.status).toBe(200);
    expect(got.body.turns).toEqual(turns);
  });

  it('refuses a body that is not turns, or a stray field', async () => {
    expect((await request(buildTestApp()).put('/agent-runs/run-abc1234/transcript').send({ turns: 'x' })).status).toBe(400);
    expect((await request(buildTestApp()).put('/agent-runs/run-abc1234/transcript').send({ turns: [], extra: 1 })).status).toBe(400);
    expect(service.saveTranscript).not.toHaveBeenCalled();
  });
});

// Never-lock: the publish claim and the per-run outbox.
describe('POST /agent-runs/:id/publish-claim', () => {
  it('claims with a headSha and returns 200; headSha is optional', async () => {
    vi.mocked(service.claimPublish).mockResolvedValue({ run: run({ status: 'finishing' }), claimedAt: new Date() } as never);
    const res = await request(buildTestApp()).post('/agent-runs/run-abc1234/publish-claim').send({ headSha: 'abc1234' });
    expect(res.status).toBe(200);
    expect(service.claimPublish).toHaveBeenCalledWith('run-abc1234', 'abc1234');

    await request(buildTestApp()).post('/agent-runs/run-abc1234/publish-claim').send();
    expect(service.claimPublish).toHaveBeenLastCalledWith('run-abc1234', null);
  });

  it('rejects a headSha that is not a hex sha, and an unknown body field, with 400', async () => {
    expect((await request(buildTestApp()).post('/agent-runs/run-abc1234/publish-claim').send({ headSha: 'HEAD' })).status).toBe(400);
    expect((await request(buildTestApp()).post('/agent-runs/run-abc1234/publish-claim').send({ status: 'done' })).status).toBe(400);
    expect(service.claimPublish).not.toHaveBeenCalled();
  });

  it('a refused claim is the service\'s 409 sentence', async () => {
    const { ConflictError } = await import('../middleware/errors.js');
    vi.mocked(service.claimPublish).mockRejectedValue(new ConflictError('Not published: this ticket has a live writer (Other).'));
    const res = await request(buildTestApp()).post('/agent-runs/run-abc1234/publish-claim').send();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/live writer \(Other\)/);
  });
});

describe('pending prompts routes', () => {
  const row = { id: 'pp-1', runId: 'run-abc1234', seq: 1, byMemberId: 'mem-1', text: 'hi', reason: 'starting', state: 'queued', autoAttempts: 0, lastError: null, claimedAt: null, resolvedAt: null, createdAt: new Date() };

  it('GET lists; POST creates with 201; PATCH updates', async () => {
    vi.mocked(pendingService.listPendingPrompts).mockResolvedValue([row] as never);
    vi.mocked(pendingService.createPendingPrompt).mockResolvedValue(row as never);
    vi.mocked(pendingService.updatePendingPrompt).mockResolvedValue({ ...row, state: 'sending' } as never);

    expect((await request(buildTestApp()).get('/agent-runs/run-abc1234/pending-prompts')).body).toHaveLength(1);
    const created = await request(buildTestApp()).post('/agent-runs/run-abc1234/pending-prompts').send({ text: 'hi', reason: 'starting' });
    expect(created.status).toBe(201);
    expect(pendingService.createPendingPrompt).toHaveBeenCalledWith('run-abc1234', { text: 'hi', reason: 'starting' });
    const patched = await request(buildTestApp()).patch('/agent-runs/run-abc1234/pending-prompts/pp-1').send({ state: 'sending' });
    expect(patched.status).toBe(200);
    expect(pendingService.updatePendingPrompt).toHaveBeenCalledWith('run-abc1234', 'pp-1', { state: 'sending' });
  });

  it('validates: an unknown reason, an unknown state, empty text, over-long text, an empty patch', async () => {
    const app = buildTestApp();
    expect((await request(app).post('/agent-runs/run-abc1234/pending-prompts').send({ text: 'hi', reason: 'later' })).status).toBe(400);
    expect((await request(app).post('/agent-runs/run-abc1234/pending-prompts').send({ text: '', reason: 'starting' })).status).toBe(400);
    expect((await request(app).post('/agent-runs/run-abc1234/pending-prompts').send({ text: 'x'.repeat(20_001), reason: 'starting' })).status).toBe(400);
    expect((await request(app).patch('/agent-runs/run-abc1234/pending-prompts/pp-1').send({ state: 'lost' })).status).toBe(400);
    expect((await request(app).patch('/agent-runs/run-abc1234/pending-prompts/pp-1').send({})).status).toBe(400);
    expect(pendingService.createPendingPrompt).not.toHaveBeenCalled();
    expect(pendingService.updatePendingPrompt).not.toHaveBeenCalled();
  });
});
