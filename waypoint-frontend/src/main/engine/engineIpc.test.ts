import type { BrowserWindow } from 'electron';
import type { EngineHealth, EngineStatus } from './types';
import type { EngineSupervisor } from './supervisor';

const ipcMainHandleMock = jest.fn();
// Mirrors jiraIpc.test.ts's own electron mock: only the surface this file
// actually touches (ipcMain.handle, plus `app` for createDefaultEngineSupervisor,
// which no test here ever calls — see below).
const appOnMock = jest.fn();
jest.mock('electron', () => ({
  ipcMain: { handle: ipcMainHandleMock },
  app: {
    getPath: jest.fn(() => '/tmp/waypoint-test-userdata'),
    on: appOnMock,
    off: jest.fn(),
  },
  shell: { showItemInFolder: jest.fn() },
  dialog: { showOpenDialog: jest.fn(async () => ({ canceled: true, filePaths: [] })) },
}));

// Deliberately NOT hoisted to the top of the file with the type-only
// imports above (and exempted from import/order's own auto-fix, which
// would otherwise move it back and reintroduce this exact bug — see
// preload.test.ts's own header comment for the same fix on the same class
// of bug): engineIpc.ts has a module-level side effect
// (`registerEngineIpc`'s default parameter reads `ipcMain`/`app` off
// `electron` when this module is imported) that must run only after the
// mock above is fully set up.
// eslint-disable-next-line import/order, import/first
import { registerEngineIpc } from './engineIpc';
// eslint-disable-next-line import/order, import/first
import { ENGINE_IPC, RUNS_IPC } from './types';

const NOT_INSTALLED: EngineStatus = {
  kind: 'not-installed',
  installDir: '/userdata/engine/0.1.0',
};
const STOPPED: EngineStatus = {
  kind: 'stopped',
  installDir: '/userdata/engine/0.1.0',
  version: '0.1.0',
};
const HEALTH: EngineHealth = {
  status: 'ok',
  version: '0.1.0',
  uptimeMs: 10,
  protocolVersion: '1.0.0',
};

/** A fake EngineSupervisor whose onStatusChange listener is exposed as
 *  `emit`, so a test can simulate the daemon transitioning on its own
 *  (e.g. an unexpected disconnect) without going through start()/stop(). */
function fakeSupervisor(
  initial: EngineStatus = NOT_INSTALLED,
): EngineSupervisor & {
  emit: (status: EngineStatus) => void;
} {
  let status = initial;
  const listeners = new Set<(status: EngineStatus) => void>();
  return {
    getStatus: jest.fn(() => status),
    install: jest.fn(() => Promise.resolve(status)),
    start: jest.fn(() => Promise.resolve(status)),
    stop: jest.fn(() => Promise.resolve(status)),
    health: jest.fn(() => Promise.resolve(null)),
    client: jest.fn(() => null),
    onStatusChange: jest.fn((cb: (status: EngineStatus) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    dispose: jest.fn(),
    emit: (next) => {
      status = next;
      listeners.forEach((cb) => cb(next));
    },
  };
}

function getHandler(channel: string) {
  const call = ipcMainHandleMock.mock.calls.find((c) => c[0] === channel);
  if (!call)
    throw new Error(`ipcMain.handle was never called with "${channel}"`);
  return call[1] as (event: unknown, ...args: unknown[]) => unknown;
}

/** A webContents that records its listeners so a test can fire them. */
function fakeContents() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    send: jest.fn(),
    on: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
    }),
    fire: (event: string, ...args: unknown[]) =>
      listeners.get(event)?.(...args),
  };
}

const WINDOW = {
  isDestroyed: jest.fn(() => false),
  webContents: fakeContents(),
} as unknown as BrowserWindow & {
  webContents: ReturnType<typeof fakeContents>;
};
const getWindowMock = jest.fn<BrowserWindow | null, []>(() => WINDOW);

beforeEach(() => {
  jest.clearAllMocks();
  ipcMainHandleMock.mockClear();
  (WINDOW.isDestroyed as jest.Mock).mockReturnValue(false);
  getWindowMock.mockReturnValue(WINDOW);
});

