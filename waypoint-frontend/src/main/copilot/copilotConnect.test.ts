import * as os from 'os';
import type { BrowserWindow } from 'electron';

const ipcMainOnMock = jest.fn();
const ipcMainHandleMock = jest.fn();
const shellOpenExternalMock = jest.fn();
jest.mock('electron', () => ({
  ipcMain: {
    on: (...args: unknown[]) => ipcMainOnMock(...args),
    handle: (...args: unknown[]) => ipcMainHandleMock(...args),
  },
  shell: {
    openExternal: (...args: unknown[]) => shellOpenExternalMock(...args),
  },
}));

// node-pty's IPty registers a single handler via onData/onExit, not an
// EventEmitter — emitData/emitExit below drive those captured callbacks
// directly instead of exposing the registration methods to callers.
type FakeChild = {
  onData: (cb: (chunk: string) => void) => void;
  onExit: (cb: (e: { exitCode: number | null }) => void) => void;
  kill: jest.Mock;
  emitData: (chunk: string) => void;
  emitExit: (exitCode: number | null) => void;
};

function makeFakeChild(): FakeChild {
  let dataCb: ((chunk: string) => void) | null = null;
  let exitCb: ((e: { exitCode: number | null }) => void) | null = null;
  return {
    onData: (cb) => {
      dataCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    kill: jest.fn(),
    emitData: (chunk) => dataCb?.(chunk),
    emitExit: (exitCode) => exitCb?.({ exitCode }),
  };
}

let lastChild: FakeChild | null = null;
const spawnCalls: Array<{
  binary: string;
  args: string[];
  options: { cwd?: string; env?: Record<string, string> };
}> = [];
let spawnImpl: (
  binary: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> },
) => FakeChild = (binary, args, options) => {
  lastChild = makeFakeChild();
  spawnCalls.push({ binary, args, options });
  return lastChild;
};
const spawnMock = jest.fn(
  (
    binary: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string> },
  ) => spawnImpl(binary, args, options),
);
jest.mock('node-pty', () => ({
  spawn: (...args: [string, string[], Record<string, unknown>]) =>
    spawnMock(...args),
}));

// Same hazard documented in copilotRunner.test.ts: copilotConnect.ts's own
// `import * as pty from 'node-pty'` / `import { ipcMain, shell } from
// 'electron'` must run only after the mocks and helpers above exist.
// eslint-disable-next-line import/order, import/first
import {
  registerCopilotConnectIpc,
  killAllCopilotConnectProcesses,
} from './copilotConnect';

function getHandler(channel: string) {
  const call = ipcMainOnMock.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`ipcMain.on was never called with "${channel}"`);
  return call[1] as (event: unknown, args: unknown) => void;
}

function getOpenExternalHandler() {
  const call = ipcMainHandleMock.mock.calls.find(
    (c) => c[0] === 'copilot:auth:open-external',
  );
  if (!call) {
    throw new Error(
      'ipcMain.handle was never called with "copilot:auth:open-external"',
    );
  }
  return call[1] as (event: unknown, url: unknown) => unknown;
}

function fakeWindow() {
  return { isDestroyed: () => false, webContents: { send: jest.fn() } };
}

function start(
  win: ReturnType<typeof fakeWindow>,
  requestId = 'req-1',
): FakeChild {
  registerCopilotConnectIpc(() => win as unknown as BrowserWindow);
  getHandler('copilot:auth:connect:start')({}, { requestId });
  return lastChild as FakeChild;
}

beforeEach(() => {
  jest.clearAllMocks();
  spawnCalls.length = 0;
  lastChild = null;
  delete process.env.CLAUDE_CLI_PATH;
  spawnImpl = (binary, args, options) => {
    lastChild = makeFakeChild();
    spawnCalls.push({ binary, args, options });
    return lastChild;
  };
});

