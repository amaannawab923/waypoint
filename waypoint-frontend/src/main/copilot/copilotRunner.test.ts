import { EventEmitter } from 'events';
import * as os from 'os';
import type { BrowserWindow } from 'electron';

const ipcMainOnMock = jest.fn();
jest.mock('electron', () => ({
  ipcMain: { on: (...args: unknown[]) => ipcMainOnMock(...args) },
}));

type FakeStdin = EventEmitter & {
  writes: string[];
  ended: boolean;
  write: (chunk: string) => boolean;
  end: () => void;
};

function makeFakeStdin(): FakeStdin {
  const emitter = new EventEmitter() as FakeStdin;
  emitter.writes = [];
  emitter.ended = false;
  emitter.write = (chunk: string) => {
    emitter.writes.push(chunk);
    return true;
  };
  emitter.end = () => {
    emitter.ended = true;
  };
  return emitter;
}

type FakeStream = EventEmitter & { setEncoding: jest.Mock };

function makeFakeStream(): FakeStream {
  return Object.assign(new EventEmitter(), { setEncoding: jest.fn() });
}

type FakeChild = EventEmitter & {
  stdin: FakeStdin;
  stdout: FakeStream;
  stderr: FakeStream;
  killed: boolean;
  kill: () => void;
};

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = makeFakeStdin();
  child.stdout = makeFakeStream();
  child.stderr = makeFakeStream();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

let lastChild: FakeChild | null = null;
const spawnCalls: Array<{
  binary: string;
  args: string[];
  options: { cwd?: string; env?: Record<string, string | undefined> };
}> = [];
const spawnMock = jest.fn(
  (
    binary: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string | undefined> },
  ) => {
    lastChild = makeFakeChild();
    spawnCalls.push({ binary, args, options });
    return lastChild;
  },
);
jest.mock('child_process', () => ({
  spawn: (
    ...args: [
      string,
      string[],
      { cwd?: string; env?: Record<string, string | undefined> },
    ]
  ) => spawnMock(...args),
}));

// Same hazard hit (and fixed) in preload.test.ts: copilotRunner.ts's own
// `import { spawn } from 'child_process'` / `import { ipcMain } from
// 'electron'` must run only after the mocks and helpers above exist — an
// import hoisted above them (e.g. by an eslint autofix) would hit the mock
// factories before spawnMock/ipcMainOnMock are initialized, throwing a TDZ
// ReferenceError.
// eslint-disable-next-line import/order, import/first
import { registerCopilotIpc, killAllCopilotProcesses } from './copilotRunner';

function getRegisteredHandler() {
  const call = ipcMainOnMock.mock.calls.find((c) => c[0] === 'copilot:run');
  if (!call) throw new Error('ipcMain.on was never called with "copilot:run"');
  return call[1] as (event: unknown, args: unknown) => void;
}

function run(args: {
  requestId: string;
  prompt: string;
  resumeSessionId?: string;
}): FakeChild {
  getRegisteredHandler()({}, args);
  return lastChild as FakeChild;
}

function fakeWindow() {
  return { isDestroyed: () => false, webContents: { send: jest.fn() } };
}

beforeEach(() => {
  jest.clearAllMocks();
  spawnCalls.length = 0;
  lastChild = null;
});

