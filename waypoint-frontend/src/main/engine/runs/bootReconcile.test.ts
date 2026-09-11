import type { EngineSupervisor } from '../supervisor';
import type { EngineStatus, WireClient } from '../types';
import { registerBootReconcile } from './bootReconcile';
import type { LedgerClient } from './ledgerClient';

jest.mock('./daemonApi', () => ({
  createDaemonRunsApi: jest.fn(() => ({
    listSessions: jest.fn(async () => ({})),
    listWorkspaceRecords: jest.fn(async () => ({})),
    killSession: jest.fn(),
  })),
}));

const running = (since: number): EngineStatus =>
  ({
    kind: 'running',
    since,
    health: {},
    agreed: {},
    transport: 'socket',
  }) as unknown as EngineStatus;

function fakeSupervisor(initial: EngineStatus) {
  let status = initial;
  const listeners = new Set<(s: EngineStatus) => void>();
  const client = {
    call: jest.fn(),
    attach: jest.fn(),
    onDisconnect: jest.fn(),
    close: jest.fn(),
  } as unknown as WireClient;
  const supervisor: EngineSupervisor & { emit: (s: EngineStatus) => void } = {
    getStatus: () => status,
    install: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    health: jest.fn(),
    client: () => (status.kind === 'running' ? client : null),
    onStatusChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose: jest.fn(),
    emit: (next) => {
      status = next;
      listeners.forEach((cb) => cb(next));
    },
  };
  return supervisor;
}

function fakeLedger(
  listAllRuns: jest.Mock = jest.fn(async () => []),
): LedgerClient {
  return {
    listAllRuns,
    getRun: jest.fn(),
    updateRun: jest.fn(),
    appendEvent: jest.fn(),
  } as unknown as LedgerClient;
}

const logger = { info: jest.fn(), warn: jest.fn() };
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => jest.clearAllMocks());

describe('registerBootReconcile', () => {
  it('reconciles once per connection: the first running, not a repeat of the same one, and again after a reconnect', async () => {
    const supervisor = fakeSupervisor({
      kind: 'stopped',
      installDir: '/u',
      version: '0.1.0',
    });
    const listAllRuns = jest.fn(async () => []);
    const reports: unknown[] = [];
    registerBootReconcile({
      supervisor,
      ledger: fakeLedger(listAllRuns),
      logger,
      onReport: (r) => reports.push(r),
    });

    supervisor.emit(running(1));
    await flush();
    supervisor.emit(running(1));
    await flush();
    expect(listAllRuns).toHaveBeenCalledTimes(1);

    supervisor.emit({ kind: 'stopping', since: 2 });
    supervisor.emit(running(3));
    await flush();
    expect(listAllRuns).toHaveBeenCalledTimes(2);
    expect(reports).toHaveLength(2);
  });

  it('reconciles immediately when registered against a supervisor that is already running', async () => {
    const supervisor = fakeSupervisor(running(7));
    const listAllRuns = jest.fn(async () => []);

    registerBootReconcile({
      supervisor,
      ledger: fakeLedger(listAllRuns),
      logger,
    });
    await flush();

    expect(listAllRuns).toHaveBeenCalledTimes(1);
  });

  it('a backend that is down is a warning and a retry on the next connection, never a supervisor failure', async () => {
    const supervisor = fakeSupervisor(running(1));
    const listAllRuns = jest
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue([]);

    registerBootReconcile({
      supervisor,
      ledger: fakeLedger(listAllRuns),
      logger,
    });
    await flush();
    expect(logger.warn).toHaveBeenCalledWith(
      'engine: boot reconcile did not run',
      { message: 'fetch failed' },
    );

    // The same connection is not retried on its own …
    supervisor.emit(running(1));
    await flush();
    expect(listAllRuns).toHaveBeenCalledTimes(2);
  });

  it('stops listening when unsubscribed', async () => {
    const supervisor = fakeSupervisor({
      kind: 'stopped',
      installDir: '/u',
      version: '0.1.0',
    });
    const listAllRuns = jest.fn(async () => []);
    const unsubscribe = registerBootReconcile({
      supervisor,
      ledger: fakeLedger(listAllRuns),
      logger,
    });

    unsubscribe();
    supervisor.emit(running(1));
    await flush();

    expect(listAllRuns).not.toHaveBeenCalled();
  });
});
