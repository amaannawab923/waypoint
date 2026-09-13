import {
  createLedgerClient,
  isTicketRef,
  JIRA_CREDENTIAL_HEADER,
  LedgerRequestError,
} from './ledgerClient';

type Call = { url: string; init: RequestInit | undefined };

function fakeFetch(
  answer: (
    call: Call,
  ) =>
    | { status: number; body?: unknown }
    | Promise<{ status: number; body?: unknown }>,
) {
  const calls: Call[] = [];
  const fn = jest.fn(async (url: string, init?: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    const { status, body } = await answer(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body === undefined) throw new Error('no body');
        return body;
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const RUN = { id: 'run-abc1234', status: 'queued' };

describe('createLedgerClient', () => {
  it('POSTs a create to /agent-runs as JSON against the configured base URL', async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 201, body: RUN }));
    const client = createLedgerClient({
      baseUrl: 'http://api.test/',
      fetch: fn,
    });

    const run = await client.createRun({
      projectId: 'proj-1',
      ownerMemberId: 'mem-1',
      entry: 'independent',
      providerId: 'claude',
    });

    expect(run).toEqual(RUN);
    expect(calls[0].url).toBe('http://api.test/agent-runs');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.headers).toEqual({
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      projectId: 'proj-1',
      ownerMemberId: 'mem-1',
      entry: 'independent',
      providerId: 'claude',
    });
  });

  it('getRun returns null on 404 and the row otherwise', async () => {
    const { fn } = fakeFetch(({ url }) =>
      url.endsWith('/run-abc1234')
        ? { status: 200, body: RUN }
        : { status: 404, body: { error: 'agent run not found' } },
    );
    const client = createLedgerClient({
      baseUrl: 'http://api.test',
      fetch: fn,
    });

    expect(await client.getRun('run-abc1234')).toEqual(RUN);
    expect(await client.getRun('run-nope000')).toBeNull();
  });

  it('refuses an id that could spell a path before any request is made', async () => {
    const { fn } = fakeFetch(() => ({ status: 200, body: RUN }));
    const client = createLedgerClient({
      baseUrl: 'http://api.test',
      fetch: fn,
    });

    await expect(client.getRun('../agents')).rejects.toThrow('Not a run id');
    await expect(
      client.updateRun('run-1?x=1', { summary: 's' }),
    ).rejects.toThrow('Not a run id');
    expect(fn).not.toHaveBeenCalled();
  });

  it('surfaces the backend sentence and status on a non-2xx — a 409 from the status machine reads as itself', async () => {
    const { fn } = fakeFetch(() => ({
      status: 409,
      body: { error: 'A done run is finished; it cannot become running.' },
    }));
    const client = createLedgerClient({
      baseUrl: 'http://api.test',
      fetch: fn,
    });

    const failure = await client
      .updateRun('run-abc1234', { status: 'running' })
      .catch((e) => e);

    expect(failure).toBeInstanceOf(LedgerRequestError);
    expect(failure.status).toBe(409);
    expect(failure.message).toBe(
      'A done run is finished; it cannot become running.',
    );
  });

  it('falls back to a generic line when the error body is not JSON', async () => {
    const { fn } = fakeFetch(() => ({ status: 502 }));
    const client = createLedgerClient({
      baseUrl: 'http://api.test',
      fetch: fn,
    });

    await expect(client.getRun('run-abc1234')).rejects.toThrow(
      'Request failed: 502 GET /agent-runs/run-abc1234',
    );
  });

  it('encodes list filters as query params, statuses comma-joined', async () => {
    const { fn, calls } = fakeFetch(() => ({
      status: 200,
      body: { items: [], nextCursor: null },
    }));
    const client = createLedgerClient({
      baseUrl: 'http://api.test',
      fetch: fn,
    });

    await client.listRuns({
      ownerMemberId: 'mem-1',
      status: ['running', 'blocked'],
      limit: 10,
    });

    expect(calls[0].url).toBe(
      'http://api.test/agent-runs?ownerMemberId=mem-1&status=running%2Cblocked&limit=10',
    );
    expect(calls[0].init?.method).toBe('GET');
    expect(calls[0].init?.body).toBeUndefined();
  });

  it('listAllRuns follows nextCursor until it is null', async () => {
    const pages: Record<string, unknown> = {
      '': { items: [{ id: 'run-1' }], nextCursor: 'c1' },
      c1: { items: [{ id: 'run-2' }], nextCursor: 'c2' },
      c2: { items: [{ id: 'run-3' }], nextCursor: null },
    };
    const { fn, calls } = fakeFetch(({ url }) => {
      const cursor = new URL(url).searchParams.get('cursor') ?? '';
      return { status: 200, body: pages[cursor] };
    });
    const client = createLedgerClient({
      baseUrl: 'http://api.test',
      fetch: fn,
    });

    const all = await client.listAllRuns({ status: ['running'] });

    expect(all.map((r) => r.id)).toEqual(['run-1', 'run-2', 'run-3']);
    expect(calls).toHaveLength(3);
    expect(new URL(calls[0].url).searchParams.get('limit')).toBe('100');
  });

  it('appendEvent POSTs kind and payload to the run’s events', async () => {
    const { fn, calls } = fakeFetch(() => ({
      status: 201,
      body: { runId: 'run-abc1234', seq: 2, kind: 'note' },
    }));
    const client = createLedgerClient({
      baseUrl: 'http://api.test',
      fetch: fn,
    });

    const event = await client.appendEvent('run-abc1234', 'worktree_created', {
      path: '/tmp/wt',
    });

    expect(event.seq).toBe(2);
    expect(calls[0].url).toBe('http://api.test/agent-runs/run-abc1234/events');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      kind: 'worktree_created',
      payload: { path: '/tmp/wt' },
    });
  });

  it('defaults the base URL to the backend’s 14000 when neither option nor env is set', async () => {
    const saved = process.env.WAYPOINT_API_BASE_URL;
    delete process.env.WAYPOINT_API_BASE_URL;
    try {
      const { fn, calls } = fakeFetch(() => ({ status: 200, body: RUN }));
      await createLedgerClient({ fetch: fn }).getRun('run-abc1234');
      expect(calls[0].url).toBe(
        'http://localhost:14000/agent-runs/run-abc1234',
      );
    } finally {
      if (saved !== undefined) process.env.WAYPOINT_API_BASE_URL = saved;
    }
  });
});

