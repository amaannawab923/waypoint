import type { EngineSupervisor } from '../supervisor';
import type { EngineStatus, WireClient } from '../types';
import type { AgentRun, LedgerClient } from './ledgerClient';
import {
  describePendingPermission,
  MAX_REASON_CHARS,
  registerLiveLedgerFollower,
} from './liveLedgerFollower';

const SESSIONS = 'acp.sessions.list';
const stateTopic = (id: string) =>
  `acp.session.state|${JSON.stringify({ conversationId: id })}`;

const running = (since: number): EngineStatus =>
  ({
    kind: 'running',
    since,
    health: {},
    agreed: {},
    transport: 'socket',
  }) as never;
const stopped: EngineStatus = {
  kind: 'stopped',
  installDir: '/u',
  version: '0.1.0',
} as never;

/** A daemon whose topics the test scripts: snapshots answered from `topics`, attach handlers kept to push with. */
function fakeDaemon() {
  const topics: Record<string, unknown> = { [SESSIONS]: {} };
  const attached = new Map<
    string,
    { onUpdate: (u: unknown) => void; onSnapshot: (v: unknown) => void }
  >();
  const detached: string[] = [];
  const client = {
    snapshot: jest.fn(async (topic: string) => ({
      generation: 1,
      sequence: 0,
      timestamp: 1,
      data: topics[topic],
    })),
    attach: jest.fn(async (topic: string, handlers) => {
      attached.set(topic, handlers);
      handlers.onSnapshot({ data: topics[topic] });
      return () => {
        attached.delete(topic);
        detached.push(topic);
      };
    }),
    call: jest.fn(),
    onDisconnect: jest.fn(),
    close: jest.fn(),
  } as unknown as jest.Mocked<WireClient>;
  return {
    client,
    attached,
    detached,
    set: (topic: string, value: unknown) => {
      topics[topic] = value;
    },
    /** Change the session list and push an update, the way the daemon does. */
    sessions: (value: Record<string, unknown>) => {
      topics[SESSIONS] = value;
      attached.get(SESSIONS)?.onUpdate({ delta: [] });
    },
  };
}

