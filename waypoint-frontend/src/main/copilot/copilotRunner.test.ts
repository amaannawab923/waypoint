import { EventEmitter } from 'events';
import * as os from 'os';
import type { BrowserWindow } from 'electron';

const ipcMainOnMock = jest.fn();
jest.mock('electron', () => ({
  ipcMain: { on: (...args: unknown[]) => ipcMainOnMock(...args) },
}));

// Defaults to "no token connected" (null) so every existing test below keeps
// exercising the ambient-CLI-login path unchanged; individual tests override
// this to cover the connected-subscription-token path.
const getStoredSubscriptionTokenMock = jest.fn<string | null, []>(() => null);
jest.mock('./copilotAuth', () => ({
  getStoredSubscriptionToken: () => getStoredSubscriptionTokenMock(),
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

  it('passes --resume only when a UUID-shaped resumeSessionId is given', () => {
    const win = fakeWindow();
    registerCopilotIpc(() => win as unknown as BrowserWindow);

    run({ requestId: 'req-1', prompt: 'hi' });
    expect(spawnCalls[0].args).not.toContain('--resume');

    run({
      requestId: 'req-2',
      prompt: 'hi',
      resumeSessionId: '6b16ad5b-1e3f-4a2c-8f9d-2c7e5a9b3d10',
    });
    const idx = spawnCalls[1].args.indexOf('--resume');
    expect(idx).toBeGreaterThan(-1);
    expect(spawnCalls[1].args[idx + 1]).toBe(
      '6b16ad5b-1e3f-4a2c-8f9d-2c7e5a9b3d10',
    );
  });

  // Defense in depth: the backend's own zod schema already requires a UUID,
  // but --resume takes an *optional* value, so a flag-shaped resumeSessionId
  // (e.g. one starting with `-`) isn't consumed as --resume's argument —
  // it's parsed as a separate flag of its own (confirmed live against the
  // real CLI: `claude -p --resume --help` prints help instead of erring).
  // This must never reach argv regardless of what validated the value on
  // its way into the database, including anything written before the
  // schema was tightened.
  it('does not pass a non-UUID resumeSessionId to argv, even a flag-shaped one', () => {
    const win = fakeWindow();
    registerCopilotIpc(() => win as unknown as BrowserWindow);

    run({
      requestId: 'req-1',
      prompt: 'hi',
      resumeSessionId: '--dangerously-skip-permissions',
    });

    expect(spawnCalls[0].args).not.toContain('--resume');
    expect(spawnCalls[0].args).not.toContain('--dangerously-skip-permissions');
  });

  it('disables built-in tool access — this phase is text-only chat, not agentic', () => {
    const win = fakeWindow();
    registerCopilotIpc(() => win as unknown as BrowserWindow);

    run({ requestId: 'req-1', prompt: 'hi' });

    const idx = spawnCalls[0].args.indexOf('--tools');
    expect(idx).toBeGreaterThan(-1);
    expect(spawnCalls[0].args[idx + 1]).toBe('');
  });

  // The bug this exists to catch: a --resume against a session id that's
  // aged out of Claude Code's retention window failed identically on every
  // retry, with no code path anywhere that ever cleared the stored id —
  // permanently bricking the conversation.
  it('retries once without --resume when a stale session id causes a result_error, transparently', () => {
    const win = fakeWindow();
    registerCopilotIpc(() => win as unknown as BrowserWindow);
    const firstChild = run({
      requestId: 'req-1',
      prompt: 'hi',
      resumeSessionId: '6b16ad5b-1e3f-4a2c-8f9d-2c7e5a9b3d10',
    });
    expect(spawnCalls).toHaveLength(1);

    // The real shape a stale --resume produces (verified live): no `result`
    // field, only `errors`.
    const staleLine = JSON.stringify({
      type: 'result',
      is_error: true,
      session_id: '6b16ad5b-1e3f-4a2c-8f9d-2c7e5a9b3d10',
      errors: [
        'No conversation found with session ID: 6b16ad5b-1e3f-4a2c-8f9d-2c7e5a9b3d10',
      ],
    });
    firstChild.stdout.emit('data', `${staleLine}\n`);

    // A second, fresh attempt spawned — without --resume — and nothing was
    // reported to the renderer yet; the retry is meant to be invisible.
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1].args).not.toContain('--resume');
    expect(win.webContents.send).not.toHaveBeenCalled();

    const retryChild = lastChild as FakeChild;
    const successLine = JSON.stringify({
      type: 'result',
      result: 'fresh reply',
      session_id: 'fresh-session-id',
    });
    retryChild.stdout.emit('data', `${successLine}\n`);

    expect(win.webContents.send).toHaveBeenCalledWith('copilot:stream', {
      requestId: 'req-1',
      type: 'done',
      fullText: 'fresh reply',
      sessionId: 'fresh-session-id',
    });

    // The first (abandoned) child closing afterward must not clobber the
    // retry's tracked entry, nor produce a second/duplicate terminal
    // message the renderer would have to reconcile against the first.
    firstChild.emit('close', 1);
    expect(win.webContents.send).toHaveBeenCalledTimes(1);
  });

  it('does not retry a stale-session result_error that itself came from a retry (bounded to one retry)', () => {
    const win = fakeWindow();
    registerCopilotIpc(() => win as unknown as BrowserWindow);
    const firstChild = run({
      requestId: 'req-1',
      prompt: 'hi',
      resumeSessionId: '6b16ad5b-1e3f-4a2c-8f9d-2c7e5a9b3d10',
    });

    const staleLine = JSON.stringify({
      type: 'result',
      is_error: true,
      errors: ['No conversation found with session ID: whatever'],
    });
    firstChild.stdout.emit('data', `${staleLine}\n`);
    expect(spawnCalls).toHaveLength(2);

    // The retry attempt (which used no --resume) somehow still reports the
    // same stale-session-shaped message — pathological, but must not loop.
    const retryChild = lastChild as FakeChild;
    retryChild.stdout.emit('data', `${staleLine}\n`);

    expect(spawnCalls).toHaveLength(2);
    expect(win.webContents.send).toHaveBeenCalledWith('copilot:stream', {
      requestId: 'req-1',
      type: 'error',
      kind: 'generic',
      message: 'No conversation found with session ID: whatever',
    });
  });

  it('does not retry a result_error whose message does not match the stale-session pattern', () => {
    const win = fakeWindow();
    registerCopilotIpc(() => win as unknown as BrowserWindow);
    const child = run({
      requestId: 'req-1',
      prompt: 'hi',
      resumeSessionId: '6b16ad5b-1e3f-4a2c-8f9d-2c7e5a9b3d10',
    });

    const line = JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'some unrelated failure',
    });
    child.stdout.emit('data', `${line}\n`);

    expect(spawnCalls).toHaveLength(1);
    expect(win.webContents.send).toHaveBeenCalledWith('copilot:stream', {
      requestId: 'req-1',
      type: 'error',
      kind: 'generic',
      message: 'some unrelated failure',
    });
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

  it('does not set CLAUDE_CODE_OAUTH_TOKEN when no subscription token is connected', () => {
    const win = fakeWindow();
    registerCopilotIpc(() => win as unknown as BrowserWindow);

    run({ requestId: 'req-1', prompt: 'hi' });

    expect(spawnCalls[0].options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  // Settings → Profile → Copilot lets a user connect their own subscription
  // via a token generated with `claude setup-token`, so an expired/missing
  // ambient CLI login no longer dead-ends every run.
  it('passes a connected subscription token as CLAUDE_CODE_OAUTH_TOKEN, taking priority over ambient login', () => {
    getStoredSubscriptionTokenMock.mockReturnValue(
      'sk-ant-oat01-connected-token',
    );
    const win = fakeWindow();
    registerCopilotIpc(() => win as unknown as BrowserWindow);

    run({ requestId: 'req-1', prompt: 'hi' });

    expect(spawnCalls[0].options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      'sk-ant-oat01-connected-token',
    );
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
