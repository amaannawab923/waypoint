import { EventEmitter } from 'events';
import * as path from 'path';

// The real package is pure ESM and is never loaded by any test — this factory
// stands in for it wholesale, which is the entire reason claudeSdkClient.ts
// exists as a separate module (see its own header comment).
const queryMock = jest.fn(() => ({ fake: 'query' }));
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...(args as [])),
}));

type FakeStderr = EventEmitter & { setEncoding: jest.Mock };

type FakeChild = EventEmitter & {
  stdin: EventEmitter;
  stdout: EventEmitter;
  stderr: FakeStderr;
  killed: boolean;
  exitCode: number | null;
  signalCode: string | null;
  kill: jest.Mock;
};

const spawnCalls: Array<{
  command: string;
  args: string[];
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
  };
}> = [];
let lastChild: FakeChild | null = null;
const spawnMock = jest.fn(
  (
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      signal?: AbortSignal;
    },
  ) => {
    const child = new EventEmitter() as FakeChild;
    child.stdin = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = Object.assign(new EventEmitter(), {
      setEncoding: jest.fn(),
    });
    child.killed = false;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = jest.fn(() => true);
    lastChild = child;
    spawnCalls.push({ command, args, options });
    return child;
  },
);
jest.mock('child_process', () => ({
  spawn: (
    ...args: [
      string,
      string[],
      {
        cwd?: string;
        env?: Record<string, string | undefined>;
        signal?: AbortSignal;
      },
    ]
  ) => spawnMock(...args),
}));

// Same hazard documented in copilotRunner.test.ts/preload.test.ts: this
// file's own imports must run only after the mocks above exist.
// eslint-disable-next-line import/order, import/first
import { runCopilotQuery } from './claudeSdkClient';

type SpawnOverride = (spawnOptions: {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
}) => unknown;

function capturedSpawnOverride(): SpawnOverride {
  const call = queryMock.mock.calls[0] as unknown as [
    { options: { spawnClaudeCodeProcess: SpawnOverride } },
  ];
  return call[0].options.spawnClaudeCodeProcess;
}

beforeEach(() => {
  jest.clearAllMocks();
  spawnCalls.length = 0;
  lastChild = null;
});

