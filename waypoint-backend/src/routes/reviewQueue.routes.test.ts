import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/errorHandler.js';

// Same shape as proposals.routes.test.ts: mocked service layer, minimal
// app, verifying the HTTP contract only (status codes, query/body
// validation running before any service call, response shaping). The db
// mock exists for the import-time DATABASE_URL reason documented in that
// file.
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../services/proposals.service.js');
const proposalsService = await import('../services/proposals.service.js');
const { reviewQueueRouter } = await import('./reviewQueue.routes.js');

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use(reviewQueueRouter);
  app.use(errorHandler);
  return app;
}

function proposalView(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prop-abc1234',
    origin: 'copilot',
    conversationId: 'conv-abc1234',
    anchorSeq: 7,
    agentId: null,
    agentRunId: null,
    projectId: 'proj-1',
    sourceRequestId: null,
    kind: 'comment',
    ticketId: 'wi-1',
    payload: { body: 'hi' },
    snapshot: { identifier: 'WI-1', title: 'A ticket' },
    status: 'proposed',
    statusReason: null,
    resultInfo: null,
    disclosureText: 'Hi, this is Copilot — Amaan’s agent — commenting on their behalf: ',
    expiresAt: new Date('2026-01-02T00:00:00.000Z'),
    modelNotifiedAt: null,
    resolvedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    decidedBy: null,
    trustGrantId: null,
    decisionLatencyMs: null,
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /proposals', () => {
  it('returns the segment page and counts', async () => {
    vi.mocked(proposalsService.listReviewQueue).mockResolvedValue({
      proposals: [proposalView()],
      counts: { proposed: 1, blocked: 0, recent: 0 },
      nextCursor: null,
    });

    const res = await request(buildTestApp()).get('/proposals?status=proposed');

    expect(res.status).toBe(200);
    expect(res.body.proposals).toHaveLength(1);
    expect(res.body.counts).toEqual({ proposed: 1, blocked: 0, recent: 0 });
    expect(proposalsService.listReviewQueue).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'proposed' }),
    );
  });

  it('passes filters and a numeric limit through to the service', async () => {
    vi.mocked(proposalsService.listReviewQueue).mockResolvedValue({
      proposals: [],
      counts: { proposed: 0, blocked: 0, recent: 0 },
      nextCursor: null,
    });

    const res = await request(buildTestApp()).get(
      '/proposals?status=recent&agentId=agent-1&projectId=proj-1&kind=comment&limit=10',
    );

    expect(res.status).toBe(200);
    expect(proposalsService.listReviewQueue).toHaveBeenCalledWith({
      status: 'recent',
      agentId: 'agent-1',
      projectId: 'proj-1',
      kind: 'comment',
      limit: 10,
    });
  });

  it('400s a missing status', async () => {
    const res = await request(buildTestApp()).get('/proposals');
    expect(res.status).toBe(400);
    expect(proposalsService.listReviewQueue).not.toHaveBeenCalled();
  });

  it('400s an invalid status value', async () => {
    const res = await request(buildTestApp()).get('/proposals?status=bogus');
    expect(res.status).toBe(400);
    expect(proposalsService.listReviewQueue).not.toHaveBeenCalled();
  });
});

describe('GET /proposals/counts', () => {
  it('returns the three segment counts', async () => {
    vi.mocked(proposalsService.getProposalCounts).mockResolvedValue({ proposed: 3, blocked: 0, recent: 5 });

    const res = await request(buildTestApp()).get('/proposals/counts');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ proposed: 3, blocked: 0, recent: 5 });
  });
});

describe('POST /proposals/bulk-approve', () => {
  it('returns per-id results', async () => {
    vi.mocked(proposalsService.bulkApproveProposals).mockResolvedValue([
      { id: 'prop-1', status: 'executed', statusReason: null },
      { id: 'prop-2', status: 'stale', statusReason: 'was already stale' },
    ]);

    const res = await request(buildTestApp())
      .post('/proposals/bulk-approve')
      .send({ ids: ['prop-1', 'prop-2'] });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(proposalsService.bulkApproveProposals).toHaveBeenCalledWith(['prop-1', 'prop-2']);
  });

  it('rejects a batch over 50 ids with 400, never calling the service', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `prop-${i}`);

    const res = await request(buildTestApp()).post('/proposals/bulk-approve').send({ ids });

    expect(res.status).toBe(400);
    expect(proposalsService.bulkApproveProposals).not.toHaveBeenCalled();
  });

  it('rejects an empty ids array with 400', async () => {
    const res = await request(buildTestApp()).post('/proposals/bulk-approve').send({ ids: [] });
    expect(res.status).toBe(400);
    expect(proposalsService.bulkApproveProposals).not.toHaveBeenCalled();
  });
});

describe('POST /proposals/bulk-reject', () => {
  it('returns per-id results', async () => {
    vi.mocked(proposalsService.bulkRejectProposals).mockResolvedValue([
      { id: 'prop-1', status: 'rejected', statusReason: null },
    ]);

    const res = await request(buildTestApp())
      .post('/proposals/bulk-reject')
      .send({ ids: ['prop-1'] });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ id: 'prop-1', status: 'rejected', statusReason: null }]);
  });

  it('accepts exactly 50 ids', async () => {
    vi.mocked(proposalsService.bulkRejectProposals).mockResolvedValue([]);
    const ids = Array.from({ length: 50 }, (_, i) => `prop-${i}`);

    const res = await request(buildTestApp()).post('/proposals/bulk-reject').send({ ids });

    expect(res.status).toBe(200);
    expect(proposalsService.bulkRejectProposals).toHaveBeenCalledWith(ids);
  });
});

describe('GET /proposals/stats/approved-per-day', () => {
  it('returns the aggregate stats', async () => {
    vi.mocked(proposalsService.getApprovedPerActiveDayStats).mockResolvedValue({
      approvedCount: 12,
      activeDays: 4,
      averagePerActiveDay: 3,
    });

    const res = await request(buildTestApp()).get('/proposals/stats/approved-per-day');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ approvedCount: 12, activeDays: 4, averagePerActiveDay: 3 });
  });
});

describe('GET /tickets/:id/proposals', () => {
  it('returns the proposals for the ticket', async () => {
    vi.mocked(proposalsService.listProposalsForTicket).mockResolvedValue([proposalView()]);

    const res = await request(buildTestApp()).get('/tickets/wi-1/proposals?status=proposed');

    expect(res.status).toBe(200);
    expect(res.body.proposals).toHaveLength(1);
    expect(proposalsService.listProposalsForTicket).toHaveBeenCalledWith('wi-1', 'proposed');
  });

  it('works with no status filter', async () => {
    vi.mocked(proposalsService.listProposalsForTicket).mockResolvedValue([]);

    const res = await request(buildTestApp()).get('/tickets/wi-1/proposals');

    expect(res.status).toBe(200);
    expect(proposalsService.listProposalsForTicket).toHaveBeenCalledWith('wi-1', undefined);
  });
});
