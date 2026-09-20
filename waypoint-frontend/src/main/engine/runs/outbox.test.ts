import type { PendingPrompt } from '../types';
import type { DaemonRunsApi } from './daemonApi';
import type { AgentRun, LedgerClient } from './ledgerClient';
import {
  claimForInitialQueue,
  deliveredText,
  drain,
  markDelivered,
  MAX_AUTO_ATTEMPTS,
  openRows,
  resetAutoAttempts,
} from './outbox';

// The per-run outbox (never-lock, design §2.4): at-most-once delivery by
// a `sending` claim made before the daemon call, FIFO, a stale claim
// resolved before anything newer is sent, and the automatic-attempt bound.

const run = { id: 'run-abc1234', ownerMemberId: 'mem-1' } as AgentRun;

function row(over: Partial<PendingPrompt> = {}): PendingPrompt {
  return {
    id: `pp-${over.seq ?? 1}`,
    runId: 'run-abc1234',
    seq: 1,
    byMemberId: 'mem-1',
    text: 'hello',
    reason: 'starting',
    state: 'queued',
    autoAttempts: 0,
    lastError: null,
    claimedAt: null,
    resolvedAt: null,
    createdAt: '2026-09-20T00:00:00.000Z',
    ...over,
  };
}

function store(seed: PendingPrompt[]) {
  const rows = new Map(seed.map((r) => [r.id, r]));
  const ledger = {
    listPendingPrompts: jest.fn(async () => [...rows.values()]),
    createPendingPrompt: jest.fn(),
    updatePendingPrompt: jest.fn(
      async (_id: string, pendingId: string, patch: Partial<PendingPrompt>) => {
        const next = { ...rows.get(pendingId)!, ...patch } as PendingPrompt;
        rows.set(pendingId, next);
        return next;
      },
    ),
  } as unknown as jest.Mocked<LedgerClient>;
  return { ledger, rows };
}

const logger = { info: jest.fn(), warn: jest.fn() };

function daemonWith(over: Partial<Record<keyof DaemonRunsApi, unknown>> = {}) {
  return {
    sendPrompt: jest.fn(async () => {}),
    listSessions: jest.fn(async () => ({
      'run-abc1234': { conversationId: 'run-abc1234' },
    })),
    getHistory: jest.fn(async () => []),
    ...over,
  } as unknown as jest.Mocked<DaemonRunsApi>;
}

describe('openRows / deliveredText', () => {
  it('keeps queued, sending and unresolved rows, oldest first; drops delivered and dropped', () => {
    const rows = [
      row({ seq: 3, state: 'delivered' }),
      row({ seq: 2, state: 'sending' }),
      row({ seq: 4, state: 'dropped' }),
      row({ seq: 1 }),
      row({ seq: 5, state: 'unresolved' }),
    ];
    expect(openRows(rows).map((r) => r.seq)).toEqual([1, 2, 5]);
  });

  it("a teammate's message says who is speaking; the owner's is verbatim", () => {
    expect(deliveredText(row(), run, () => 'Ana')).toBe('hello');
    expect(deliveredText(row({ byMemberId: 'mem-2' }), run, () => 'Ana')).toBe(
      'From Ana in Waypoint:\n\nhello',
    );
    expect(deliveredText(row({ byMemberId: 'mem-2' }), run, () => null)).toBe(
      'From a teammate in Waypoint:\n\nhello',
    );
  });
});