describe('runCopilotQuery', () => {
  it('forwards the prompt and the caller options to the SDK unchanged', async () => {
    await runCopilotQuery({
      prompt: 'hello there',
      options: { tools: [], settingSources: [], cwd: '/tmp' },
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [params] = queryMock.mock.calls[0] as unknown as [
      { prompt: string; options: Record<string, unknown> },
    ];
    expect(params.prompt).toBe('hello there');
    expect(params.options).toEqual(
      expect.objectContaining({
        tools: [],
        settingSources: [],
        cwd: '/tmp',
      }),
    );
  });

  // The one behavior this module exists to add. Without it a packaged build
  // fails with `spawn ENOTDIR`: app.asar is a single file to every raw
  // execve, and the SDK resolves its vendored binary to a path running
  // straight through it, with no idea this app unpacks anything.
  it('translates an app.asar command path to its app.asar.unpacked sibling before spawning', async () => {
    await runCopilotQuery({ prompt: 'hi', options: {} });

    const asarPath = path.join(
      '/Applications/ElectronReact.app/Contents/Resources/app.asar',
      'node_modules/@anthropic-ai/claude-agent-sdk/node_modules',
      '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
    );
    capturedSpawnOverride()({
      command: asarPath,
      args: ['--flag'],
      cwd: '/work',
      env: { PATH: '/usr/bin' },
    });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe(
      asarPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`),
    );
    expect(spawnCalls[0].command).not.toContain(`app.asar${path.sep}node_`);
    expect(spawnCalls[0].args).toEqual(['--flag']);
    expect(spawnCalls[0].options).toEqual({
      cwd: '/work',
      env: { PATH: '/usr/bin' },
    });
  });

  // Dev mode (and any unpackaged run) resolves a perfectly ordinary path —
  // rewriting it would break the very case that already worked.
  it('leaves a command path with no .asar segment untouched', async () => {
    await runCopilotQuery({ prompt: 'hi', options: {} });

    const plainPath = path.join('/repo/node_modules/.bin', 'claude');
    capturedSpawnOverride()({
      command: plainPath,
      args: [],
      env: {},
    });

    expect(spawnCalls[0].command).toBe(plainPath);
  });

  // '.asar' in TRAILING position (a filename, not a path segment being
  // traversed into) is never rewritten — there's no `.asar/` separator for
  // `includes` to match.
  it('leaves a path ending in a bare .asar filename untouched', async () => {
    await runCopilotQuery({ prompt: 'hi', options: {} });

    const notAnArchive = path.join('/repo/build', 'notes.asar');
    capturedSpawnOverride()({ command: notAnArchive, args: [], env: {} });

    expect(spawnCalls[0].command).toBe(notAnArchive);
  });

  // The actual boundary case: '.asar' as a MIDDLE segment that isn't really
  // an archive. unpackAsarPath has no way to distinguish this from a real
  // packaged app's path — it rewrites it too. Documenting this as accepted
  // behavior (vanishingly unlikely path shape in practice, and the rewrite
  // is harmless — .asar.unpacked/ itself never contains another .asar/, so
  // it can't cascade), not asserting protection that doesn't exist.
  it('also rewrites a middle path segment literally named .asar, even when not a real archive', async () => {
    await runCopilotQuery({ prompt: 'hi', options: {} });

    const lookalike = path.join('/repo/my.asar', 'bin/claude');
    capturedSpawnOverride()({ command: lookalike, args: [], env: {} });

    expect(spawnCalls[0].command).toBe(
      path.join('/repo/my.asar.unpacked', 'bin/claude'),
    );
  });

  it('returns a SpawnedProcess-shaped adapter backed by the real child', async () => {
    await runCopilotQuery({ prompt: 'hi', options: {} });

    const spawned = capturedSpawnOverride()({
      command: '/bin/claude',
      args: [],
      env: {},
    }) as {
      stdin: unknown;
      stdout: unknown;
      killed: boolean;
      exitCode: number | null;
      kill: (signal: string) => boolean;
      on: (event: string, listener: () => void) => unknown;
    };
    const child = lastChild as FakeChild;

    expect(spawned.stdin).toBe(child.stdin);
    expect(spawned.stdout).toBe(child.stdout);
    // Live getters, not a snapshot taken at adapter-construction time — the
    // SDK reads these after the process has already moved on.
    expect(spawned.killed).toBe(false);
    child.killed = true;
    child.exitCode = 3;
    expect(spawned.killed).toBe(true);
    expect(spawned.exitCode).toBe(3);

    expect(spawned.kill('SIGTERM')).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    const listener = jest.fn();
    spawned.on('exit', listener);
    child.emit('exit');
    expect(listener).toHaveBeenCalled();
  });

  it('calls query() once per runCopilotQuery invocation', async () => {
    await runCopilotQuery({ prompt: 'one', options: {} });
    await runCopilotQuery({ prompt: 'two', options: {} });

    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  // The one thing a custom spawnClaudeCodeProcess is responsible for that
  // the SDK's own built-in local spawn would otherwise handle: consuming
  // child.stderr. Left unread, the OS pipe buffer eventually fills and the
  // child blocks in write(2) forever — a silent, unrecoverable hang with no
  // terminal IPC event. options.stderr is the caller's existing diagnostic
  // sink (copilotRunner.ts's stderrTail); it must actually receive data, not
  // just be accepted and ignored.
  it('forwards data written to the spawned process stderr to options.stderr', async () => {
    const onStderr = jest.fn();
    await runCopilotQuery({ prompt: 'hi', options: { stderr: onStderr } });

    capturedSpawnOverride()({ command: '/bin/claude', args: [], env: {} });
    const child = lastChild as FakeChild;

    expect(child.stderr.setEncoding).toHaveBeenCalledWith('utf8');
    child.stderr.emit('data', 'permission denied\n');
    child.stderr.emit('data', 'retrying...\n');

    expect(onStderr).toHaveBeenNthCalledWith(1, 'permission denied\n');
    expect(onStderr).toHaveBeenNthCalledWith(2, 'retrying...\n');
  });

  // A stream-level error (e.g. EPIPE on a process that exits abruptly) must
  // not throw or become an unhandled 'error' event — process failure is
  // already reported through the child's own 'error'/'exit', which
  // toSpawnedProcess forwards separately.
  it('does not throw when the stderr stream itself errors', async () => {
    await runCopilotQuery({ prompt: 'hi', options: {} });

    capturedSpawnOverride()({ command: '/bin/claude', args: [], env: {} });
    const child = lastChild as FakeChild;

    expect(() => child.stderr.emit('error', new Error('EPIPE'))).not.toThrow();
  });
});