describe('registerCopilotIpc', () => {
  it('writes the prompt to stdin instead of argv, then closes stdin', () => {
    const win = fakeWindow();
    registerCopilotIpc(() => win as unknown as BrowserWindow);

    const child = run({ requestId: 'req-1', prompt: 'hello there' });

    // Not in argv at all — a prompt starting with `-` (or containing shell
    // metacharacters) must never be interpretable as a CLI flag, and the
    // prompt must not be visible in the OS process table via argv.
    expect(spawnCalls[0].args).not.toContain('hello there');
    expect(child.stdin.writes.join('')).toBe('hello there');
    expect(child.stdin.ended).toBe(true);
  });

  it('passes --resume only when a resumeSessionId is given', () => {
    const win = fakeWindow();
    registerCopilotIpc(() => win as unknown as BrowserWindow);

    run({ requestId: 'req-1', prompt: 'hi' });
    expect(spawnCalls[0].args).not.toContain('--resume');

    run({ requestId: 'req-2', prompt: 'hi', resumeSessionId: 'sess-1' });
    const idx = spawnCalls[1].args.indexOf('--resume');
    expect(idx).toBeGreaterThan(-1);
    expect(spawnCalls[1].args[idx + 1]).toBe('sess-1');
  });

  it('spawns with an isolated cwd and a PATH extended with common install locations', () => {
    const win = fakeWindow();
    registerCopilotIpc(() => win as unknown as BrowserWindow);

    run({ requestId: 'req-1', prompt: 'hi' });

    const { options } = spawnCalls[0];
    expect(options.cwd).toBe(os.tmpdir());
    expect(String(options.env?.PATH)).toContain('/opt/homebrew/bin');
    expect(String(options.env?.PATH)).toContain('/usr/local/bin');
  });

  it('sets utf8 encoding on stdout and stderr, not per-chunk decoding', () => {
    const win = fakeWindow();
    registerCopilotIpc(() => win as unknown as BrowserWindow);

    const child = run({ requestId: 'req-1', prompt: 'hi' });

    // Per-chunk `.toString('utf8')` corrupts a multi-byte character split
    // across two 'data' events; stream-level setEncoding buffers the
    // incomplete tail internally instead.
    expect(child.stdout.setEncoding).toHaveBeenCalledWith('utf8');
    expect(child.stderr.setEncoding).toHaveBeenCalledWith('utf8');
  });

  it('buffers stdout across chunks and only dispatches complete lines', () => {
    const win = fakeWindow();
    registerCopilotIpc(() => win as unknown as BrowserWindow);
    const child = run({ requestId: 'req-1', prompt: 'hi' });

    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hello' },
      },
    });
    child.stdout.emit('data', line.slice(0, 10));
    expect(win.webContents.send).not.toHaveBeenCalled();
    child.stdout.emit('data', `${line.slice(10)}\n`);

    expect(win.webContents.send).toHaveBeenCalledWith('copilot:stream', {
      requestId: 'req-1',
      type: 'chunk',
      text: 'hello',
    });
  });

  it('flushes a final line with no trailing newline instead of dropping it on close', () => {
    const win = fakeWindow();
    registerCopilotIpc(() => win as unknown as BrowserWindow);
    const child = run({ requestId: 'req-1', prompt: 'hi' });

    const resultLine = JSON.stringify({
      type: 'result',
      result: 'the full reply',
      session_id: 'sess-9',
    });
    // No trailing \n — exactly what a real final stdout write looks like.
    child.stdout.emit('data', resultLine);
    expect(win.webContents.send).not.toHaveBeenCalled();

    child.emit('close', 0);

    expect(win.webContents.send).toHaveBeenCalledWith('copilot:stream', {
      requestId: 'req-1',
      type: 'done',
      fullText: 'the full reply',
      sessionId: 'sess-9',
    });
  });

  it('reports the specific ENOENT message and does not let the close handler overwrite it with a generic one', () => {
    const win = fakeWindow();
    registerCopilotIpc(() => win as unknown as BrowserWindow);
    const child = run({ requestId: 'req-1', prompt: 'hi' });

    const enoent = Object.assign(new Error('spawn claude ENOENT'), {
      code: 'ENOENT',
    });
    // Node fires both 'error' and 'close' for a spawn failure like this.
    child.emit('error', enoent);
    child.emit('close', null);

    expect(win.webContents.send).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).toHaveBeenCalledWith('copilot:stream', {
      requestId: 'req-1',
      type: 'error',
      kind: 'binary_not_found',
      message: expect.stringContaining("isn't installed"),
    });
  });

  it('reports a generic close failure, including the stderr tail, when the process exits with no result', () => {
    const win = fakeWindow();
    registerCopilotIpc(() => win as unknown as BrowserWindow);
    const child = run({ requestId: 'req-1', prompt: 'hi' });

    child.stderr.emit('data', 'permission denied\n');
    child.emit('close', 1);

    expect(win.webContents.send).toHaveBeenCalledWith('copilot:stream', {
      requestId: 'req-1',
      type: 'error',
      kind: 'generic',
      message: expect.stringContaining('permission denied'),
    });
  });

  it('reports a result_error (the CLI itself reporting failure) as an error, not a persisted reply', () => {
    const win = fakeWindow();
    registerCopilotIpc(() => win as unknown as BrowserWindow);
    const child = run({ requestId: 'req-1', prompt: 'hi' });

    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'internal failure',
    });
    child.stdout.emit('data', `${line}\n`);

    expect(win.webContents.send).toHaveBeenCalledWith('copilot:stream', {
      requestId: 'req-1',
      type: 'error',
      kind: 'generic',
      message: 'internal failure',
    });
  });

  it('ignores a malformed IPC payload instead of crashing the main process', () => {
    const win = fakeWindow();
    registerCopilotIpc(() => win as unknown as BrowserWindow);
    const handler = getRegisteredHandler();

    expect(() => handler({}, undefined)).not.toThrow();
    expect(() => handler({}, { requestId: 'x', prompt: '' })).not.toThrow();
    expect(() => handler({}, { requestId: '', prompt: 'hi' })).not.toThrow();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not send to a destroyed window', () => {
    const win = { isDestroyed: () => true, webContents: { send: jest.fn() } };
    registerCopilotIpc(() => win as unknown as BrowserWindow);
    const child = run({ requestId: 'req-1', prompt: 'hi' });

    child.emit('close', 1);

    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});

describe('killAllCopilotProcesses', () => {
  it('kills every tracked in-flight process', () => {
    const win = fakeWindow();
    registerCopilotIpc(() => win as unknown as BrowserWindow);
    const child1 = run({ requestId: 'req-1', prompt: 'hi' });
    const child2 = run({ requestId: 'req-2', prompt: 'hi' });

    killAllCopilotProcesses();

    expect(child1.killed).toBe(true);
    expect(child2.killed).toBe(true);
  });

  it('does not re-kill a process that already closed on its own', () => {
    const win = fakeWindow();
    registerCopilotIpc(() => win as unknown as BrowserWindow);
    const child = run({ requestId: 'req-1', prompt: 'hi' });
    child.emit('close', 0);

    killAllCopilotProcesses();

    expect(child.killed).toBe(false);
  });
});
