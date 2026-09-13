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
const service = await import('../services/agentRuns.service.js');
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

  it('404s an unknown run', async () => {
    vi.mocked(service.updateRun).mockRejectedValue(new NotFoundError('agent run'));

    const res = await request(buildTestApp()).patch('/agent-runs/run-nope').send({ summary: 'x' });

    expect(res.status).toBe(404);
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
    expect(proposalsService.createRunProposal).toHaveBeenLastCalledWith({
      agentRunId: 'run-abc1234',
      kind: 'comment',
      payload: { body: 'Root cause: …' },
    });

    const move = await request(app)
      .post('/agent-runs/run-abc1234/proposals')
      .send({ kind: 'state_change', stateId: 'st-review' });
    expect(move.status).toBe(201);
    expect(proposalsService.createRunProposal).toHaveBeenLastCalledWith({
      agentRunId: 'run-abc1234',
      kind: 'state_change',
      payload: { stateId: 'st-review' },
    });

    const create = await request(app)
      .post('/agent-runs/run-abc1234/proposals')
      .send({ kind: 'create_ticket', title: 'x' });
    expect(create.status).toBe(400);
    expect(proposalsService.createRunProposal).toHaveBeenCalledTimes(2);
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
