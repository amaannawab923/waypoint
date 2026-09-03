import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/errorHandler.js';
import { NotFoundError } from '../middleware/errors.js';

// Same shape as copilot.routes.test.ts: mocked service layer, minimal app,
// verifying the HTTP contract only (status codes, strict-body validation
// running before any service call, 404 mapping). The db mock exists for the
// import-time DATABASE_URL reason documented there.
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../services/proposals.service.js');
vi.mock('../services/copilot.service.js');
const proposalsService = await import('../services/proposals.service.js');
const copilotService = await import('../services/copilot.service.js');
const { proposalsRouter } = await import('./proposals.routes.js');

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use(proposalsRouter);
  app.use(errorHandler);
  return app;
}

function proposalView(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prop-abc1234',
    conversationId: 'conv-abc1234',
    kind: 'comment',
    ticketId: 'wi-1',
    payload: { body: 'hi' },
    snapshot: { identifier: 'WI-1', title: 'A ticket' },
    anchorSeq: 7,
    status: 'proposed',
    statusReason: null,
    resultInfo: null,
    disclosureText: 'Hi, this is Copilot — Amaan’s agent — commenting on their behalf: ',
    expiresAt: new Date('2026-01-02T00:00:00.000Z'),
    modelNotifiedAt: null,
    resolvedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(copilotService.getConversation).mockResolvedValue({ id: 'conv-abc1234' } as never);
});

describe('GET /copilot/conversations/:id/proposals', () => {
  it('returns the proposal views for the conversation', async () => {
    vi.mocked(proposalsService.listProposals).mockResolvedValue([proposalView()]);

    const res = await request(buildTestApp()).get('/copilot/conversations/conv-abc1234/proposals');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('prop-abc1234');
    expect(proposalsService.listProposals).toHaveBeenCalledWith('conv-abc1234');
  });

  it('404s a missing conversation before ever listing', async () => {
    vi.mocked(copilotService.getConversation).mockRejectedValue(new NotFoundError('conversation'));

    const res = await request(buildTestApp()).get('/copilot/conversations/conv-missing/proposals');

    expect(res.status).toBe(404);
    expect(proposalsService.listProposals).not.toHaveBeenCalled();
  });
});

describe('POST /copilot/proposals/:id/approve', () => {
  it('returns the finalized view — 200 even when the outcome is stale, since the status field IS the result', async () => {
    vi.mocked(proposalsService.approveProposal).mockResolvedValue(
      proposalView({ status: 'stale', statusReason: 'This ticket changed since Copilot proposed this — ask again' }),
    );

    const res = await request(buildTestApp()).post('/copilot/proposals/prop-abc1234/approve').send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('stale');
    expect(res.body.statusReason).toMatch(/changed since Copilot/);
    expect(proposalsService.approveProposal).toHaveBeenCalledWith('prop-abc1234');
  });

  it('accepts an empty body with no content at all', async () => {
    vi.mocked(proposalsService.approveProposal).mockResolvedValue(proposalView({ status: 'executed' }));

    const res = await request(buildTestApp()).post('/copilot/proposals/prop-abc1234/approve');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('executed');
  });

  it('rejects a stray body field with 400 and never calls the service', async () => {
    const res = await request(buildTestApp())
      .post('/copilot/proposals/prop-abc1234/approve')
      .send({ force: true });

    expect(res.status).toBe(400);
    expect(proposalsService.approveProposal).not.toHaveBeenCalled();
  });

  it('404s an unknown proposal id', async () => {
    vi.mocked(proposalsService.approveProposal).mockRejectedValue(new NotFoundError('proposal'));

    const res = await request(buildTestApp()).post('/copilot/proposals/prop-missing/approve').send({});

    expect(res.status).toBe(404);
  });
});

describe('POST /copilot/proposals/:id/reject', () => {
  it('returns the finalized view', async () => {
    vi.mocked(proposalsService.rejectProposal).mockResolvedValue(proposalView({ status: 'rejected' }));

    const res = await request(buildTestApp()).post('/copilot/proposals/prop-abc1234/reject').send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(proposalsService.rejectProposal).toHaveBeenCalledWith('prop-abc1234');
  });

  it('rejects a stray body field with 400', async () => {
    const res = await request(buildTestApp())
      .post('/copilot/proposals/prop-abc1234/reject')
      .send({ reason: 'nah' });

    expect(res.status).toBe(400);
    expect(proposalsService.rejectProposal).not.toHaveBeenCalled();
  });
});

describe('POST /copilot/conversations/:id/proposals/reject-all', () => {
  it('rejects all pending and returns the count', async () => {
    vi.mocked(proposalsService.rejectAllPending).mockResolvedValue({ rejected: 3 });

    const res = await request(buildTestApp())
      .post('/copilot/conversations/conv-abc1234/proposals/reject-all')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rejected: 3 });
    expect(proposalsService.rejectAllPending).toHaveBeenCalledWith('conv-abc1234');
  });

  it('404s a missing conversation before rejecting anything', async () => {
    vi.mocked(copilotService.getConversation).mockRejectedValue(new NotFoundError('conversation'));

    const res = await request(buildTestApp())
      .post('/copilot/conversations/conv-missing/proposals/reject-all')
      .send({});

    expect(res.status).toBe(404);
    expect(proposalsService.rejectAllPending).not.toHaveBeenCalled();
  });
});

describe('POST /copilot/conversations/:id/proposals/notified', () => {
  it('marks the given ids notified, scoped to the conversation', async () => {
    vi.mocked(proposalsService.markProposalsNotified).mockResolvedValue({ notified: 2 });

    const res = await request(buildTestApp())
      .post('/copilot/conversations/conv-abc1234/proposals/notified')
      .send({ ids: ['prop-1', 'prop-2'] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ notified: 2 });
    expect(proposalsService.markProposalsNotified).toHaveBeenCalledWith('conv-abc1234', ['prop-1', 'prop-2']);
  });

  it('rejects an empty ids array with 400 and never calls the service', async () => {
    const res = await request(buildTestApp())
      .post('/copilot/conversations/conv-abc1234/proposals/notified')
      .send({ ids: [] });

    expect(res.status).toBe(400);
    expect(proposalsService.markProposalsNotified).not.toHaveBeenCalled();
  });

  it('rejects a missing ids field with 400', async () => {
    const res = await request(buildTestApp())
      .post('/copilot/conversations/conv-abc1234/proposals/notified')
      .send({});

    expect(res.status).toBe(400);
    expect(proposalsService.markProposalsNotified).not.toHaveBeenCalled();
  });
});
