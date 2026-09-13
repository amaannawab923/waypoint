import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/errorHandler.js';

// W5b (ROAD-126): the desktop app's ticket handles. The HTTP contract only —
// the dual lookup is resolveTicketIdentifier's (mocked here, pinned in
// ticketTools.jira.test.ts through the MCP handler), the upsert is
// ticketRefs.service's. What this file proves: which outcome maps to which
// status and body, that the site a POST records is the normalized one, and
// that the credential header reaches the provider factory.
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../services/ticketRefs.service.js');
vi.mock('../services/ticketResolution.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/ticketResolution.service.js')>()),
  resolveTicketIdentifier: vi.fn(),
}));
vi.mock('../providers/jira.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../providers/jira.js')>()),
  getJiraProvider: vi.fn(),
}));

const ticketRefs = await import('../services/ticketRefs.service.js');
const { resolveTicketIdentifier } = await import('../services/ticketResolution.service.js');
const { getJiraProvider } = await import('../providers/jira.js');
const { ProviderUnavailableError } = await import('../providers/types.js');
const { ticketRefsRouter } = await import('./ticketRefs.routes.js');

function app() {
  const a = express();
  a.use(express.json());
  a.use(ticketRefsRouter);
  a.use(errorHandler);
  return a;
}

const JIRA = {
  provider: 'jira' as const,
  ref: 'tref-abc1234',
  identifier: 'ENG-4',
  title: 'Checkout 500s',
  projectId: 'ENG',
  stateId: '10001',
  stateName: 'In Progress',
  stateGroup: 'started',
  priority: 'high',
  dueDate: null,
  assigneeIds: [],
  assigneeNames: [],
  url: 'https://yourteam.atlassian.net/browse/ENG-4',
};

const NATIVE = { ...JIRA, provider: 'native' as const, ref: 'wi-1', projectId: 'proj-1', url: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getJiraProvider).mockReturnValue(null);
});

describe('GET /tickets/resolve/:identifier', () => {
  it('answers a Jira hit as a tref handle, passing the borrowed credential to the provider', async () => {
    const jira = { site: 'yourteam.atlassian.net' };
    vi.mocked(getJiraProvider).mockReturnValue(jira as never);
    vi.mocked(resolveTicketIdentifier).mockResolvedValue({ kind: 'found', ticket: JIRA });
    const header = Buffer.from(
      JSON.stringify({ site: 'yourteam.atlassian.net', email: 'a@b.co', apiToken: 't' }),
    ).toString('base64');

    const res = await request(app())
      .get('/tickets/resolve/eng-4')
      .set('x-waypoint-jira-credential', header);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      provider: 'jira',
      id: 'tref-abc1234',
      identifier: 'ENG-4',
      title: 'Checkout 500s',
      projectId: 'ENG',
      url: 'https://yourteam.atlassian.net/browse/ENG-4',
    });
    expect(getJiraProvider).toHaveBeenCalledWith({
      site: 'yourteam.atlassian.net',
      email: 'a@b.co',
      apiToken: 't',
    });
    expect(resolveTicketIdentifier).toHaveBeenCalledWith(jira, 'eng-4', undefined);
  });

  it('answers a native hit with the ticket id and no URL; no header means no Jira provider', async () => {
    vi.mocked(resolveTicketIdentifier).mockResolvedValue({ kind: 'found', ticket: NATIVE });

    const res = await request(app()).get('/tickets/resolve/ENG-4?provider=native');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ provider: 'native', id: 'wi-1', projectId: 'proj-1', url: null });
    expect(resolveTicketIdentifier).toHaveBeenCalledWith(null, 'ENG-4', 'native');
  });

  it('refuses an ambiguous key with a 409 naming both, never a guess', async () => {
    vi.mocked(resolveTicketIdentifier).mockResolvedValue({ kind: 'ambiguous', native: NATIVE, jira: JIRA });

    const res = await request(app()).get('/tickets/resolve/ENG-4');

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/ambiguous/);
    expect(res.body.error).toContain('Checkout 500s');
  });

  it('maps missing to 404, Jira unreachable to 409, and Jira-off (explicit provider) to 400', async () => {
    vi.mocked(resolveTicketIdentifier).mockResolvedValueOnce({ kind: 'missing' });
    expect((await request(app()).get('/tickets/resolve/ENG-9')).status).toBe(404);

    vi.mocked(resolveTicketIdentifier).mockResolvedValueOnce({
      kind: 'unavailable',
      error: new ProviderUnavailableError('timed out'),
    });
    const down = await request(app()).get('/tickets/resolve/ENG-9');
    expect(down.status).toBe(409);
    expect(down.body.error).toMatch(/could not be reached/);

    vi.mocked(resolveTicketIdentifier).mockResolvedValueOnce({ kind: 'jira_off' });
    expect((await request(app()).get('/tickets/resolve/ENG-9?provider=jira')).status).toBe(400);
  });

  it('rejects an unknown provider query with 400', async () => {
    const res = await request(app()).get('/tickets/resolve/ENG-4?provider=linear');
    expect(res.status).toBe(400);
    expect(resolveTicketIdentifier).not.toHaveBeenCalled();
  });
});

