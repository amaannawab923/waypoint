import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EngineSupervisor } from '../supervisor';
import type { EngineStatus, WireClient } from '../types';
import {
  SESSION_BROWSER_SERVER_NAME,
  registerSessionBrowser,
  sessionBrowserEntry,
  sessionBrowserServer,
} from './sessionBrowser';

const saveMcpServer = jest.fn<Promise<void>, [unknown]>(async () => {});
jest.mock('./daemonApi', () => ({
  createDaemonRunsApi: jest.fn(() => ({
    saveMcpServer: (server: unknown) => saveMcpServer(server),
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
const stopped = { kind: 'stopped' } as unknown as EngineStatus;

function fakeSupervisor(initial: EngineStatus) {
  let status = initial;
  const listeners = new Set<(s: EngineStatus) => void>();
  const client = {} as unknown as WireClient;
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

const logger = { info: jest.fn(), warn: jest.fn() };
const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

beforeEach(() => {
  jest.clearAllMocks();
  saveMcpServer.mockImplementation(async () => {});
});

// The registration checks the entry exists before writing it: every
// registration test points at this checkout, where the vendored server is.
const appPath = path.resolve(__dirname, '../../../..');
const expectedServer = sessionBrowserServer(
  '/bin/waypoint',
  sessionBrowserEntry(appPath),
);

describe('sessionBrowserServer', () => {
  it("is this app's own binary as node running the vendored chrome-devtools-mcp, isolated and headless, for the claude provider", () => {
    const server = sessionBrowserServer(
      '/Applications/Waypoint.app/Contents/MacOS/Waypoint',
      '/app/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js',
    );
    expect(server.name).toBe(SESSION_BROWSER_SERVER_NAME);
    expect(server.transport).toBe('stdio');
    // Never `npx`: the daemon's PATH is not ours to trust (a Node 18 on it
    // made the server refuse to start on the first live run).
    expect(server.command).toBe(
      '/Applications/Waypoint.app/Contents/MacOS/Waypoint',
    );
    expect(server.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(server.args).toEqual([
      '/app/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js',
      '--isolated',
      '--headless',
    ]);
    // Never the person's own Chrome: no --autoConnect, no --browserUrl.
    expect(server.args.join(' ')).not.toMatch(/autoConnect|browserUrl/);
    expect(server.providers).toEqual(['claude']);
  });

  it('names the entry under the app path, and this checkout really has it at the pinned version', () => {
    expect(sessionBrowserEntry('/app')).toBe(
      '/app/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js',
    );
    const here = sessionBrowserEntry(appPath);
    expect(fs.existsSync(here)).toBe(true);
    const pkg = path.join(
      appPath,
      'node_modules',
      'chrome-devtools-mcp',
      'package.json',
    );
    expect(JSON.parse(fs.readFileSync(pkg, 'utf8')).version).toBe('1.9.0');
  });
});

describe('registerSessionBrowser', () => {
  it('registers once per connection: at boot when already running, and again after a reconnect', async () => {
    const supervisor = fakeSupervisor(running(1));
    registerSessionBrowser({
      supervisor,
      appPath,
      execPath: '/bin/waypoint',
      logger,
    });
    await flush();
    expect(saveMcpServer).toHaveBeenCalledTimes(1);
    expect(saveMcpServer).toHaveBeenCalledWith(expectedServer);

    // The same connection reported again: nothing.
    supervisor.emit(running(1));
    await flush();
    expect(saveMcpServer).toHaveBeenCalledTimes(1);

    // A new connection: again.
    supervisor.emit(stopped);
    supervisor.emit(running(2));
    await flush();
    expect(saveMcpServer).toHaveBeenCalledTimes(2);
  });

  it('a failure is a warning, and the next connection tries again', async () => {
    saveMcpServer.mockRejectedValueOnce(new Error('daemon said no'));
    const supervisor = fakeSupervisor(stopped);
    registerSessionBrowser({
      supervisor,
      appPath,
      execPath: '/bin/waypoint',
      logger,
    });
    expect(saveMcpServer).not.toHaveBeenCalled();

    supervisor.emit(running(1));
    await flush();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('session browser not registered'),
      { message: 'daemon said no' },
    );
    supervisor.emit(running(2));
    await flush();
    expect(saveMcpServer).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      'engine: session browser registered',
      { name: SESSION_BROWSER_SERVER_NAME },
    );
  });

  it('stops listening when unsubscribed', async () => {
    const supervisor = fakeSupervisor(stopped);
    const off = registerSessionBrowser({
      supervisor,
      appPath,
      execPath: '/bin/waypoint',
      logger,
    });
    off();
    supervisor.emit(running(1));
    await flush();
    expect(saveMcpServer).not.toHaveBeenCalled();
  });
});

describe('registerSessionBrowser without the vendored server', () => {
  it('registers nothing and says why', async () => {
    const supervisor = fakeSupervisor(running(1));
    registerSessionBrowser({
      supervisor,
      appPath: '/nowhere',
      execPath: '/bin/waypoint',
      logger,
    });
    await flush();
    expect(saveMcpServer).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('not installed'),
      { entry: sessionBrowserEntry('/nowhere') },
    );
  });
});