describe('registerEngineIpc', () => {
  it('registers a handler for every ENGINE_IPC request/response channel', () => {
    registerEngineIpc(getWindowMock, fakeSupervisor());

    const registered = ipcMainHandleMock.mock.calls.map((c) => c[0]);
    expect(registered).toEqual(
      expect.arrayContaining([
        ENGINE_IPC.status,
        ENGINE_IPC.install,
        ENGINE_IPC.start,
        ENGINE_IPC.stop,
        ENGINE_IPC.health,
        // W3's run control (runsIpc.ts), registered on the same ipcMain.
        RUNS_IPC.stop,
        RUNS_IPC.diff,
        RUNS_IPC.revealWorktree,
      ]),
    );
    // statusChanged is a push channel, not a handle() channel — it must
    // never appear here, only in webContents.send below.
    expect(registered).not.toContain(ENGINE_IPC.statusChanged);
  });

  describe('engine:status', () => {
    it('answers synchronously from supervisor.getStatus(), never throwing', () => {
      const supervisor = fakeSupervisor(STOPPED);
      registerEngineIpc(getWindowMock, supervisor);
      // Registration itself looks once (the boot reconcile checks whether
      // the daemon is already connected); the handler's own call is what
      // this test counts.
      (supervisor.getStatus as jest.Mock).mockClear();

      const result = getHandler(ENGINE_IPC.status)({});

      expect(result).toEqual(STOPPED);
      expect(supervisor.getStatus).toHaveBeenCalledTimes(1);
    });
  });

  describe('engine:install / engine:start / engine:stop', () => {
    it.each([
      [ENGINE_IPC.install, 'install'] as const,
      [ENGINE_IPC.start, 'start'] as const,
      [ENGINE_IPC.stop, 'stop'] as const,
    ])(
      '%s delegates to supervisor.%s() and returns its resolved status',
      async (channel, method) => {
        const supervisor = fakeSupervisor();
        (supervisor[method] as jest.Mock).mockResolvedValue(STOPPED);
        registerEngineIpc(getWindowMock, supervisor);

        const result = await getHandler(channel)({});

        expect(result).toEqual(STOPPED);
        expect(supervisor[method]).toHaveBeenCalledTimes(1);
      },
    );
  });

  describe('engine:health', () => {
    it('delegates to supervisor.health() and returns EngineHealth on a live connection', async () => {
      const supervisor = fakeSupervisor();
      (supervisor.health as jest.Mock).mockResolvedValue(HEALTH);
      registerEngineIpc(getWindowMock, supervisor);

      const result = await getHandler(ENGINE_IPC.health)({});

      expect(result).toEqual(HEALTH);
    });

    it('returns null when there is no live connection to ask', async () => {
      const supervisor = fakeSupervisor();
      (supervisor.health as jest.Mock).mockResolvedValue(null);
      registerEngineIpc(getWindowMock, supervisor);

      await expect(getHandler(ENGINE_IPC.health)({})).resolves.toBeNull();
    });
  });

  describe('statusChanged push channel', () => {
    it('pushes every status transition to the current window, in order', () => {
      const supervisor = fakeSupervisor(NOT_INSTALLED);
      registerEngineIpc(getWindowMock, supervisor);

      supervisor.emit(STOPPED);
      supervisor.emit({ kind: 'starting', since: 1 });

      expect(WINDOW.webContents.send).toHaveBeenNthCalledWith(
        1,
        ENGINE_IPC.statusChanged,
        STOPPED,
      );
      expect(WINDOW.webContents.send).toHaveBeenNthCalledWith(
        2,
        ENGINE_IPC.statusChanged,
        {
          kind: 'starting',
          since: 1,
        },
      );
    });

    // Matches copilotConnect.ts's own `send` helper exactly: a window
    // closed and reopened is a different object, and a transition that
    // lands with no window open (or a destroyed one) must not throw.
    it('does not throw and does not send when there is no current window', () => {
      const supervisor = fakeSupervisor();
      getWindowMock.mockReturnValue(null);
      registerEngineIpc(getWindowMock, supervisor);

      expect(() => supervisor.emit(STOPPED)).not.toThrow();
      expect(WINDOW.webContents.send).not.toHaveBeenCalled();
    });

    it('does not send to a window that has been destroyed', () => {
      const supervisor = fakeSupervisor();
      (WINDOW.isDestroyed as jest.Mock).mockReturnValue(true);
      registerEngineIpc(getWindowMock, supervisor);

      supervisor.emit(STOPPED);

      expect(WINDOW.webContents.send).not.toHaveBeenCalled();
    });

    it('releases the panel’s topic attachments only when the app window’s own document goes away — not DevTools or another webContents', async () => {
      const supervisor = fakeSupervisor(STOPPED);
      // A connected client, so a topic can be subscribed.
      const client = {
        attach: jest.fn(),
        call: jest.fn(),
        snapshot: jest.fn(),
        onDisconnect: jest.fn(),
        close: jest.fn(),
      };
      (supervisor.client as jest.Mock).mockReturnValue(client);
      registerEngineIpc(getWindowMock, supervisor);
      const onCreated = appOnMock.mock.calls.find(
        (c) => c[0] === 'web-contents-created',
      )?.[1] as (event: unknown, contents: unknown) => void;
      expect(onCreated).toBeDefined();

      // The app window's first load identifies it; a same-document
      // (pushState) navigation is not a new document.
      onCreated({}, WINDOW.webContents);
      const devtools = fakeContents();
      onCreated({}, devtools);

      // A live subscription to release.
      const detach = jest.fn();
      client.attach.mockImplementation(
        async (
          _topic: string,
          handlers: { onSnapshot: (value: unknown) => void },
        ) => {
          handlers.onSnapshot({
            generation: 1,
            sequence: 0,
            timestamp: 1,
            data: {},
          });
          return detach;
        },
      );
      await getHandler(ENGINE_IPC.topicSubscribe)(
        {},
        'workspaceRegistry.records.list',
      );

      WINDOW.webContents.fire('did-start-navigation', {
        isMainFrame: true,
        isSameDocument: true,
      });
      devtools.fire('did-start-navigation', {
        isMainFrame: true,
        isSameDocument: false,
      });
      expect(detach).not.toHaveBeenCalled();

      WINDOW.webContents.fire('did-start-navigation', {
        isMainFrame: true,
        isSameDocument: false,
      });
      expect(detach).toHaveBeenCalledTimes(1);
    });

    it('reads the window fresh on every push, not the one open at registration time', () => {
      const supervisor = fakeSupervisor();
      registerEngineIpc(getWindowMock, supervisor);
      const secondWindow = {
        isDestroyed: jest.fn(() => false),
        webContents: { send: jest.fn() },
      } as unknown as BrowserWindow;
      getWindowMock.mockReturnValue(secondWindow);

      supervisor.emit(STOPPED);

      expect(WINDOW.webContents.send).not.toHaveBeenCalled();
      expect(secondWindow.webContents.send).toHaveBeenCalledWith(
        ENGINE_IPC.statusChanged,
        STOPPED,
      );
    });
  });
});
