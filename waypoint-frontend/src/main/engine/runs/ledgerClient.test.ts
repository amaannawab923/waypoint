import { createLedgerClient, LedgerRequestError } from './ledgerClient';

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
