import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EngineSupervisor } from '../supervisor';
import type { EngineStatus, WireClient } from '../types';
import {
  SESSION_BROWSER_SERVER_NAME,
  registerSessionBrowser,
  sessionBrowserEntry,
  sessionBrowserEntryCandidates,
  sessionBrowserServer,
  sessionBrowserSessionServer,
  resetSessionBrowserStateForTests,
} from './sessionBrowser';

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
  resetSessionBrowserStateForTests();
});

/** The session-scoped shape: the definition minus the config-file fields. */
const asSessionServer = (server: typeof expectedServer) => ({
  name: server.name,
  command: server.command,
  args: server.args,
  env: server.env,
});

// The registration checks the entry exists before writing it: every
// registration test points at this checkout, where the vendored server is.
const appPath = path.resolve(__dirname, '../../../..');
// The engine archive's own node, as EnginePaths.nodePath resolves it.
const NODE_PATH = '/data/engine/0.1.0/emdash-workspace-server/node';
const expectedServer = sessionBrowserServer(
  NODE_PATH,
  sessionBrowserEntry(appPath),
);

describe('sessionBrowserServer', () => {
  it("is this app's own binary as node running the vendored chrome-devtools-mcp, isolated, headless and phoning nobody, for the claude provider", () => {
    const server = sessionBrowserServer(
      NODE_PATH,
      '/app/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js',
    );
    expect(server.name).toBe(SESSION_BROWSER_SERVER_NAME);
    expect(server.transport).toBe('stdio');
    // Never `npx` — the daemon's PATH is not ours to trust (a Node 18 on
    // it made the server refuse to start on the first live run) — and
    // never this app's Electron binary either: macOS registers a child of
    // an .app bundle as a FOREGROUND app whatever ELECTRON_RUN_AS_NODE
    // says, which put a Dock tile on screen per server (2026-09-24).
    expect(server.command).toBe(NODE_PATH);
    // Nothing leaves the machine but the session's own browsing: usage
    // statistics off both ways the server reads it (on, it reports to
    // Google through a detached watchdog child spawned from OUR binary, one
    // per live server — the stray processes people saw), no CrUX URL
    // reports, and no daily npm update check (another detached child).
    // No ELECTRON_RUN_AS_NODE: this is a real node, not Electron wearing
    // node's clothes.
    expect(server.env).toEqual({
      CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
      CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
    });
    expect(server.args).toEqual([
      '/app/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js',
      '--isolated',
      '--headless',
      '--no-usage-statistics',
      '--no-performance-crux',
    ]);
    // Never the person's own Chrome: no --autoConnect, no --browserUrl.
    expect(server.args.join(' ')).not.toMatch(/autoConnect|browserUrl/);
    expect(server.providers).toEqual(['claude']);
  });

  it('names the entry under the app path — packaged, then release/app in development — and this checkout really has it at the pinned version', () => {
    expect(sessionBrowserEntryCandidates('/app')).toEqual([
      '/app/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js',
      '/app/release/app/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js',
    ]);
    // Packaged: the unpacked copy first — a spawned process cannot read
    // inside the archive.
    expect(
      sessionBrowserEntryCandidates(
        '/Applications/Waypoint.app/Contents/Resources/app.asar',
      )[0],
    ).toBe(
      '/Applications/Waypoint.app/Contents/Resources/app.asar.unpacked/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js',
    );
    // Nothing installed: the packaged path, for the warning to name.
    expect(sessionBrowserEntry('/nowhere')).toBe(
      '/nowhere/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js',
    );
    const here = sessionBrowserEntry(appPath);
    expect(here).toBe(sessionBrowserEntryCandidates(appPath)[1]);
    expect(fs.existsSync(here)).toBe(true);
    const pkg = path.join(
      appPath,
      'release',
      'app',
      'node_modules',
      'chrome-devtools-mcp',
      'package.json',
    );
    expect(JSON.parse(fs.readFileSync(pkg, 'utf8')).version).toBe('1.9.0');
  });
});

describe('registerSessionBrowser', () => {
  it('holds the server for this app\u2019s own sessions once a connection is up \u2014 and writes nothing to the person\u2019s config', async () => {
    const supervisor = fakeSupervisor(running(1));
    registerSessionBrowser({
      supervisor,
      appPath,
      nodePath: NODE_PATH,
      logger,
    });
    await flush();
    // The definition is available to sessionMcpServers.ts, which hands it
    // to each session this app starts.
    expect(sessionBrowserSessionServer()).toEqual(
      asSessionServer(expectedServer),
    );
    expect(logger.info).toHaveBeenCalledWith('engine: session browser ready', {
      name: SESSION_BROWSER_SERVER_NAME,
    });
    // The whole point of the change: nothing was persisted for other
    // sessions on the machine to inherit. The module no longer has a
    // daemon client call to make at all.
    expect(logger.warn).not.toHaveBeenCalled();

    // Still available across a reconnect.
    supervisor.emit(stopped);
    supervisor.emit(running(2));
    await flush();
    expect(sessionBrowserSessionServer()).toEqual(
      asSessionServer(expectedServer),
    );
  });

  it('stops listening when unsubscribed', async () => {
    const supervisor = fakeSupervisor(stopped);
    const off = registerSessionBrowser({
      supervisor,
      appPath,
      nodePath: NODE_PATH,
      logger,
    });
    off();
    supervisor.emit(running(1));
    await flush();
    expect(sessionBrowserSessionServer()).toBeNull();
  });
});

describe('registerSessionBrowser without the vendored server', () => {
  it('offers nothing and says why \u2014 a session starts without the tool', async () => {
    const supervisor = fakeSupervisor(running(1));
    registerSessionBrowser({
      supervisor,
      appPath: '/nowhere',
      nodePath: NODE_PATH,
      logger,
    });
    await flush();
    expect(sessionBrowserSessionServer()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('not installed'),
      { entry: sessionBrowserEntry('/nowhere') },
    );
  });
});