function fakeSupervisor(initial: EngineStatus, client: WireClient) {
  let status = initial;
  const listeners = new Set<(s: EngineStatus) => void>();
  return {
    getStatus: () => status,
    client: () => (status.kind === 'running' ? client : null),
    onStatusChange: (cb: (s: EngineStatus) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit: (next: EngineStatus) => {
      status = next;
      listeners.forEach((cb) => cb(next));
    },
  } as unknown as EngineSupervisor & { emit: (s: EngineStatus) => void };
}

function fakeLedger(rows: Record<string, Partial<AgentRun>>) {
  const ledger = {
    getRun: jest.fn(async (id: string) =>
      rows[id] ? ({ id, ...rows[id] } as AgentRun) : null,
    ),
    updateRun: jest.fn(async (id: string, patch: Partial<AgentRun>) => {
      rows[id] = { ...rows[id], ...patch };
      return { id, ...rows[id] } as AgentRun;
    }),
    appendEvent: jest.fn(async () => ({})),
  } as unknown as jest.Mocked<LedgerClient>;
  return { ledger, rows };
}

const logger = { info: jest.fn(), warn: jest.fn() };
const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
const session = (id: string, over: Record<string, unknown> = {}) => ({
  conversationId: id,
  providerId: 'claude',
  lifecycle: 'ready',
  isGenerating: false,
  pendingPermissionCount: 0,
  updatedAt: 1,
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe('describePendingPermission', () => {
  it('names the command for an execute call, the title otherwise, and a plain sentence when there is nothing', () => {
    expect(
      describePendingPermission({
        toolCall: {
          kind: 'execute-tool-call',
          title: 'Run tests',
          command: 'pnpm test',
        },
      }),
    ).toBe('Wants to run pnpm test');
    expect(
      describePendingPermission({
        toolCall: { kind: 'modify-file-tool-call', title: 'Edit src/a.ts' },
      }),
    ).toBe('Wants to edit src/a.ts');
    expect(describePendingPermission(undefined)).toBe(
      'Waiting for your permission',
    );
    // A heredoc: one line, cut well under the ledger's 2000-char cap.
    const long = describePendingPermission({
      toolCall: {
        kind: 'execute-tool-call',
        title: 'Run',
        command: `bash -c '${'x'.repeat(3000)}'\nsecond line`,
      },
    });
    expect(long.startsWith('Wants to run bash -c')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(
      MAX_REASON_CHARS + 'Wants to run '.length,
    );
    expect(long).not.toContain('second line');
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('registerLiveLedgerFollower', () => {
  it('attaches once per connection, and re-reads the list on every update', async () => {
    const daemon = fakeDaemon();
    const supervisor = fakeSupervisor(stopped, daemon.client);
    registerLiveLedgerFollower({
      supervisor,
      ledger: fakeLedger({}).ledger,
      notify: jest.fn(),
      logger,
      debounceMs: 0,
    });
    expect(daemon.client.attach).not.toHaveBeenCalled();

    supervisor.emit(running(1));
    supervisor.emit(running(1));
    await flush();
    expect(daemon.client.attach).toHaveBeenCalledTimes(1);
    expect(daemon.client.attach.mock.calls[0][0]).toBe(SESSIONS);
    await flush();
    expect(daemon.client.snapshot).toHaveBeenCalledWith(
      SESSIONS,
      expect.anything(),
    );

    supervisor.emit(stopped);
    expect(daemon.detached).toEqual([SESSIONS]);
    supervisor.emit(running(2));
    await flush();
    expect(daemon.client.attach).toHaveBeenCalledTimes(2);
  });

  it('a permission pending on a running run → blocked with the tool’s reason; answered → running again', async () => {
    const daemon = fakeDaemon();
    const supervisor = fakeSupervisor(running(1), daemon.client);
    const { ledger, rows } = fakeLedger({ 'run-a': { status: 'running' } });
    const notify = jest.fn();
    registerLiveLedgerFollower({
      supervisor,
      ledger,
      notify,
      logger,
      debounceMs: 0,
    });
    await flush();
    await flush();

    daemon.set(stateTopic('run-a'), {
      pendingPermissions: [
        {
          requestId: 'perm-1',
          toolCall: {
            kind: 'execute-tool-call',
            title: 'Run',
            command: 'pnpm test',
          },
        },
      ],
    });
    daemon.sessions({
      'run-a': session('run-a', { pendingPermissionCount: 1 }),
    });
    await flush();
    await flush();
    await flush();

    expect(ledger.updateRun).toHaveBeenCalledWith('run-a', {
      status: 'blocked',
      reason: 'The agent asked for a permission',
      blockedReason: 'Wants to run pnpm test',
    });
    expect(ledger.appendEvent).toHaveBeenCalledWith(
      'run-a',
      'permission_requested',
      {
        requestId: 'perm-1',
        reason: 'Wants to run pnpm test',
      },
    );
    expect(notify).toHaveBeenCalledWith({ runId: 'run-a', status: 'blocked' });
    expect(rows['run-a'].status).toBe('blocked');

    daemon.sessions({
      'run-a': session('run-a', { pendingPermissionCount: 0 }),
    });
    await flush();
    await flush();
    await flush();
    expect(ledger.updateRun).toHaveBeenLastCalledWith('run-a', {
      status: 'running',
      reason: 'The permission was answered',
      blockedReason: null,
    });
    expect(ledger.appendEvent).toHaveBeenLastCalledWith(
      'run-a',
      'permission_answered',
      {},
    );
    expect(notify).toHaveBeenLastCalledWith({
      runId: 'run-a',
      status: 'running',
    });
  });

  it('a second permission replacing the first refreshes the blocked reason without a status change', async () => {
    const daemon = fakeDaemon();
    daemon.set(stateTopic('run-a'), {
      pendingPermissions: [
        {
          requestId: 'p2',
          toolCall: {
            kind: 'execute-tool-call',
            title: 'rm',
            command: 'rm -f x',
          },
        },
      ],
    });
    daemon.set(SESSIONS, {
      'run-a': session('run-a', { pendingPermissionCount: 1, updatedAt: 5 }),
    });
    const supervisor = fakeSupervisor(running(1), daemon.client);
    const { ledger } = fakeLedger({
      'run-a': { status: 'blocked', blockedReason: 'Wants to write notes.txt' },
    });
    const notify = jest.fn();
    registerLiveLedgerFollower({
      supervisor,
      ledger,
      notify,
      logger,
      debounceMs: 0,
    });
    await flush();
    await flush();
    await flush();
    expect(ledger.updateRun).toHaveBeenCalledWith('run-a', {
      blockedReason: 'Wants to run rm -f x',
    });
    expect(ledger.appendEvent).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith({ runId: 'run-a', status: 'blocked' });

    // The same pending request again, unchanged: nothing more to write.
    daemon.sessions({
      'run-a': session('run-a', { pendingPermissionCount: 1, updatedAt: 6 }),
    });
    await flush();
    await flush();
    await flush();
    expect(ledger.updateRun).toHaveBeenCalledTimes(1);
  });

  it('judges only our runs, only when the facts change, and never a run that is not live', async () => {
    const daemon = fakeDaemon();
    daemon.set(SESSIONS, {
      'conv-other': session('conv-other', { pendingPermissionCount: 1 }),
      'run-done': session('run-done', { pendingPermissionCount: 1 }),
      'run-b': session('run-b', { pendingPermissionCount: 1 }),
    });
    const supervisor = fakeSupervisor(running(1), daemon.client);
    const { ledger } = fakeLedger({
      'run-done': { status: 'done' },
      'run-b': {
        status: 'blocked',
        blockedReason: 'Waiting for your permission',
      },
    });
    registerLiveLedgerFollower({
      supervisor,
      ledger,
      notify: jest.fn(),
      logger,
      debounceMs: 0,
    });
    await flush();
    await flush();
    await flush();

    // conv-other is not ours; run-done is over; run-b already says blocked.
    expect(ledger.getRun.mock.calls.map((c) => c[0]).sort()).toEqual([
      'run-b',
      'run-done',
    ]);
    expect(ledger.updateRun).not.toHaveBeenCalled();

    // The same facts pushed again are not re-judged (a pending request
    // with a new updatedAt would be — see the reason-refresh test).
    daemon.sessions({
      'run-b': session('run-b', { pendingPermissionCount: 1, updatedAt: 1 }),
    });
    await flush();
    await flush();
    expect(ledger.getRun).toHaveBeenCalledTimes(2);
  });

  it('a session that closes or vanishes marks a live run interrupted after the grace — unless it was cancelled meanwhile', async () => {
    jest.useFakeTimers();
    try {
      const daemon = fakeDaemon();
      daemon.set(SESSIONS, {
        'run-a': session('run-a'),
        'run-b': session('run-b', { pendingPermissionCount: 1 }),
      });
      const supervisor = fakeSupervisor(running(1), daemon.client);
      const { ledger, rows } = fakeLedger({
        'run-a': { status: 'running' },
        'run-b': {
          status: 'blocked',
          blockedReason: 'Waiting for your permission',
        },
      });
      const notify = jest.fn();
      registerLiveLedgerFollower({
        supervisor,
        ledger,
        notify,
        logger,
        debounceMs: 0,
        graceMs: 1000,
      });
      await jest.advanceTimersByTimeAsync(5);

      // run-a closes; run-b disappears from the list altogether.
      daemon.sessions({ 'run-a': session('run-a', { lifecycle: 'closed' }) });
      await jest.advanceTimersByTimeAsync(5);
      expect(ledger.updateRun).not.toHaveBeenCalled();

      // Stop got to run-b first (kill → cancelled) inside the grace.
      rows['run-b'].status = 'cancelled';
      await jest.advanceTimersByTimeAsync(1000);

      expect(ledger.updateRun).toHaveBeenCalledTimes(1);
      expect(ledger.updateRun).toHaveBeenCalledWith('run-a', {
        status: 'interrupted',
        reason: 'The daemon closed the session',
      });
      expect(ledger.appendEvent).toHaveBeenCalledWith(
        'run-a',
        'session_ended',
        {
          reason: 'interrupted',
          detail: 'The daemon closed the session',
        },
      );
      expect(notify).toHaveBeenCalledWith({
        runId: 'run-a',
        status: 'interrupted',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('a write the ledger refuses is logged and dropped, and a lost connection cancels pending grace timers', async () => {
    jest.useFakeTimers();
    try {
      const daemon = fakeDaemon();
      daemon.set(SESSIONS, {
        'run-a': session('run-a', { pendingPermissionCount: 1 }),
      });
      const supervisor = fakeSupervisor(running(1), daemon.client);
      const { ledger } = fakeLedger({ 'run-a': { status: 'running' } });
      ledger.updateRun.mockRejectedValueOnce(
        new Error('A cancelled run is finished; its record is read-only.'),
      );
      const notify = jest.fn();
      const dispose = registerLiveLedgerFollower({
        supervisor,
        ledger,
        notify,
        logger,
        debounceMs: 0,
        graceMs: 1000,
      });
      await jest.advanceTimersByTimeAsync(5);
      expect(logger.warn).toHaveBeenCalledWith(
        'engine: live follower could not write the run',
        expect.objectContaining({ runId: 'run-a', to: 'blocked' }),
      );
      expect(notify).not.toHaveBeenCalled();

      daemon.sessions({});
      await jest.advanceTimersByTimeAsync(5);
      supervisor.emit(stopped);
      await jest.advanceTimersByTimeAsync(2000);
      // The grace timer went with the connection: no interrupted write.
      expect(ledger.updateRun).toHaveBeenCalledTimes(1);
      dispose();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('W5a hooks', () => {
  it('reports the idle fact on its rising edge and on first sight, never while generating or with something queued', async () => {
    const daemon = fakeDaemon();
    const supervisor = fakeSupervisor(running(1), daemon.client);
    const { ledger } = fakeLedger({ 'run-a': { status: 'running' } });
    const onSessionIdle = jest.fn();
    // First sight: a session whose turn already ended.
    daemon.set(SESSIONS, {
      'run-a': session('run-a', {
        lastStopReason: 'end_turn',
        queuedPromptCount: 0,
      }),
    });
    registerLiveLedgerFollower({
      supervisor,
      ledger,
      notify: jest.fn(),
      onSessionIdle,
      logger,
      debounceMs: 0,
    });
    await flush();
    await flush();
    expect(onSessionIdle).toHaveBeenCalledTimes(1);
    expect(onSessionIdle).toHaveBeenCalledWith('run-a');

    // Still idle on the next update: not reported again.
    daemon.sessions({
      'run-a': session('run-a', {
        lastStopReason: 'end_turn',
        queuedPromptCount: 0,
        updatedAt: 2,
      }),
    });
    await flush();
    await flush();
    expect(onSessionIdle).toHaveBeenCalledTimes(1);

    // A new turn: generating, then a prompt queued — neither is idle.
    daemon.sessions({
      'run-a': session('run-a', {
        isGenerating: true,
        lastStopReason: 'end_turn',
      }),
    });
    await flush();
    await flush();
    daemon.sessions({
      'run-a': session('run-a', {
        lastStopReason: 'end_turn',
        queuedPromptCount: 1,
      }),
    });
    await flush();
    await flush();
    expect(onSessionIdle).toHaveBeenCalledTimes(1);

    // The turn ends with nothing queued: the rising edge.
    daemon.sessions({
      'run-a': session('run-a', {
        lastStopReason: 'end_turn',
        queuedPromptCount: 0,
      }),
    });
    await flush();
    await flush();
    expect(onSessionIdle).toHaveBeenCalledTimes(2);

    // A cancelled turn is not a finished one.
    daemon.sessions({ 'run-a': session('run-a', { isGenerating: true }) });
    await flush();
    await flush();
    daemon.sessions({
      'run-a': session('run-a', { lastStopReason: 'cancelled' }),
    });
    await flush();
    await flush();
    expect(onSessionIdle).toHaveBeenCalledTimes(2);
  });

  it('reports every status it writes through onRunStatus, with the status it left', async () => {
    const daemon = fakeDaemon();
    const supervisor = fakeSupervisor(running(1), daemon.client);
    const { ledger } = fakeLedger({ 'run-a': { status: 'running' } });
    const onRunStatus = jest.fn();
    registerLiveLedgerFollower({
      supervisor,
      ledger,
      notify: jest.fn(),
      onRunStatus,
      logger,
      debounceMs: 0,
    });
    await flush();
    await flush();
    daemon.set(stateTopic('run-a'), {
      pendingPermissions: [
        { requestId: 'p1', toolCall: { title: 'Edit a.ts' } },
      ],
    });
    daemon.sessions({
      'run-a': session('run-a', { pendingPermissionCount: 1 }),
    });
    await flush();
    await flush();
    expect(onRunStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'run-a',
        status: 'blocked',
        blockedReason: 'Wants to edit a.ts',
      }),
      'running',
    );
    daemon.sessions({
      'run-a': session('run-a', { pendingPermissionCount: 0 }),
    });
    await flush();
    await flush();
    expect(onRunStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'running' }),
      'blocked',
    );
  });
});

describe('beforeInterrupted (ROAD-124)', () => {
  it('is awaited before a vanished session marks its run interrupted', async () => {
    const daemon = fakeDaemon();
    const supervisor = fakeSupervisor(running(1), daemon.client);
    const { ledger } = fakeLedger({ 'run-a': { status: 'running' } });
    const order: string[] = [];
    const beforeInterrupted = jest.fn(async () => {
      order.push('capture');
    });
    ledger.updateRun.mockImplementation(async (id, patch) => {
      order.push(`write:${patch.status}`);
      return { id, ...patch } as never;
    });
    daemon.set(SESSIONS, { 'run-a': session('run-a') });
    registerLiveLedgerFollower({
      supervisor,
      ledger,
      notify: jest.fn(),
      beforeInterrupted,
      logger,
      debounceMs: 0,
      graceMs: 0,
    });
    await flush();
    await flush();
    daemon.sessions({});
    await flush();
    await flush();
    await flush();
    expect(order).toEqual(['capture', 'write:interrupted']);
  });
});
