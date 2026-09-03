import { EventEmitter } from 'events';

const ipcMainHandleMock = jest.fn();
jest.mock('electron', () => ({
  ipcMain: { handle: (...args: unknown[]) => ipcMainHandleMock(...args) },
}));

// Same PATH-augmentation copilotConnect.ts's own tests exercise directly —
// this file only has to prove copilotDetect.ts actually calls through to
// it, not re-verify buildEnv()'s own contents.
const buildEnvMock = jest.fn(() => ({
  PATH: '/opt/homebrew/bin:/usr/bin:/bin',
}));
jest.mock('./copilotConnect', () => ({
  buildEnv: () => buildEnvMock(),
}));

// A minimal fake of the ChildProcess shape the code under test actually
// touches: 'error'/'exit' on the process itself, 'data' on stdout/stderr,
// setEncoding() as a no-op (real streams have it; this fake emits plain
// strings directly, so nothing has to actually decode anything), and a
// spy-able kill(). Plain EventEmitters, not classes, to match the rest of
// this file's factory-function style (see copilotConnect.test.ts's own
// makeFakeChild).
type FakeStream = EventEmitter & { setEncoding: jest.Mock };
type FakeChildProcess = EventEmitter & {
  stdout: FakeStream;
  stderr: FakeStream;
  kill: jest.Mock;
};

function makeFakeStream(): FakeStream {
  return Object.assign(new EventEmitter(), { setEncoding: jest.fn() });
}

function makeFakeChild(): FakeChildProcess {
  return Object.assign(new EventEmitter(), {
    stdout: makeFakeStream(),
    stderr: makeFakeStream(),
    kill: jest.fn(),
  });
}

let lastChild: FakeChildProcess | null = null;
const spawnCalls: Array<{ binary: string; args: string[]; options: unknown }> =
  [];
let spawnImpl: (
  binary: string,
  args: string[],
  options: unknown,
) => FakeChildProcess = (binary, args, options) => {
  lastChild = makeFakeChild();
  spawnCalls.push({ binary, args, options });
  return lastChild;
};
const spawnMock = jest.fn((binary: string, args: string[], options: unknown) =>
  spawnImpl(binary, args, options),
);
jest.mock('child_process', () => ({
  spawn: (...args: [string, string[], unknown]) => spawnMock(...args),
}));

// copilotConnect.test.ts documents the same hazard: copilotDetect.ts's own
// `import { spawn } from 'child_process'` / `import { ipcMain } from
// 'electron'` must run only after the mocks above exist.
// eslint-disable-next-line import/order, import/first
import { detectClaudeCli, registerCopilotDetectIpc } from './copilotDetect';

function getHandler() {
  const call = ipcMainHandleMock.mock.calls.find(
    (c) => c[0] === 'copilot:detect',
  );
  if (!call) {
    throw new Error('ipcMain.handle was never called with "copilot:detect"');
  }
  return call[1] as () => unknown;
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

describe('registerCopilotDetectIpc', () => {
  it('registers a copilot:detect handle backed by detectClaudeCli', async () => {
    registerCopilotDetectIpc();
    const handler = getHandler();

    const promise = handler();
    lastChild?.stdout.emit('data', '1.0.0\n');
    lastChild?.emit('exit', 0);

    await expect(promise).resolves.toEqual({
      ok: true,
      version: '1.0.0',
      path: expect.any(String),
    });
  });
});

describe('detectClaudeCli', () => {
  it('spawns `claude --version` with the augmented PATH', async () => {
    const promise = detectClaudeCli();

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].binary).toBe('claude');
    expect(spawnCalls[0].args).toEqual(['--version']);
    expect(spawnCalls[0].options).toEqual({
      env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin' },
    });
    expect(buildEnvMock).toHaveBeenCalledTimes(1);

    // Settle it before the test ends — an un-settled real 5s setTimeout
    // left dangling here would otherwise leak into whichever test runs
    // next.
    lastChild?.emit('exit', 0);
    await promise;
  });

  it('honors CLAUDE_CLI_PATH for the binary path', async () => {
    process.env.CLAUDE_CLI_PATH = '/custom/claude';
    const promise = detectClaudeCli();

    expect(spawnCalls[0].binary).toBe('/custom/claude');

    lastChild?.emit('exit', 0);
    await promise;
  });

  it('resolves `present` with the version parsed from real stdout', async () => {
    const promise = detectClaudeCli();
    lastChild?.stdout.emit('data', '1.2.3 (Claude Code)\n');
    lastChild?.emit('exit', 0);

    await expect(promise).resolves.toEqual({
      ok: true,
      version: '1.2.3',
      path: expect.any(String),
    });
  });

  it('reports `absent` on a clean ENOENT — the binary genuinely is not on PATH', async () => {
    const promise = detectClaudeCli();
    lastChild?.emit(
      'error',
      Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }),
    );

    await expect(promise).resolves.toEqual({
      ok: false,
      reason: 'not-found',
      message: expect.stringContaining('not found on PATH'),
    });
  });

  it('reports `error` (not `not-found`) for a non-ENOENT spawn error', async () => {
    const promise = detectClaudeCli();
    lastChild?.emit(
      'error',
      Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    );

    await expect(promise).resolves.toEqual({
      ok: false,
      reason: 'error',
      message: 'permission denied',
    });
  });

  it('reports `error` when the process exits non-zero', async () => {
    const promise = detectClaudeCli();
    lastChild?.stderr.emit('data', 'unexpected failure');
    lastChild?.emit('exit', 1);

    await expect(promise).resolves.toEqual({
      ok: false,
      reason: 'error',
      message: 'unexpected failure',
    });
  });

  it("reports `error` when the exit is clean but the output doesn't parse", async () => {
    const promise = detectClaudeCli();
    lastChild?.stdout.emit('data', 'not a version string');
    lastChild?.emit('exit', 0);

    await expect(promise).resolves.toEqual({
      ok: false,
      reason: 'error',
      message: expect.stringContaining("Couldn't parse a version"),
    });
  });

  it('reports `error` and kills the process if it runs past the timeout', async () => {
    jest.useFakeTimers();
    try {
      const promise = detectClaudeCli();
      await jest.advanceTimersByTimeAsync(5_000);

      await expect(promise).resolves.toEqual({
        ok: false,
        reason: 'error',
        message: expect.stringContaining('Timed out'),
      });
      expect(lastChild?.kill).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports `error` when spawn itself throws synchronously', async () => {
    spawnImpl = () => {
      throw new Error('spawn claude EACCES');
    };

    await expect(detectClaudeCli()).resolves.toEqual({
      ok: false,
      reason: 'error',
      message: 'spawn claude EACCES',
    });
  });

  // A late 'exit' after 'error' already settled (or vice versa) must not
  // resolve twice / throw on a second `resolve()` call.
  it('ignores a second terminal event after the first has already settled', async () => {
    const promise = detectClaudeCli();
    lastChild?.stdout.emit('data', '1.0.0\n');
    lastChild?.emit('exit', 0);
    lastChild?.emit('exit', 1);
    lastChild?.emit(
      'error',
      Object.assign(new Error('late'), { code: 'ENOENT' }),
    );

    await expect(promise).resolves.toEqual({
      ok: true,
      version: '1.0.0',
      path: expect.any(String),
    });
  });
});