describe('registerCopilotConnectIpc', () => {
  it('spawns `claude setup-token` in a real PTY', () => {
    const win = fakeWindow();
    start(win);

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].binary).toBe('claude');
    expect(spawnCalls[0].args).toEqual(['setup-token']);
  });

  it('honors CLAUDE_CLI_PATH for the binary path', () => {
    process.env.CLAUDE_CLI_PATH = '/custom/claude';
    const win = fakeWindow();
    start(win);

    expect(spawnCalls[0].binary).toBe('/custom/claude');
  });

  it('runs from the OS tmpdir with PATH extended with common install locations', () => {
    const win = fakeWindow();
    start(win);

    const { options } = spawnCalls[0];
    expect(options.cwd).toBe(os.tmpdir());
    expect(String(options.env?.PATH)).toContain('/opt/homebrew/bin');
    expect(String(options.env?.PATH)).toContain('/usr/local/bin');
  });

  it('streams each PTY data chunk to the renderer, tagged with the request id', () => {
    const win = fakeWindow();
    const child = start(win);

    child.emitData('some output');

    expect(win.webContents.send).toHaveBeenCalledWith(
      'copilot:auth:connect:data',
      { requestId: 'req-1', chunk: 'some output' },
    );
  });

  it('reports process exit with its code, tagged with the request id', () => {
    const win = fakeWindow();
    const child = start(win);

    child.emitExit(0);

    expect(win.webContents.send).toHaveBeenCalledWith(
      'copilot:auth:connect:exit',
      { requestId: 'req-1', code: 0 },
    );
  });

  it('reports a spawn failure as an exit with spawnError, without tracking a process', () => {
    spawnImpl = () => {
      throw new Error('spawn claude ENOENT');
    };
    const win = fakeWindow();
    start(win);

    expect(win.webContents.send).toHaveBeenCalledWith(
      'copilot:auth:connect:exit',
      { requestId: 'req-1', code: null, spawnError: 'spawn claude ENOENT' },
    );

    // Nothing to kill — the failed spawn was never added to the in-flight
    // map, so this must be a no-op rather than throwing on a stale entry.
    expect(() => killAllCopilotConnectProcesses()).not.toThrow();
  });

  it('ignores a malformed start payload instead of crashing the main process', () => {
    const win = fakeWindow();
    registerCopilotConnectIpc(() => win as unknown as BrowserWindow);
    const handler = getHandler('copilot:auth:connect:start');

    expect(() => handler({}, undefined)).not.toThrow();
    expect(() => handler({}, { requestId: '' })).not.toThrow();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('cancel kills and untracks the in-flight process for that request id', () => {
    const win = fakeWindow();
    const child = start(win);

    getHandler('copilot:auth:connect:cancel')({}, { requestId: 'req-1' });
    expect(child.kill).toHaveBeenCalledTimes(1);

    // Already untracked — killing everything afterward must not re-kill it.
    killAllCopilotConnectProcesses();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('cancelling an unknown request id is a no-op', () => {
    const win = fakeWindow();
    registerCopilotConnectIpc(() => win as unknown as BrowserWindow);

    expect(() =>
      getHandler('copilot:auth:connect:cancel')({}, { requestId: 'nope' }),
    ).not.toThrow();
  });

  it('does not send to a destroyed window', () => {
    const win = { isDestroyed: () => true, webContents: { send: jest.fn() } };
    const child = start(win);

    child.emitData('x');

    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});

describe('copilot:auth:open-external', () => {
  it('opens a real claude.com OAuth URL', () => {
    const win = fakeWindow();
    registerCopilotConnectIpc(() => win as unknown as BrowserWindow);
    const handler = getOpenExternalHandler();

    const result = handler(
      {},
      'https://claude.com/cai/oauth/authorize?code=abc',
    );

    expect(result).toEqual({ ok: true });
    expect(shellOpenExternalMock).toHaveBeenCalledWith(
      'https://claude.com/cai/oauth/authorize?code=abc',
    );
  });

  it('opens a real console.anthropic.com URL', () => {
    const win = fakeWindow();
    registerCopilotConnectIpc(() => win as unknown as BrowserWindow);
    const handler = getOpenExternalHandler();

    const result = handler({}, 'https://console.anthropic.com/some/path');

    expect(result).toEqual({ ok: true });
    expect(shellOpenExternalMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a non-https URL', () => {
    const win = fakeWindow();
    registerCopilotConnectIpc(() => win as unknown as BrowserWindow);
    const handler = getOpenExternalHandler();

    const result = handler(
      {},
      'http://claude.com/cai/oauth/authorize?code=abc',
    );

    expect(result).toEqual({ ok: false });
    expect(shellOpenExternalMock).not.toHaveBeenCalled();
  });

  // The whole point of this being a narrowly-scoped opener rather than a
  // general "open any URL" bridge — it must never become an open redirect
  // for whatever else might call it.
  it('refuses a URL on an unrelated host', () => {
    const win = fakeWindow();
    registerCopilotConnectIpc(() => win as unknown as BrowserWindow);
    const handler = getOpenExternalHandler();

    const result = handler({}, 'https://evil.example.com/phish');

    expect(result).toEqual({ ok: false });
    expect(shellOpenExternalMock).not.toHaveBeenCalled();
  });

  it('refuses a malformed URL string instead of throwing', () => {
    const win = fakeWindow();
    registerCopilotConnectIpc(() => win as unknown as BrowserWindow);
    const handler = getOpenExternalHandler();

    expect(() => handler({}, 'not a url')).not.toThrow();
    expect(handler({}, 'not a url')).toEqual({ ok: false });
  });

  it('refuses a non-string payload', () => {
    const win = fakeWindow();
    registerCopilotConnectIpc(() => win as unknown as BrowserWindow);
    const handler = getOpenExternalHandler();

    expect(handler({}, 12345)).toEqual({ ok: false });
    expect(shellOpenExternalMock).not.toHaveBeenCalled();
  });
});

describe('killAllCopilotConnectProcesses', () => {
  it('kills every tracked in-flight process', () => {
    const win = fakeWindow();
    const child1 = start(win, 'req-1');
    getHandler('copilot:auth:connect:start')({}, { requestId: 'req-2' });
    const child2 = lastChild as FakeChild;

    killAllCopilotConnectProcesses();

    expect(child1.kill).toHaveBeenCalledTimes(1);
    expect(child2.kill).toHaveBeenCalledTimes(1);
  });

  it('does not re-kill a process that already exited on its own', () => {
    const win = fakeWindow();
    const child = start(win);
    child.emitExit(0);

    killAllCopilotConnectProcesses();

    expect(child.kill).not.toHaveBeenCalled();
  });
});