// W5b (docs/design/w5b-jira-dispatch.md §2.4, §2.7): the borrowed Jira
// credential rides only the requests that need it, and a Jira issue's
// handle and a typed key have their own reads.
describe('W5b: Jira issues', () => {
  const header = 'base64-of-the-credential';

  it('isTicketRef: the prefix alone says which system owns the ticket', () => {
    expect(isTicketRef('tref-abc1234')).toBe(true);
    expect(isTicketRef('wi-1')).toBe(false);
    expect(isTicketRef(null)).toBe(false);
    expect(isTicketRef(undefined)).toBe(false);
  });

  it('createRunProposal sends the credential header for an external ticket only', async () => {
    const { fn, calls } = fakeFetch(() => ({
      status: 201,
      body: { id: 'prop-1' },
    }));
    const jiraCredentialHeader = jest.fn(() => header);
    const client = createLedgerClient({
      baseUrl: 'http://api.test',
      fetch: fn,
      jiraCredentialHeader,
    });

    await client.createRunProposal('run-abc1234', {
      kind: 'comment',
      body: 'x',
    });
    expect(calls[0].init?.headers).toEqual({
      'content-type': 'application/json',
    });
    expect(jiraCredentialHeader).not.toHaveBeenCalled();

    await client.createRunProposal(
      'run-abc1234',
      { kind: 'state_change', stateId: '21' },
      { external: true },
    );
    expect(calls[1].init?.headers).toEqual({
      'content-type': 'application/json',
      [JIRA_CREDENTIAL_HEADER]: header,
    });
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      kind: 'state_change',
      stateId: '21',
    });
  });

  it('with nothing connected the header is simply absent', async () => {
    const { fn, calls } = fakeFetch(() => ({
      status: 201,
      body: { id: 'prop-1' },
    }));
    const client = createLedgerClient({
      baseUrl: 'http://api.test',
      fetch: fn,
      jiraCredentialHeader: () => null,
    });
    await client.createRunProposal(
      'run-abc1234',
      { kind: 'comment', body: 'x' },
      { external: true },
    );
    expect(calls[0].init?.headers).toEqual({
      'content-type': 'application/json',
    });
  });

  it('resolveTicket GETs /tickets/resolve/:key with the credential, null on 404, the backend sentence on 409', async () => {
    const { fn, calls } = fakeFetch(({ url }) => {
      if (url.endsWith('/ENG-4')) {
        return {
          status: 200,
          body: {
            provider: 'jira',
            id: 'tref-abc1234',
            identifier: 'ENG-4',
            title: 'Checkout 500s',
            projectId: 'ENG',
            url: 'https://yourteam.atlassian.net/browse/ENG-4',
          },
        };
      }
      if (url.endsWith('/ENG-9')) {
        return { status: 409, body: { error: '"ENG-9" is ambiguous: …' } };
      }
      return { status: 404, body: { error: 'ticket not found' } };
    });
    const client = createLedgerClient({
      baseUrl: 'http://api.test',
      fetch: fn,
      jiraCredentialHeader: () => header,
    });

    expect(await client.resolveTicket('ENG-4')).toEqual({
      provider: 'jira',
      id: 'tref-abc1234',
      identifier: 'ENG-4',
      title: 'Checkout 500s',
      projectId: 'ENG',
      url: 'https://yourteam.atlassian.net/browse/ENG-4',
    });
    expect(calls[0].url).toBe('http://api.test/tickets/resolve/ENG-4');
    expect(calls[0].init?.method).toBe('GET');
    expect(calls[0].init?.headers).toEqual({
      [JIRA_CREDENTIAL_HEADER]: header,
    });

    expect(await client.resolveTicket('ENG-7')).toBeNull();
    await expect(client.resolveTicket('ENG-9')).rejects.toThrow(/ambiguous/);
    await expect(client.resolveTicket('../x')).rejects.toThrow(
      /Not a ticket key/,
    );
    expect(calls).toHaveLength(3);
  });

  it('getTicketRef reads /ticket-refs/:id (null for a native id without a request, null on 404); rememberTicketRef POSTs the key', async () => {
    const row = {
      id: 'tref-abc1234',
      provider: 'jira',
      site: 'yourteam.atlassian.net',
      externalId: 'ENG-4',
      identifier: 'ENG-4',
      title: 'Checkout 500s',
      url: 'https://yourteam.atlassian.net/browse/ENG-4',
    };
    const { fn, calls } = fakeFetch(({ url, init }) => {
      if (init?.method === 'POST') return { status: 201, body: row };
      return url.endsWith('/tref-abc1234')
        ? { status: 200, body: row }
        : { status: 404, body: { error: 'ticket ref not found' } };
    });
    const client = createLedgerClient({
      baseUrl: 'http://api.test',
      fetch: fn,
    });

    expect(await client.getTicketRef('wi-1')).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await client.getTicketRef('tref-abc1234')).toEqual({
      id: 'tref-abc1234',
      provider: 'jira',
      site: 'yourteam.atlassian.net',
      key: 'ENG-4',
      identifier: 'ENG-4',
      title: 'Checkout 500s',
      url: 'https://yourteam.atlassian.net/browse/ENG-4',
    });
    expect(await client.getTicketRef('tref-nope')).toBeNull();

    const minted = await client.rememberTicketRef({
      site: 'yourteam.atlassian.net',
      key: 'ENG-4',
      title: 'Checkout 500s',
    });
    expect(minted.id).toBe('tref-abc1234');
    expect(calls[2].url).toBe('http://api.test/ticket-refs');
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({
      provider: 'jira',
      site: 'yourteam.atlassian.net',
      key: 'ENG-4',
      title: 'Checkout 500s',
    });
    // No credential on a ref write: the row holds no secret.
    expect(calls[2].init?.headers).toEqual({
      'content-type': 'application/json',
    });
    await expect(
      client.rememberTicketRef({ site: 'x', key: 'not a key', title: '' }),
    ).rejects.toThrow(/Not a Jira issue key/);
  });
});