describe('GET /ticket-refs/:id', () => {
  it('answers what a handle stands for', async () => {
    vi.mocked(ticketRefs.findById).mockResolvedValue({
      id: 'tref-abc1234',
      provider: 'jira',
      externalId: 'ENG-4',
      externalSite: 'yourteam.atlassian.net',
      cachedIdentifier: 'ENG-4',
      cachedTitle: 'Checkout 500s',
      cachedUrl: 'https://yourteam.atlassian.net/browse/ENG-4',
      lastSeenAt: new Date('2026-09-13T10:00:00.000Z'),
    });

    const res = await request(app()).get('/ticket-refs/tref-abc1234');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: 'tref-abc1234',
      provider: 'jira',
      site: 'yourteam.atlassian.net',
      externalId: 'ENG-4',
      identifier: 'ENG-4',
      title: 'Checkout 500s',
      url: 'https://yourteam.atlassian.net/browse/ENG-4',
      lastSeenAt: '2026-09-13T10:00:00.000Z',
    });
  });

  it('404s an unknown or mis-shaped handle without a lookup', async () => {
    vi.mocked(ticketRefs.findById).mockResolvedValue(undefined);
    expect((await request(app()).get('/ticket-refs/tref-nope')).status).toBe(404);
    expect((await request(app()).get('/ticket-refs/wi-1')).status).toBe(404);
    expect(ticketRefs.findById).toHaveBeenCalledTimes(1);
  });
});

describe('POST /ticket-refs', () => {
  it('mints (or refreshes) a Jira handle with the site normalized and the key upper-cased', async () => {
    vi.mocked(ticketRefs.remember).mockResolvedValue({
      id: 'tref-abc1234',
      provider: 'jira',
      externalId: 'ENG-4',
      externalSite: 'yourteam.atlassian.net',
      cachedIdentifier: 'ENG-4',
      cachedTitle: 'Checkout 500s',
      cachedUrl: 'https://yourteam.atlassian.net/browse/ENG-4',
      lastSeenAt: new Date('2026-09-13T10:00:00.000Z'),
    });

    const res = await request(app())
      .post('/ticket-refs')
      .send({ provider: 'jira', site: 'https://YourTeam.atlassian.net/', key: 'eng-4', title: 'Checkout 500s' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('tref-abc1234');
    expect(ticketRefs.remember).toHaveBeenCalledWith({
      provider: 'jira',
      site: 'yourteam.atlassian.net',
      externalId: 'ENG-4',
      identifier: 'ENG-4',
      title: 'Checkout 500s',
      url: 'https://yourteam.atlassian.net/browse/ENG-4',
    });
  });

  it('refuses a key that is not an issue key, a site that is not a hostname, and a stray field', async () => {
    const a = app();
    const post = (body: Record<string, unknown>) => request(a).post('/ticket-refs').send(body);
    expect((await post({ provider: 'jira', site: 'x.atlassian.net', key: 'not a key' })).status).toBe(400);
    expect((await post({ provider: 'jira', site: '127.0.0.1', key: 'ENG-4' })).status).toBe(400);
    expect((await post({ provider: 'jira', site: 'x.atlassian.net', key: 'ENG-4', extra: 1 })).status).toBe(400);
    expect((await post({ provider: 'linear', site: 'x.atlassian.net', key: 'ENG-4' })).status).toBe(400);
    expect(ticketRefs.remember).not.toHaveBeenCalled();
  });
});
