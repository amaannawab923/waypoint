import type { EngineSupervisor } from '../supervisor';
import type { EngineStatus, WireClient } from '../types';

const removeMcpServer = jest.fn<Promise<void>, [string]>(async () => {});
const listMcpForAgent = jest.fn<Promise<unknown[]>, [string]>(async () => []);
jest.mock('./daemonApi', () => ({
  createDaemonRunsApi: jest.fn(() => ({
    removeMcpServer: (name: string) => removeMcpServer(name),
    listMcpForAgent: (providerId: string) => listMcpForAgent(providerId),
  })),
}));

// eslint-disable-next-line import/order, import/first
import {
  FORMERLY_REGISTERED_SERVER_NAMES,
  forgetGlobalMcpServers,
  wasWrittenByWaypoint,
} from './forgetGlobalMcpServers';

const running = (since: number): EngineStatus =>
  ({ kind: 'running', since }) as unknown as EngineStatus;
const stopped = { kind: 'stopped' } as unknown as EngineStatus;

/** What an older Waypoint actually wrote into `~/.claude.json`. */
const ours = (name: string, script: string) => ({
  name,
  transport: 'stdio' as const,
  command: '/Applications/Waypoint.app/Contents/MacOS/Waypoint',
  args: [`/app/node_modules/${script}`],
  env: { ELECTRON_RUN_AS_NODE: '1' },
  providers: ['claude'],
});

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
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
};
const removedLog = () =>
  logger.info.mock.calls.filter((c) => String(c[0]).includes('removed'));

beforeEach(() => {
  jest.clearAllMocks();
  removeMcpServer.mockImplementation(async () => {});
  listMcpForAgent.mockImplementation(async () => []);
});

describe('wasWrittenByWaypoint', () => {
  it('recognises the two entry scripts Waypoint ever registered', () => {
    expect(
      wasWrittenByWaypoint(ours('waypoint-browser', 'chrome-devtools-mcp.js')),
    ).toBe(true);
    expect(
      wasWrittenByWaypoint(ours('waypoint-ultrafast', 'ultrafast-mcp.js')),
    ).toBe(true);
  });

  it("does not claim someone else's server that happens to share the name", () => {
    expect(
      wasWrittenByWaypoint({
        name: 'waypoint-browser',
        transport: 'stdio' as const,
        command: '/usr/local/bin/my-own-tool',
        args: ['--serve'],
        providers: ['claude'],
      }),
    ).toBe(false);
  });
});

describe('forgetGlobalMcpServers', () => {
  it('removes the entries an older build wrote, and only those', async () => {
    listMcpForAgent.mockResolvedValue([
      ours('waypoint-browser', 'chrome-devtools-mcp.js'),
      ours('waypoint-ultrafast', 'ultrafast-mcp.js'),
      // the person's own, untouched
      {
        name: 'playwright',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@playwright/mcp'],
        providers: ['claude'],
      },
    ]);
    forgetGlobalMcpServers({ supervisor: fakeSupervisor(running(1)), logger });
    await flush();

    expect(removeMcpServer.mock.calls.map((c) => c[0])).toEqual([
      ...FORMERLY_REGISTERED_SERVER_NAMES,
    ]);
    expect(removedLog()).toHaveLength(1);
  });

  it('is genuinely silent on a machine that never had them — and writes nothing', async () => {
    // The regression this replaces: the old test mocked removeMcpServer to
    // REJECT to prove quietness, but the real daemon resolves ok() for an
    // absent name, so the old code logged a removal on every machine
    // forever. Listing first is what makes silence real.
    listMcpForAgent.mockResolvedValue([]);
    forgetGlobalMcpServers({ supervisor: fakeSupervisor(running(1)), logger });
    await flush();

    expect(removeMcpServer).not.toHaveBeenCalled();
    expect(removedLog()).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('leaves a server the person registered under one of our names alone', async () => {
    listMcpForAgent.mockResolvedValue([
      {
        name: 'waypoint-browser',
        transport: 'stdio',
        command: '/usr/local/bin/my-own-tool',
        args: ['--serve'],
        providers: ['claude'],
      },
    ]);
    forgetGlobalMcpServers({ supervisor: fakeSupervisor(running(1)), logger });
    await flush();

    expect(removeMcpServer).not.toHaveBeenCalled();
  });

  it('reads once per connection, not per status event', async () => {
    const supervisor = fakeSupervisor(running(1));
    forgetGlobalMcpServers({ supervisor, logger });
    await flush();
    expect(listMcpForAgent).toHaveBeenCalledTimes(1);

    supervisor.emit(running(1));
    await flush();
    expect(listMcpForAgent).toHaveBeenCalledTimes(1);

    supervisor.emit(stopped);
    supervisor.emit(running(2));
    await flush();
    expect(listMcpForAgent).toHaveBeenCalledTimes(2);
  });

  it('a failed read deletes nothing and retries on the next connection', async () => {
    listMcpForAgent.mockRejectedValueOnce(new Error('daemon said no'));
    const supervisor = fakeSupervisor(running(1));
    forgetGlobalMcpServers({ supervisor, logger });
    await flush();
    expect(removeMcpServer).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not read'),
      { message: 'daemon said no' },
    );

    listMcpForAgent.mockResolvedValue([
      ours('waypoint-browser', 'chrome-devtools-mcp.js'),
    ]);
    supervisor.emit(running(2));
    await flush();
    expect(removeMcpServer).toHaveBeenCalledWith('waypoint-browser');
  });

  it('does nothing until the daemon is reachable', async () => {
    forgetGlobalMcpServers({ supervisor: fakeSupervisor(stopped), logger });
    await flush();
    expect(listMcpForAgent).not.toHaveBeenCalled();
  });
});