describe('drain', () => {
  it('claims `sending` BEFORE the daemon call and `delivered` after; the first prompt carries the hiddenContext', async () => {
    const { ledger, rows } = store([
      row({ seq: 1, text: 'one' }),
      row({ seq: 2, text: 'two' }),
    ]);
    const daemon = daemonWith();
    const order: string[] = [];
    (ledger.updatePendingPrompt as jest.Mock).mockImplementation(
      async (_id: string, pendingId: string, patch: Partial<PendingPrompt>) => {
        order.push(`${pendingId}:${patch.state}`);
        const next = { ...rows.get(pendingId)!, ...patch } as PendingPrompt;
        rows.set(pendingId, next);
        return next;
      },
    );
    daemon.sendPrompt.mockImplementation(async (_r: string, text: string) => {
      order.push(`send:${text}`);
    });

    const result = await drain({ ledger, logger }, daemon, run, {
      trigger: 'send',
      hiddenContext: 'NOTE',
    });
    expect(result).toEqual({ delivered: 2, blockedBy: null });
    expect(order).toEqual([
      'pp-1:sending',
      'send:one',
      'pp-1:delivered',
      'pp-2:sending',
      'send:two',
      'pp-2:delivered',
    ]);
    expect(daemon.sendPrompt.mock.calls.map((c) => c[2])).toEqual([
      'NOTE',
      undefined,
    ]);
  });

  it('a refusal inside the acceptance window puts the row back to queued with the error, counted against the automatic bound, and stops', async () => {
    const { ledger, rows } = store([
      row({ seq: 1, text: 'one' }),
      row({ seq: 2, text: 'two' }),
    ]);
    const daemon = daemonWith({
      sendPrompt: jest.fn(async () => {
        throw new Error('acp.sendPrompt: invalid-state');
      }),
    });
    const result = await drain({ ledger, logger }, daemon, run, {
      trigger: 'mount',
    });
    expect(result.delivered).toBe(0);
    expect(result.blockedBy).toMatchObject({
      row: { id: 'pp-1' },
      why: 'spawn-failed',
    });
    expect(rows.get('pp-1')).toMatchObject({
      state: 'queued',
      autoAttempts: 1,
      lastError: 'acp.sendPrompt: invalid-state',
    });
    expect(rows.get('pp-2')?.state).toBe('queued');
    // A person's own send does not count.
    await drain({ ledger, logger }, daemon, run, { trigger: 'send' });
    expect(rows.get('pp-1')?.autoAttempts).toBe(0);
  });

  it(`an automatic drain leaves a row that failed ${MAX_AUTO_ATTEMPTS} times alone; a send tries it again`, async () => {
    const { ledger } = store([
      row({ seq: 1, autoAttempts: MAX_AUTO_ATTEMPTS }),
    ]);
    const daemon = daemonWith();
    expect(
      (await drain({ ledger, logger }, daemon, run, { trigger: 'focus' }))
        .blockedBy?.why,
    ).toBe('spawn-failed');
    expect(daemon.sendPrompt).not.toHaveBeenCalled();
    expect(
      (await drain({ ledger, logger }, daemon, run, { trigger: 'retry' }))
        .delivered,
    ).toBe(1);
  });

  describe('a `sending` row left by a host that died mid-call', () => {
    it('is delivered when the daemon already has its text in a recent user message', async () => {
      const { ledger, rows } = store([
        row({ seq: 1, state: 'sending', text: 'lost?' }),
      ]);
      const daemon = daemonWith({
        getHistory: jest.fn(async () => [
          {
            id: 't1',
            seq: 1,
            initiator: 'user',
            items: [{ kind: 'message', role: 'user', text: 'lost? ' }],
          },
        ]),
      });
      const result = await drain({ ledger, logger }, daemon, run, {
        trigger: 'boot',
      });
      expect(result).toEqual({ delivered: 1, blockedBy: null });
      expect(rows.get('pp-1')?.state).toBe('delivered');
      expect(daemon.sendPrompt).not.toHaveBeenCalled();
    });

    it('goes back to queued — and is sent — when the daemon has no session for the run any more', async () => {
      const { ledger, rows } = store([
        row({ seq: 1, state: 'sending', text: 'lost?' }),
      ]);
      const daemon = daemonWith({ listSessions: jest.fn(async () => ({})) });
      const result = await drain({ ledger, logger }, daemon, run, {
        trigger: 'boot',
      });
      expect(result.delivered).toBe(1);
      expect(rows.get('pp-1')?.state).toBe('delivered');
      expect(daemon.sendPrompt).toHaveBeenCalledWith(
        'run-abc1234',
        'lost?',
        undefined,
      );
    });

    it('is `unresolved` — and blocks everything behind it — when the daemon has the session but no trace of the text', async () => {
      const { ledger, rows } = store([
        row({ seq: 1, state: 'sending', text: 'lost?' }),
        row({ seq: 2, text: 'next' }),
      ]);
      const daemon = daemonWith();
      const result = await drain({ ledger, logger }, daemon, run, {
        trigger: 'boot',
      });
      expect(result).toMatchObject({
        delivered: 0,
        blockedBy: { row: { id: 'pp-1' }, why: 'unresolved' },
      });
      expect(rows.get('pp-1')?.state).toBe('unresolved');
      expect(rows.get('pp-2')?.state).toBe('queued');
      expect(daemon.sendPrompt).not.toHaveBeenCalled();
    });
  });

  it('`only` delivers just those rows — a send’s older-first, then its own text, then the rest', async () => {
    const { ledger, rows } = store([
      row({ seq: 1, text: 'older' }),
      row({ seq: 2, text: 'newer' }),
    ]);
    const daemon = daemonWith();
    await drain({ ledger, logger }, daemon, run, {
      trigger: 'send',
      only: new Set(['pp-1']),
    });
    expect(daemon.sendPrompt.mock.calls.map((c) => c[1])).toEqual(['older']);
    expect(rows.get('pp-2')?.state).toBe('queued');
  });
});

describe('claimForInitialQueue / markDelivered / resetAutoAttempts', () => {
  it('claims queued rows `sending` for a start’s initialQueue, in order, then marks them delivered', async () => {
    const { ledger, rows } = store([
      row({ seq: 2, text: 'b' }),
      row({ seq: 1, text: 'a' }),
      row({ seq: 3, state: 'unresolved' }),
    ]);
    const claimed = await claimForInitialQueue({ ledger, logger }, run);
    expect(claimed.map((c) => c.text)).toEqual(['a', 'b']);
    expect(rows.get('pp-1')?.state).toBe('sending');
    expect(rows.get('pp-3')?.state).toBe('unresolved');
    await markDelivered(
      { ledger, logger },
      run.id,
      claimed.map((c) => c.row),
    );
    expect(rows.get('pp-1')?.state).toBe('delivered');
    expect(rows.get('pp-2')?.state).toBe('delivered');
  });

  it('resetAutoAttempts zeroes only the rows that have any', async () => {
    const { ledger } = store([
      row({ seq: 1, autoAttempts: 2 }),
      row({ seq: 2 }),
    ]);
    await resetAutoAttempts({ ledger, logger }, run.id);
    expect(ledger.updatePendingPrompt).toHaveBeenCalledTimes(1);
    expect(ledger.updatePendingPrompt).toHaveBeenCalledWith(
      'run-abc1234',
      'pp-1',
      { autoAttempts: 0 },
    );
  });
});
