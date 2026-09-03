import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/errorHandler.js';

// Same shape as reviewQueue.routes.test.ts: mocked service layer, minimal
// app, verifying the HTTP contract for the new ?filter= wiring (W3.4) —
// base64url decode, shape validation, the project-scoped route overriding
// projectIds, and the unfiltered fallback when no ?filter= is given.
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../services/tickets.service.js');
vi.mock('../services/comments.service.js');
vi.mock('../services/activity.service.js');
const ticketsService = await import('../services/tickets.service.js');
const { ticketsRouter } = await import('./tickets.routes.js');

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use(ticketsRouter);
  app.use(errorHandler);
  return app;
}

function encodeFilter(filter: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(filter), 'utf8').toString('base64url');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /tickets', () => {
  it('calls listAllTickets (unfiltered) when no ?filter= is given', async () => {
    vi.mocked(ticketsService.listAllTickets).mockResolvedValue([]);
    const app = buildTestApp();

    const res = await request(app).get('/tickets');

    expect(res.status).toBe(200);
    expect(ticketsService.listAllTickets).toHaveBeenCalledWith();
    expect(ticketsService.listTicketsByFilter).not.toHaveBeenCalled();
  });

  it('decodes, validates, and applies a well-formed ?filter=', async () => {
    vi.mocked(ticketsService.listTicketsByFilter).mockResolvedValue([]);
    const app = buildTestApp();
    const encoded = encodeFilter({ v: 1, priorities: ['urgent'] });

    const res = await request(app).get(`/tickets?filter=${encoded}`);

    expect(res.status).toBe(200);
    expect(ticketsService.listTicketsByFilter).toHaveBeenCalledWith({ priorities: ['urgent'] });
  });

  it('returns 400 for a filter that fails schema validation', async () => {
    const app = buildTestApp();
    const encoded = encodeFilter({ v: 1, priorities: ['not-a-real-priority'] });

    const res = await request(app).get(`/tickets?filter=${encoded}`);

    expect(res.status).toBe(400);
    expect(ticketsService.listTicketsByFilter).not.toHaveBeenCalled();
  });

  it('returns 400 for a filter param that is not valid base64url/JSON', async () => {
    const app = buildTestApp();

    const res = await request(app).get('/tickets?filter=%%%not-base64%%%');

    expect(res.status).toBe(400);
    expect(ticketsService.listTicketsByFilter).not.toHaveBeenCalled();
  });
});

describe('GET /projects/:projectId/tickets', () => {
  it('calls listTickets (unfiltered) when no ?filter= is given', async () => {
    vi.mocked(ticketsService.listTickets).mockResolvedValue([]);
    const app = buildTestApp();

    const res = await request(app).get('/projects/proj-1/tickets');

    expect(res.status).toBe(200);
    expect(ticketsService.listTickets).toHaveBeenCalledWith('proj-1');
  });

  it('overrides any projectIds in the filter with the path param', async () => {
    vi.mocked(ticketsService.listTicketsByFilter).mockResolvedValue([]);
    const app = buildTestApp();
    const encoded = encodeFilter({ v: 1, projectIds: ['some-other-project'], stateIds: ['st-1'] });

    const res = await request(app).get(`/projects/proj-1/tickets?filter=${encoded}`);

    expect(res.status).toBe(200);
    expect(ticketsService.listTicketsByFilter).toHaveBeenCalledWith({
      projectIds: ['proj-1'],
      stateIds: ['st-1'],
    });
  });
});
