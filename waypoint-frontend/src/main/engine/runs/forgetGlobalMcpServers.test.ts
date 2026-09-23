import type { EngineSupervisor } from '../supervisor';
import type { EngineStatus, WireClient } from '../types';

const removeMcpServer = jest.fn<Promise<void>, [string]>(async () => {});
jest.mock('./daemonApi', () => ({
  createDaemonRunsApi: jest.fn(() => ({
    removeMcpServer: (name: string) => removeMcpServer(name),
  })),
}));

// eslint-disable-next-line import/order, import/first
import {
  FORMERLY_REGISTERED_SERVER_NAMES,
  forgetGlobalMcpServers,
} from './forgetGlobalMcpServers';

const running = (since: number): EngineStatus =>
  ({ kind: 'running', since }) as unknown as EngineStatus;
const stopped = { kind: 'stopped' } as unknown as EngineStatus;

function fakeSupervisor(initial: EngineStatus) {
  let status = initial;
  const listeners = new Set<(s: EngineStatus) => void>();
  const client = {} as unknown as WireClient;
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

const logger = { info: jest.fn(), warn: jest.fn() };
const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

beforeEach(() => {
  jest.clearAllMocks();
  removeMcpServer.mockImplementation(async () => {});
});

describe('forgetGlobalMcpServers', () => {
  it("removes both names an older build wrote into the person's config", async () => {
    const supervisor = fakeSupervisor(running(1));
    forgetGlobalMcpServers({ supervisor, logger });
    await flush();
    expect(removeMcpServer.mock.calls.map((c) => c[0])).toEqual([
      ...FORMERLY_REGISTERED_SERVER_NAMES,
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('removed'),
      { removed: [...FORMERLY_REGISTERED_SERVER_NAMES] },
    );
  });

  it('runs once per connection, not per status event', async () => {
    const supervisor = fakeSupervisor(running(1));
    forgetGlobalMcpServers({ supervisor, logger });
    await flush();
    expect(removeMcpServer).toHaveBeenCalledTimes(2);

    supervisor.emit(running(1));
    await flush();
    expect(removeMcpServer).toHaveBeenCalledTimes(2);

    // A genuinely new connection tries again — the person may have been
    // running an older build against a different daemon in between.
    supervisor.emit(stopped);
    supervisor.emit(running(2));
    await flush();
    expect(removeMcpServer).toHaveBeenCalledTimes(4);
  });

  it('is quiet when there was nothing to remove, and never throws', async () => {
    // The ordinary case on a fresh install: the names were never there.
    removeMcpServer.mockRejectedValue(new Error('no such server'));
    const supervisor = fakeSupervisor(running(1));
    await expect(
      (async () => {
        forgetGlobalMcpServers({ supervisor, logger });
        await flush();
      })(),
    ).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining('removed'),
      expect.anything(),
    );
  });

  it('does nothing until the daemon is reachable', async () => {
    const supervisor = fakeSupervisor(stopped);
    forgetGlobalMcpServers({ supervisor, logger });
    await flush();
    expect(removeMcpServer).not.toHaveBeenCalled();
  });
});
